import { describe, expect, it } from "vite-plus/test";
import { isKnownErrorReason, type ConsoleEvent } from "./console-event.ts";
import { parseConsoleLine, type ParsedConsoleLine } from "./console-line-parser.ts";
import { NODE_SESSION_LOG, splitFixtureLines } from "$lib/testing/console-fixtures.ts";
import { ManualTimeSource } from "$lib/testing/manual-time-source.ts";
import { createSimulatedPair } from "$lib/testing/simulated-node.ts";
import firmwareConsoleLines from "../../../../firmware/protocol/test-vectors/firmware-console-lines.jsonl?raw";
import signedImageVector from "../../../../firmware/protocol/test-vectors/signed-image.json";

function eventsOf(lines: readonly ParsedConsoleLine[]): ConsoleEvent[] {
  return lines.flatMap((line) => (line.kind === "event" ? [line.event] : []));
}

function eventOf(line: string): ConsoleEvent {
  const parsed = parseConsoleLine(line);
  if (parsed.kind !== "event") {
    throw new Error(
      `not an event: ${line} (${parsed.kind === "unrecognized" ? parsed.problem : "debug"})`,
    );
  }
  return parsed.event;
}

function problemOf(line: string): string {
  const parsed = parseConsoleLine(line);
  if (parsed.kind !== "unrecognized") {
    throw new Error(`not an unrecognized object: ${line} (${parsed.kind})`);
  }
  return parsed.problem;
}

/** The lines the firmware writes in its host tests (firmware/tests/run_host_tests.sh). */
const FIRMWARE_LINES = firmwareConsoleLines.split("\n").filter((line) => line !== "");

function firmwareLine(predicate: (object: Record<string, unknown>) => boolean): string {
  const line = FIRMWARE_LINES.find((candidate) =>
    predicate(JSON.parse(candidate) as Record<string, unknown>),
  );
  if (line === undefined) {
    throw new Error("no such firmware line");
  }
  return line;
}

describe("parseConsoleLine with the lines of the firmware", () => {
  it("keeps the wire field names and values", () => {
    for (const line of FIRMWARE_LINES) {
      expect(eventOf(line)).toEqual(JSON.parse(line));
    }
    expect(eventOf(firmwareLine((object) => object.ev === "boot"))).toEqual({
      t: 12,
      ev: "boot",
      id: "3A7F",
      model: "V2",
      epoch: 3,
      firmware: "0.2.0",
      protocol: 2,
      key: "default",
      operator_key: "default",
    });
  });

  it("reads the null LNA of the V2", () => {
    const radio = eventOf(firmwareLine((object) => object.ev === "radio" && object.lna === null));
    expect(radio).toMatchObject({ lna: null, power: 4, chip: 4 });
  });

  it("reads the neighbors reported in a HELLO", () => {
    const hello = eventOf(
      firmwareLine(
        (object) =>
          object.ev === "hello" && Array.isArray(object.neighbors) && object.neighbors.length > 1,
      ),
    );
    expect(hello.ev === "hello" ? hello.neighbors : null).toEqual([
      { id: "1A2B", rssi: -70, snr: 6.25 },
      { id: "00F4", rssi: -101, snr: -3.5 },
    ]);
  });

  it("reads the transfer fields", () => {
    expect(eventOf(firmwareLine((object) => object.ev === "report_sent"))).toEqual({
      t: 40,
      ev: "report_sent",
      dst: "3A7F",
      version: 1762300800,
      size: 32,
      count: 4,
      missing: [2],
      round: 1,
    });
    expect(
      eventOf(firmwareLine((object) => object.ev === "tx" && object.type === "report")),
    ).toMatchObject({ dst: "3A7F", version: 1762300800 });
    expect(
      eventOf(firmwareLine((object) => object.ev === "image" && object.via === "radio")),
    ).toMatchObject({ src: "3A7F", reports: 1 });
  });
});

describe("parseConsoleLine with whole sessions", () => {
  it("separates events, unrecognized objects and debug text", () => {
    const lines = splitFixtureLines(NODE_SESSION_LOG).map(parseConsoleLine);
    const kinds = lines.map((line) => line.kind);
    expect(kinds.filter((kind) => kind === "event")).toHaveLength(28);
    expect(kinds.filter((kind) => kind === "unrecognized")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "debug")).toHaveLength(16);
  });

  it("reads every line of an update between simulated nodes as an event or as debug text", async () => {
    const clock = new ManualTimeSource(0);
    const { sender, receiver } = createSimulatedPair(
      clock,
      {},
      {
        losesFragment: (_version, index, delivery) => index === 1 && delivery === 1,
      },
    );
    await sender.sendCommand("fragment_size 32");
    await sender.sendCommand(`load_image ${signedImageVector.image}`);
    await sender.sendCommand(`activate ${signedImageVector.version}`);
    await sender.settle();
    expect(receiver.versions.active).toBe(signedImageVector.version);
    const lines = [...sender.emittedLines, ...receiver.emittedLines].map(parseConsoleLine);
    expect(lines.filter((line) => line.kind === "unrecognized")).toEqual([]);
    expect(new Set(eventsOf(lines).map((event) => event.ev))).toEqual(
      new Set([
        "tx",
        "hello",
        "image",
        "burst_start",
        "burst_done",
        "fragment_rx",
        "report_sent",
        "report_received",
        "transfer",
        "activation",
        "vm",
        "vm_print",
      ]),
    );
  });
});

describe("parseConsoleLine with contract version 2", () => {
  it("requires version and index in a fragment transmission", () => {
    expect(
      problemOf(
        '{"t":1,"ev":"tx","type":"fragment","dst":"FFFF","seq":1,"size":56,"toa":1,"toa_calc":1,"version":5}',
      ),
    ).toContain("fragment");
    expect(
      problemOf(
        '{"t":1,"ev":"tx","type":"report","dst":"5C21","seq":1,"size":23,"toa":1,"toa_calc":1}',
      ),
    ).toContain("report");
  });

  it("accepts the fault reasons and null in the VM fields of a HELLO", () => {
    const hello = eventOf(
      '{"t":1,"ev":"hello","src":"5C21","epoch":7,"seq":3,"model":"V2","version":4,"available":5,"vm_fault":"division_by_zero","vm_failing":true,"tx":3,"rssi":-47.5,"snr":9.75,"ferr":-1220,"neighbors":[]}',
    );
    expect(hello).toMatchObject({ vm_fault: "division_by_zero", vm_failing: true });
    expect(
      problemOf(
        '{"t":1,"ev":"hello","src":"5C21","epoch":7,"seq":3,"model":"V2","version":4,"available":5,"vm_fault":"meltdown","vm_failing":true,"tx":3,"rssi":-47.5,"snr":9.75,"ferr":-1220,"neighbors":[]}',
      ),
    ).toContain("vm_fault");
  });

  it("refuses program code that is not lowercase hexadecimal", () => {
    expect(eventOf('{"t":1,"ev":"program","version":0,"size":0,"code":""}')).toMatchObject({
      code: "",
    });
    expect(problemOf('{"t":1,"ev":"program","version":3,"size":1,"code":"0A"}')).toContain("code");
  });
});

describe("parseConsoleLine", () => {
  it("takes any line that does not start with { as debug text", () => {
    expect(parseConsoleLine("boot 3A7F V4.3 e12")).toEqual({
      kind: "debug",
      text: "boot 3A7F V4.3 e12",
    });
    expect(parseConsoleLine(' {"t":1,"ev":"boot"}').kind).toBe("debug");
    expect(parseConsoleLine("")).toEqual({ kind: "debug", text: "" });
  });

  it("takes malformed JSON as debug text", () => {
    expect(parseConsoleLine('{"t":28700,"ev":"radio","freq":').kind).toBe("debug");
    expect(parseConsoleLine("{not json at all").kind).toBe("debug");
  });

  it("reports unknown events without losing the object", () => {
    const parsed = parseConsoleLine('{"t":28500,"ev":"calibration","offset":3}');
    expect(parsed).toMatchObject({
      kind: "unrecognized",
      object: { t: 28500, ev: "calibration", offset: 3 },
      problem: "evento desconocido: calibration",
    });
  });

  it("reports events the firmware truncated", () => {
    expect(parseConsoleLine('{"t":28600,"ev":"hello","truncated":true}')).toMatchObject({
      kind: "unrecognized",
      problem: "el nodo truncó el evento porque no entraba en su búfer",
    });
  });

  it("describes the first missing or invalid field for the operator", () => {
    expect(problemOf('{"t":1,"ev":"wifi","state":"on","ssid":"J5-3A7F","channel":1}')).toBe(
      "falta el campo clients",
    );
    expect(
      problemOf(
        '{"t":1,"ev":"status","id":"3a7f","model":"V4.3","epoch":1,"tx":0,"rx":0,"dropped":0,"heap":1}',
      ),
    ).toBe("el campo id debería ser un identificador de 4 dígitos hexadecimales en mayúscula");
    expect(
      problemOf(
        '{"t":1,"ev":"boot","id":"3A7F","model":"V3","epoch":1,"firmware":"0.2.0","protocol":2,"key":"default","operator_key":"default"}',
      ),
    ).toBe('el campo model debería ser "V2" o "V4.3"');
    expect(
      problemOf(
        '{"t":1,"ev":"radio","freq":915.9,"sf":7,"bw":500,"cr":5,"preamble":8,"sync":18,"power":4,"chip":4,"lna":"off"}',
      ),
    ).toBe('el campo lna debería ser "on", "bypass" o null');
    expect(
      problemOf(
        '{"t":1,"ev":"run_done","run":3,"count":10,"sent":10,"duration":999,"aborted":"no"}',
      ),
    ).toBe("el campo aborted debería ser true o false");
    expect(problemOf('{"t":"1","ev":"echo_lost","dst":"5C21","n":2,"size":16,"timeout":1}')).toBe(
      "el campo t debería ser un número",
    );
  });

  it("names the element of a list that is invalid", () => {
    expect(
      problemOf(
        '{"t":1,"ev":"hello","src":"5C21","epoch":7,"seq":3,"model":"V2","version":0,"available":0,"vm_fault":null,"vm_failing":false,"tx":3,"rssi":-47.5,"snr":9.75,"ferr":-1220,"neighbors":[{"id":"3A7F","rssi":-46,"snr":9.5},{"id":"9B04","rssi":"-101","snr":-7.25}]}',
      ),
    ).toBe("el campo neighbors[1].rssi debería ser un número");
  });

  it("reports a missing header or event name", () => {
    expect(problemOf('{"ev":"boot"}')).toBe("falta el campo t");
    expect(problemOf('{"t":1}')).toBe("falta el campo ev o no es un texto");
    expect(problemOf('{"t":1,"ev":7}')).toBe("falta el campo ev o no es un texto");
  });

  it("requires the run and index of a test transmission", () => {
    expect(
      problemOf(
        '{"t":1,"ev":"tx","type":"test","dst":"FFFF","seq":1,"size":24,"toa":1,"toa_calc":1}',
      ),
    ).toBe("una transmisión de tipo test debe incluir run e index");
    expect(
      eventOf(
        '{"t":1,"ev":"tx","type":"hello","dst":"FFFF","seq":1,"size":30,"toa":1,"toa_calc":1}',
      ),
    ).not.toHaveProperty("run");
  });

  it("accepts whole numbers written without decimals, as ArduinoJson writes them", () => {
    expect(
      eventOf(
        '{"t":813,"ev":"radio","freq":916,"sf":7,"bw":500,"cr":5,"preamble":8,"sync":18,"power":4,"chip":-9,"lna":"bypass"}',
      ),
    ).toMatchObject({ freq: 916, chip: -9 });
    expect(
      eventOf(
        '{"t":51102,"ev":"test_rx","src":"5C21","run":3,"index":0,"count":10,"size":239,"rssi":-38,"snr":10,"ferr":-1180}',
      ),
    ).toMatchObject({ rssi: -38, snr: 10 });
    expect(
      eventOf(
        '{"t":9,"ev":"run_end","src":"5C21","run":6,"count":5,"received":5,"pdr":1,"rssi_avg":-52,"rssi_min":-53,"rssi_max":-52,"snr_avg":7,"first":0,"last":4,"reason":"complete"}',
      ),
    ).toMatchObject({ pdr: 1, rssi_avg: -52, snr_avg: 7 });
  });

  it("refuses numbers that are not finite", () => {
    expect(
      problemOf('{"t":1,"ev":"drop","reason":"crc","size":30,"rssi":-1e999,"snr":-14.25}'),
    ).toBe("el campo rssi debería ser un número");
  });

  it("accepts error reasons a newer firmware may add", () => {
    const event = eventOf('{"t":28400,"ev":"error","cmd":"radio","reason":"thermal_limit"}');
    expect(event).toMatchObject({ ev: "error", reason: "thermal_limit" });
    expect(isKnownErrorReason("thermal_limit")).toBe(false);
    expect(isKnownErrorReason("wifi_failure")).toBe(true);
  });

  it("accepts the optional fields of error and drops them when null", () => {
    expect(
      eventOf(
        '{"t":1,"ev":"error","cmd":"radio","reason":"radio_failure","detail":"apply","code":-707}',
      ),
    ).toMatchObject({
      detail: "apply",
      code: -707,
    });
    expect(eventOf('{"t":1,"ev":"error","cmd":"","reason":"line_too_long","code":null}')).toEqual({
      t: 1,
      ev: "error",
      cmd: "",
      reason: "line_too_long",
    });
  });

  it("rejects run_end without quality values, which a run with its first packet always has", () => {
    expect(
      parseConsoleLine(
        '{"t":9,"ev":"run_end","src":"5C21","run":6,"count":5,"received":0,"pdr":0.0000,"rssi_avg":null,"rssi_min":null,"rssi_max":null,"snr_avg":null,"first":0,"last":0,"reason":"timeout"}',
      ).kind,
    ).toBe("unrecognized");
  });

  it("keeps fields the contract does not define", () => {
    expect(
      eventOf(
        '{"t":1,"ev":"wifi","state":"on","ssid":"J5-3A7F","channel":1,"clients":0,"rssi":-40}',
      ),
    ).toMatchObject({
      rssi: -40,
    });
  });
});

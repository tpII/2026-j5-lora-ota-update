import { describe, expect, it } from "vite-plus/test";
import { CONSOLE_EVENT_NAMES, isKnownErrorReason, type ConsoleEvent } from "./console-event.ts";
import { parseConsoleLine, type ParsedConsoleLine } from "./console-line-parser.ts";
import {
  NODE_SESSION_LOG,
  RECEIVER_RUN_LOG,
  SENDER_RUN_LOG,
  splitFixtureLines,
} from "$lib/testing/console-fixtures.ts";

function parseFixture(text: string): ParsedConsoleLine[] {
  return splitFixtureLines(text).map(parseConsoleLine);
}

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

describe("parseConsoleLine with recorded sessions", () => {
  it("recognizes every event the firmware emits", () => {
    const events = eventsOf([
      ...parseFixture(NODE_SESSION_LOG),
      ...parseFixture(SENDER_RUN_LOG),
      ...parseFixture(RECEIVER_RUN_LOG),
    ]);
    const names = new Set(events.map((event) => event.ev));
    expect([...names].sort()).toEqual([...CONSOLE_EVENT_NAMES].sort());
  });

  it("separates events, unrecognized objects and debug text", () => {
    const lines = parseFixture(NODE_SESSION_LOG);
    const kinds = lines.map((line) => line.kind);
    expect(kinds.filter((kind) => kind === "event")).toHaveLength(24);
    expect(kinds.filter((kind) => kind === "unrecognized")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "debug")).toHaveLength(14);
  });

  it("keeps the wire field names and values", () => {
    const [boot, radio] = eventsOf(parseFixture(NODE_SESSION_LOG));
    expect(boot).toEqual({
      t: 812,
      ev: "boot",
      id: "3A7F",
      model: "V4.3",
      epoch: 12,
      firmware: "0.1.0",
      protocol: 1,
      key: "default",
    });
    expect(radio).toMatchObject({ ev: "radio", freq: 915.9, sync: 18, chip: -9, lna: "bypass" });
  });

  it("reads the null LNA of the V2", () => {
    const radio = eventsOf(parseFixture(SENDER_RUN_LOG)).find((event) => event.ev === "radio");
    expect(radio).toMatchObject({ lna: null, power: 4, chip: 4 });
  });

  it("reads the neighbors reported in a HELLO", () => {
    const hello = eventsOf(parseFixture(NODE_SESSION_LOG)).find((event) => event.ev === "hello");
    expect(hello?.ev === "hello" ? hello.neighbors : null).toEqual([
      { id: "3A7F", rssi: -46, snr: 9.5 },
      { id: "9B04", rssi: -101, snr: -7.25 },
    ]);
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

  it("removes a trailing carriage return", () => {
    expect(
      eventOf('{"t":5,"ev":"wifi","state":"off","ssid":"J5-3A7F","channel":1,"clients":0}\r'),
    ).toEqual({
      t: 5,
      ev: "wifi",
      state: "off",
      ssid: "J5-3A7F",
      channel: 1,
      clients: 0,
    });
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

  it("reports missing and invalid fields", () => {
    expect(
      parseConsoleLine('{"t":1,"ev":"wifi","state":"on","ssid":"J5-3A7F","channel":1}'),
    ).toMatchObject({
      kind: "unrecognized",
      problem: "falta el campo clients",
    });
    expect(
      parseConsoleLine(
        '{"t":1,"ev":"status","id":"3a7f","model":"V4.3","epoch":1,"tx":0,"rx":0,"dropped":0,"heap":1}',
      ),
    ).toMatchObject({ kind: "unrecognized" });
    expect(parseConsoleLine('{"ev":"boot"}')).toMatchObject({
      kind: "unrecognized",
      problem: "falta el campo t o no es un número",
    });
    expect(
      parseConsoleLine(
        '{"t":1,"ev":"tx","type":"test","dst":"FFFF","seq":1,"size":24,"toa":1,"toa_calc":1}',
      ),
    ).toMatchObject({
      kind: "unrecognized",
      problem: "una transmisión de tipo test debe incluir run e index",
    });
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

  it("accepts run_end without quality values, as the firmware writes it with no packets", () => {
    const event = eventOf(
      '{"t":9,"ev":"run_end","src":"5C21","run":6,"count":5,"received":0,"pdr":0.0000,"rssi_avg":null,"rssi_min":null,"rssi_max":null,"snr_avg":null,"first":0,"last":0,"reason":"timeout"}',
    );
    expect(event).toMatchObject({ received: 0, rssi_avg: null, snr_avg: null });
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

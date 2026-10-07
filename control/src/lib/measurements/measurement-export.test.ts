import { describe, expect, it } from "vite-plus/test";
import { EventJournal } from "./event-journal.ts";
import {
  RECEIVER_BOOT_HOST_TIME,
  RECEIVER_RUN_LOG,
  SENDER_BOOT_HOST_TIME,
  SENDER_RUN_LOG,
  readFixtureEvents,
  splitFixtureLines,
} from "$lib/testing/console-fixtures.ts";
import { parseConsoleLine } from "$lib/console/console-line-parser.ts";
import {
  buildEventLine,
  buildMeasurementFiles,
  buildMetadata,
  buildSummaryCsv,
  formatLocalDate,
  formatLocalTimestamp,
  selectNextFolderName,
  type MeasurementDescription,
} from "./measurement-export.ts";
import { TestRunLedger } from "./test-run-ledger.ts";

/** Buenos Aires: UTC-3. */
const ARGENTINA_OFFSET = -180;
/** 7 October 2026, 14:03:05 in Buenos Aires. */
const EXPORT_DATE = new Date("2026-10-07T17:03:05Z");

const DESCRIPTION: MeasurementDescription = {
  test: "capacity-test",
  place: " Laboratorio, 1.er piso ",
  distanceMeters: 2.5,
  antennas: "Dipolos de 3 dBi",
  operators: "Juan Martín Seery",
  notes: "Prueba sobre la mesa",
};

describe("dates and folder names", () => {
  it("uses the date and time of the computer", () => {
    expect(formatLocalDate(EXPORT_DATE, ARGENTINA_OFFSET)).toBe("2026-10-07");
    expect(formatLocalTimestamp(EXPORT_DATE, ARGENTINA_OFFSET)).toBe("2026-10-07T14:03:05-03:00");
    expect(formatLocalTimestamp(new Date("2026-10-07T23:30:00Z"), ARGENTINA_OFFSET)).toBe(
      "2026-10-07T20:30:00-03:00",
    );
    expect(formatLocalDate(new Date("2026-10-08T01:30:00Z"), ARGENTINA_OFFSET)).toBe("2026-10-07");
    expect(formatLocalTimestamp(new Date("2026-01-01T00:00:00Z"), 330)).toBe(
      "2026-01-01T05:30:00+05:30",
    );
  });

  it("numbers the exports of a day from 01", () => {
    expect(selectNextFolderName([], "2026-10-07", "capacity-test")).toBe(
      "2026-10-07-capacity-test-01",
    );
    expect(
      selectNextFolderName(
        [
          "2026-10-07-capacity-test-01",
          "2026-10-07-capacity-test-03",
          "2026-10-07-power-sweep-07",
          "2026-10-06-capacity-test-09",
          "2026-10-07-capacity-test-notes",
          "README.md",
        ],
        "2026-10-07",
        "capacity-test",
      ),
    ).toBe("2026-10-07-capacity-test-04");
    expect(selectNextFolderName(["2026-10-07-power-sweep-99"], "2026-10-07", "power-sweep")).toBe(
      "2026-10-07-power-sweep-100",
    );
  });
});

describe("metadata.json", () => {
  it("has exactly the fields of measurements/README.md", () => {
    const metadata = buildMetadata(
      DESCRIPTION,
      [
        { id: "5C21", model: "V2" },
        { id: "3A7F", model: "V4.3" },
      ],
      EXPORT_DATE,
      "0.1.0",
      ARGENTINA_OFFSET,
    );
    expect(metadata).toEqual({
      test: "capacity-test",
      date: "2026-10-07T14:03:05-03:00",
      place: "Laboratorio, 1.er piso",
      distance_m: 2.5,
      antennas: "Dipolos de 3 dBi",
      operators: "Juan Martín Seery",
      notes: "Prueba sobre la mesa",
      nodes: [
        { id: "3A7F", model: "V4.3" },
        { id: "5C21", model: "V2" },
      ],
      panel_version: "0.1.0",
    });
  });
});

describe("events.jsonl", () => {
  it("appends node and host_time to the line of the firmware", () => {
    const text =
      '{"t":813,"ev":"radio","freq":915.900,"sf":7,"bw":500,"cr":5,"preamble":8,"sync":18,"power":4,"chip":-9,"lna":"bypass"}';
    const parsed = parseConsoleLine(text);
    expect(parsed.kind).toBe("event");
    const line = buildEventLine({
      text,
      object: parsed.kind === "event" ? parsed.event : {},
      node: "3A7F",
      hostTime: 1759849990812,
    });
    expect(line).toBe(
      '{"t":813,"ev":"radio","freq":915.900,"sf":7,"bw":500,"cr":5,"preamble":8,"sync":18,"power":4,"chip":-9,"lna":"bypass","node":"3A7F","host_time":1759849990812}',
    );
    expect(JSON.parse(line)).toMatchObject({ ev: "radio", node: "3A7F", host_time: 1759849990812 });
  });

  it("writes the object again when it cannot append to the text", () => {
    expect(buildEventLine({ text: "{}", object: {}, node: null, hostTime: 5 })).toBe(
      '{"node":null,"host_time":5}',
    );
    expect(
      buildEventLine({
        text: '{"t":1,"node":"X"}',
        object: { t: 1, node: "X" },
        node: "3A7F",
        hostTime: 5,
      }),
    ).toBe('{"t":1,"node":"3A7F","host_time":5}');
  });

  it("exports the events of the nodes chosen, in arrival order, from the journal", () => {
    const journal = new EventJournal();
    for (const line of splitFixtureLines(SENDER_RUN_LOG).slice(0, 4)) {
      const parsed = parseConsoleLine(line);
      if (parsed.kind === "event") {
        journal.append(
          "serial-1",
          parsed.text,
          parsed.event,
          SENDER_BOOT_HOST_TIME + parsed.event.t,
        );
      }
    }
    journal.append("websocket-2", '{"t":1,"ev":"calibration"}', { t: 1, ev: "calibration" }, 7);
    journal.assignNode("serial-1", "5C21", "V2");
    expect(journal.size).toBe(4);
    expect(journal.participatingNodes()).toEqual([{ id: "5C21", model: "V2" }]);
    const lines = [...journal.events(new Set(["5C21"]))].map(buildEventLine);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      `{"t":640,"ev":"boot","id":"5C21","model":"V2","epoch":7,"firmware":"0.1.0","protocol":1,"key":"default","node":"5C21","host_time":${SENDER_BOOT_HOST_TIME + 640}}`,
    );
    // Without a choice, events of connections with no known node go out with node null.
    expect([...journal.events()].at(-1)).toMatchObject({ node: null, hostTime: 7 });
  });

  it("stops recording when full and counts what it rejected", () => {
    const journal = new EventJournal(2);
    expect(journal.append("a", "{}", {}, 1)).toBe(true);
    expect(journal.append("a", "{}", {}, 2)).toBe(true);
    expect(journal.append("a", "{}", {}, 3)).toBe(false);
    expect(journal.rejectedCount).toBe(1);
    expect(journal.firstHostTime).toBe(1);
    journal.clear();
    expect(journal.size).toBe(0);
    expect(journal.rejectedCount).toBe(0);
  });
});

describe("summary.csv", () => {
  function fixtureLedger(): TestRunLedger {
    const ledger = new TestRunLedger();
    const events = [
      ...readFixtureEvents(SENDER_RUN_LOG, SENDER_BOOT_HOST_TIME).map((item) => ({
        ...item,
        node: "5C21",
      })),
      ...readFixtureEvents(RECEIVER_RUN_LOG, RECEIVER_BOOT_HOST_TIME).map((item) => ({
        ...item,
        node: "3A7F",
      })),
    ].sort((first, second) => first.hostTime - second.hostTime);
    for (const { node, event, hostTime } of events) {
      ledger.acceptEvent(node, event, hostTime);
    }
    ledger.closeReceptionWithoutPackets("5C21", 5, "3A7F");
    return ledger;
  }

  it("has the header and the columns of measurements/README.md", () => {
    expect(buildSummaryCsv(fixtureLedger().rows)).toBe(
      [
        "run,sender,receiver,sender_model,receiver_model,freq,sf,bw,cr,preamble,power,receiver_lna,size,count,sent,received,pdr,rssi_avg,rssi_min,rssi_max,snr_avg,toa_avg,toa_calc,duration,goodput,reason",
        "3,5C21,3A7F,V2,V4.3,915.9,7,500,5,8,2,bypass,239,10,10,9,0.9,-38.6,-39.5,-38,10.03,99959.5,99904,1018012,16903.5,complete",
        "4,5C21,3A7F,V2,V4.3,915.9,7,500,5,8,2,bypass,64,5,5,3,0.6,-52.5,-53,-52,7.25,35950,35904,580112,2647.8,timeout",
        "5,5C21,3A7F,V2,V4.3,915.9,7,500,5,8,2,bypass,8,3,3,0,0,,,,,15469,15424,49328,0,timeout",
        "",
      ].join("\n"),
    );
  });

  it("leaves empty the values it does not know, such as the LNA of a V2", () => {
    const [row] = fixtureLedger().rows;
    const csv = buildSummaryCsv([
      { ...row!, receiver_lna: null, receiver_model: "V2", sent: null },
    ]);
    expect(csv.split("\n")[1]).toBe(
      "3,5C21,3A7F,V2,V2,915.9,7,500,5,8,2,,239,10,,9,0.9,-38.6,-39.5,-38,10.03,99959.5,99904,1018012,16903.5,complete",
    );
  });
});

describe("buildMeasurementFiles", () => {
  it("produces the three files of an export", () => {
    const metadata = buildMetadata(DESCRIPTION, [], EXPORT_DATE, "0.1.0", ARGENTINA_OFFSET);
    const files = buildMeasurementFiles(metadata, [], []);
    expect(files.map((file) => [file.name, file.mediaType])).toEqual([
      ["metadata.json", "application/json"],
      ["events.jsonl", "application/x-ndjson"],
      ["summary.csv", "text/csv"],
    ]);
    expect(JSON.parse(files[0]!.content)).toEqual(metadata);
    expect(files[1]!.content).toBe("");
  });
});

import { describe, expect, it } from "vite-plus/test";
import type { EchoResult, ServedEcho } from "$lib/nodes/echo-records.ts";
import type { RadioSettings } from "$lib/radio/radio-settings.ts";
import type { CommunicationTestSnapshot } from "./communication-test.ts";
import type { ReceiverModeSnapshot } from "./communication-receiver.ts";
import { buildReceiverExport, buildSenderExport } from "./communication-test-export.ts";
import {
  buildExportFolder,
  exportFileNames,
  type MeasurementDescription,
  type MeasurementExport,
} from "./measurement-export.ts";

/** 7 October 2026, 14:03:05 in Buenos Aires. */
const EXPORT_DATE = new Date("2026-10-07T17:03:05Z");
const ARGENTINA_OFFSET = -180;

const SHEET: MeasurementDescription = {
  place: 'Laboratorio, "1.er" piso',
  distanceMeters: null,
  antennas: "Dipolos de 3 dBi",
  operators: "Juan, Ana",
  notes: "",
};

const NODES = [
  { id: "5C21", model: "V2" as const },
  { id: "3A7F", model: "V4.3" as const },
];

const RADIO: RadioSettings = {
  freq: 915.9,
  sf: 9,
  bw: 500,
  cr: 5,
  preamble: 8,
  sync: 18,
  power: -4,
  chip: -9,
  lna: "bypass",
};

function answered(
  number: number,
  roundTripMicroseconds: number,
  reverse: readonly [number, number],
  forward: readonly [number, number],
): EchoResult {
  return {
    outcome: "answered",
    hostTime: 1000 * number,
    destination: "3A7F",
    number,
    size: 4,
    roundTripMicroseconds,
    rssi: reverse[0],
    snr: reverse[1],
    remoteRssi: forward[0],
    remoteSnr: forward[1],
  };
}

const SENDER: CommunicationTestSnapshot = {
  status: "finished",
  requester: "5C21",
  responder: "3A7F",
  settings: { freq: 915.9, preamble: 8, sync: 18, sf: 9, bw: 500, cr: 5, size: 4, count: 5 },
  requesterRadio: RADIO,
  exchanges: [
    answered(1, 101_234, [-100, -7], [-100.5, -7.25]),
    {
      outcome: "lost",
      hostTime: 2000,
      destination: "3A7F",
      number: 2,
      size: 4,
      timeoutMilliseconds: 1200,
    },
    answered(3, 101_235, [-100.5, -7.25], [-100, -7]),
    answered(4, 101_236, [-100, -7.5], [-101, -7]),
    answered(5, 101_240, [-100.5, -7], [-100.5, -7.25]),
  ],
  progress: 1,
  startHostTime: 500,
  endHostTime: 5500,
  failure: null,
  restored: true,
  restorationProblems: [],
};

const SERVED: ServedEcho[] = [
  { hostTime: 1000, source: "5C21", number: 1, size: 4, rssi: -100.25, snr: -7.125 },
  { hostTime: 2000, source: "9B04", number: 7, size: 4, rssi: -90, snr: 5.5 },
  { hostTime: 3000, source: "5C21", number: 2, size: 4, rssi: -100.5, snr: -7.25 },
  { hostTime: 4000, source: "5C21", number: 3, size: 4, rssi: -100, snr: -7 },
  { hostTime: 5000, source: "5C21", number: 4, size: 4, rssi: -100.25, snr: -7.125 },
];

const RECEIVER: ReceiverModeSnapshot = {
  status: "inactive",
  node: "3A7F",
  modulation: { sf: 9, bw: 500, cr: 5 },
  previousRadio: { ...RADIO, sf: 7, power: 2 },
  servedEchoes: SERVED,
  activationHostTime: 0,
  deactivationHostTime: 6000,
  failure: null,
  restored: true,
  restorationProblems: [],
};

function contentsOf(measurement: MeasurementExport): Record<string, string> {
  const { test, files } = buildExportFolder(measurement, EXPORT_DATE, "0.1.0", ARGENTINA_OFFSET);
  expect(test).toBe("communication-test");
  expect(files.map((file) => file.name)).toEqual(exportFileNames(measurement.layout));
  return Object.fromEntries(files.map((file) => [file.name, file.content]));
}

const COMMON_METADATA = {
  test: "communication-test",
  date: "2026-10-07T14:03:05-03:00",
  place: 'Laboratorio, "1.er" piso',
  distance_m: null,
  antennas: "Dipolos de 3 dBi",
  operators: "Juan, Ana",
  notes: "",
  nodes: [
    { id: "3A7F", model: "V4.3" },
    { id: "5C21", model: "V2" },
  ],
  panel_version: "0.1.0",
};

const METADATA_KEYS = [
  "test",
  "role",
  "date",
  "place",
  "distance_m",
  "antennas",
  "operators",
  "notes",
  "nodes",
  "panel_version",
  "node",
  "destination",
  "settings",
];

describe("buildSenderExport", () => {
  const files = contentsOf(buildSenderExport(SENDER, SHEET, NODES, []));

  it("writes the fields of the sender after the common ones", () => {
    const metadata = JSON.parse(files["metadata.json"] ?? "{}");
    expect(Object.keys(metadata)).toEqual(METADATA_KEYS);
    expect(metadata).toEqual({
      ...COMMON_METADATA,
      role: "sender",
      node: "5C21",
      destination: "3A7F",
      settings: SENDER.settings,
    });
  });

  it("writes the metrics in one row, rounding half away from zero", () => {
    expect(files["summary.csv"]?.split("\n")[1]).toBe(
      "5C21,3A7F,V2,915.9,9,500,5,8,-4,4,20,5,5,4,1,0.8,-100.5,-101,-100,-7.13,-7.25,-7," +
        "-100.3,-100.5,-100,-7.19,-7.5,-7,101236,101234,101240,46336,7031.3,0.2,256,632.2,finished",
    );
  });

  it("writes one row per echo, with empty quality for the lost ones", () => {
    expect(files["echoes.csv"]).toBe(
      "n,host_time,outcome,rtt,forward_rssi,forward_snr,reverse_rssi,reverse_snr\n" +
        "1,1000,answered,101234,-100.5,-7.25,-100,-7\n" +
        "2,2000,lost,,,,,\n" +
        "3,3000,answered,101235,-100,-7,-100.5,-7.25\n" +
        "4,4000,answered,101236,-101,-7,-100,-7.5\n" +
        "5,5000,answered,101240,-100.5,-7.25,-100.5,-7\n",
    );
  });
});

describe("buildReceiverExport", () => {
  const files = contentsOf(buildReceiverExport(RECEIVER, SHEET, NODES, []));

  it("writes the modulation of receiver mode with no size or count", () => {
    const metadata = JSON.parse(files["metadata.json"] ?? "{}");
    expect(Object.keys(metadata)).toEqual(METADATA_KEYS);
    expect(metadata).toEqual({
      ...COMMON_METADATA,
      role: "receiver",
      node: "3A7F",
      destination: null,
      settings: {
        freq: 915.9,
        preamble: 8,
        sync: 18,
        sf: 9,
        bw: 500,
        cr: 5,
        size: null,
        count: null,
      },
    });
  });

  it("writes one row per sender, in order of first appearance", () => {
    expect(files["summary.csv"]).toBe(
      "node,node_model,source,freq,sf,bw,cr,preamble,power,lna,served,rssi_avg,rssi_min,rssi_max," +
        "snr_avg,snr_min,snr_max,first_host_time,last_host_time\n" +
        "3A7F,V4.3,5C21,915.9,9,500,5,8,2,bypass,4,-100.3,-100.5,-100,-7.13,-7.25,-7,1000,5000\n" +
        "3A7F,V4.3,9B04,915.9,9,500,5,8,2,bypass,1,-90,-90,-90,5.5,5.5,5.5,2000,2000\n",
    );
  });

  it("writes one row per echo answered, in arrival order", () => {
    expect(files["echoes.csv"]).toBe(
      "n,host_time,src,size,rssi,snr\n" +
        "1,1000,5C21,4,-100.25,-7.125\n" +
        "7,2000,9B04,4,-90,5.5\n" +
        "2,3000,5C21,4,-100.5,-7.25\n" +
        "3,4000,5C21,4,-100,-7\n" +
        "4,5000,5C21,4,-100.25,-7.125\n",
    );
  });
});

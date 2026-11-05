import { describe, expect, it } from "vite-plus/test";
import {
  RECEIVER_BOOT_HOST_TIME,
  SENDER_BOOT_HOST_TIME,
  UPDATE_ACTIVATE_HOST_TIME,
  UPDATE_LOAD_HOST_TIME,
  UPDATE_ORIGIN_LOG,
  UPDATE_RECEIVER_LOG,
  UPDATE_VERSION,
  readFixtureEvents,
} from "$lib/testing/console-fixtures.ts";
import {
  computeUpdateMetrics,
  nodeConsoleEventsOf,
  type UpdateCommandRecord,
} from "./update-metrics.ts";
import {
  UPDATE_SUMMARY_COLUMNS,
  boardModelsOf,
  buildUpdateFiles,
  buildUpdateSummaryRows,
  loadedUpdateVersions,
} from "./update-export.ts";

const events = [
  ...nodeConsoleEventsOf("5C21", readFixtureEvents(UPDATE_ORIGIN_LOG, SENDER_BOOT_HOST_TIME)),
  ...nodeConsoleEventsOf("3A7F", readFixtureEvents(UPDATE_RECEIVER_LOG, RECEIVER_BOOT_HOST_TIME)),
];

const metrics = computeUpdateMetrics({
  version: UPDATE_VERSION,
  loadHostTime: UPDATE_LOAD_HOST_TIME,
  activateHostTime: UPDATE_ACTIVATE_HOST_TIME,
  events,
});

const commands: UpdateCommandRecord[] = [
  {
    connectionKey: "usb-1",
    node: "5C21",
    hostTime: UPDATE_LOAD_HOST_TIME,
    command: { kind: "load_image", version: UPDATE_VERSION },
    accepted: true,
  },
  {
    connectionKey: "usb-1",
    node: "5C21",
    hostTime: UPDATE_LOAD_HOST_TIME + 1000,
    command: { kind: "load_image", version: UPDATE_VERSION },
  },
  {
    connectionKey: "usb-1",
    node: "5C21",
    hostTime: UPDATE_ACTIVATE_HOST_TIME,
    command: { kind: "activate", version: UPDATE_VERSION },
  },
];

describe("loadedUpdateVersions", () => {
  it("lists each loaded version once", () => {
    expect(loadedUpdateVersions(commands)).toEqual([UPDATE_VERSION]);
  });

  it("leaves out a version that no node accepted", () => {
    const rejected: UpdateCommandRecord = {
      connectionKey: "usb-1",
      node: "5C21",
      hostTime: UPDATE_LOAD_HOST_TIME + 2000,
      command: { kind: "load_image", version: UPDATE_VERSION + 1 },
    };
    expect(loadedUpdateVersions([...commands, rejected])).toEqual([UPDATE_VERSION]);
  });
});

describe("boardModelsOf", () => {
  it("takes the models from boot, status, HELLO and neighbor", () => {
    expect(Object.fromEntries(boardModelsOf(events))).toEqual({ "3A7F": "V4.3", "5C21": "V2" });
  });
});

describe("buildUpdateSummaryRows", () => {
  it("writes one row per receiver with M1, M2 and M3", () => {
    expect(buildUpdateSummaryRows(metrics, boardModelsOf(events))).toEqual([
      {
        version: UPDATE_VERSION,
        origin: "5C21",
        node: "3A7F",
        node_model: "V4.3",
        connected: "true",
        load_host_time: UPDATE_LOAD_HOST_TIME,
        activate_host_time: UPDATE_ACTIVATE_HOST_TIME,
        convergence_ms: 20_021,
        distribution_ms: 195,
        activation_ms: 21,
        node_available_ms: 195,
        node_active_ms: 20_021,
        transmitted: 16,
        fragment_count: 4,
        minimum: 4,
        efficiency: 4,
        node_transmitted: 8,
        node_starts_after_load: "false",
        transfer_fragments: 9,
        transfer_reports: 1,
        transfer_complete: "true",
        first_report_count: 4,
        first_report_missing: 1,
        missing_percent: 25,
        repair_rounds: 1,
        observed_reports: 1,
        image_fragments: 4,
        image_duration_ms: 137,
      },
    ]);
  });
});

describe("buildUpdateFiles", () => {
  const files = buildUpdateFiles({
    metrics: [metrics],
    commands,
    description: {
      place: " Laboratorio ",
      distanceMeters: 2,
      antennas: "",
      operators: "",
      notes: "",
    },
    nodes: [
      { id: "5C21", model: "V2" },
      { id: "3A7F", model: "V4.3" },
    ],
    events: [
      {
        text: '{"t":1,"ev":"radio"}',
        object: { t: 1, ev: "radio" },
        node: "5C21",
        hostTime: 5,
      },
    ],
    models: boardModelsOf(events),
    exportDate: new Date(Date.UTC(2026, 10, 5, 15, 0, 0)),
    panelVersion: "0.1.0",
    offsetMinutes: -180,
  });

  it("writes metadata.json with the updates and the commands of the panel", () => {
    const metadata = JSON.parse(files[0]?.content ?? "{}");
    expect(files.map((file) => file.name)).toEqual([
      "metadata.json",
      "events.jsonl",
      "summary.csv",
    ]);
    expect(metadata).toMatchObject({
      test: "update",
      date: "2026-11-05T12:00:00-03:00",
      place: "Laboratorio",
      nodes: [
        { id: "3A7F", model: "V4.3" },
        { id: "5C21", model: "V2" },
      ],
      updates: [
        {
          version: UPDATE_VERSION,
          origin: "5C21",
          load_host_time: UPDATE_LOAD_HOST_TIME,
          activate_host_time: UPDATE_ACTIVATE_HOST_TIME,
          nodes: ["3A7F", "5C21"],
        },
      ],
    });
    expect(metadata.commands).toHaveLength(3);
    expect(metadata.commands[2]).toEqual({
      node: "5C21",
      host_time: UPDATE_ACTIVATE_HOST_TIME,
      command: "activate",
      version: UPDATE_VERSION,
    });
  });

  it("writes the events and a summary with the documented columns", () => {
    expect(files[1]?.content).toBe('{"t":1,"ev":"radio","node":"5C21","host_time":5}\n');
    const [header, row, end] = (files[2]?.content ?? "").split("\n");
    expect(header).toBe(UPDATE_SUMMARY_COLUMNS.join(","));
    expect(row?.startsWith(`${UPDATE_VERSION},5C21,3A7F,V4.3,true,`)).toBe(true);
    expect(end).toBe("");
  });
});

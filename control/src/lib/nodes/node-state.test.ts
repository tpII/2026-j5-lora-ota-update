import { describe, expect, it } from "vite-plus/test";
import {
  NODE_SESSION_LOG,
  RECEIVER_BOOT_HOST_TIME,
  RECEIVER_RUN_LOG,
  SENDER_BOOT_HOST_TIME,
  SENDER_RUN_LOG,
  readFixtureEvents,
  type TimedConsoleEvent,
} from "$lib/testing/console-fixtures.ts";
import {
  INITIAL_NODE_STATE,
  applyConsoleEvent,
  estimateUptime,
  isNeighborExpired,
  isRunActive,
  neighborAge,
  type NodeState,
} from "./node-state.ts";

function replay(
  events: readonly TimedConsoleEvent[],
  initial: NodeState = INITIAL_NODE_STATE,
): NodeState {
  return events.reduce(
    (state, { event, hostTime }) => applyConsoleEvent(state, event, hostTime),
    initial,
  );
}

const BOOT_HOST_TIME = 1_759_840_000_000;

describe("applyConsoleEvent with a recorded session", () => {
  const state = replay(readFixtureEvents(NODE_SESSION_LOG, BOOT_HOST_TIME));

  it("learns the identity from boot and status", () => {
    expect(state).toMatchObject({
      identifier: "3A7F",
      model: "V4.3",
      epoch: 12,
      firmwareVersion: "0.1.0",
      protocolVersion: 1,
      networkKey: "default",
      bootCount: 1,
    });
  });

  it("keeps the radio settings and the WiFi state", () => {
    expect(state.radio).toEqual({
      freq: 915.9,
      sf: 7,
      bw: 500,
      cr: 5,
      preamble: 8,
      sync: 18,
      power: 4,
      chip: -9,
      lna: "bypass",
    });
    expect(state.wifi).toEqual({ state: "on", ssid: "J5-3A7F", channel: 1, clients: 1 });
    expect(state.counters).toEqual({
      transmitted: 1,
      received: 1,
      droppedLines: 0,
      freeHeap: 231456,
      hostTime: BOOT_HOST_TIME + 15012,
    });
  });

  it("merges hello and neighbor into one record per neighbor", () => {
    expect(state.neighbors).toHaveLength(1);
    expect(state.neighbors[0]).toEqual({
      id: "5C21",
      model: "V2",
      version: 0,
      transmitted: 4,
      rssi: -47,
      snr: 9.5,
      frequencyError: -1220,
      epoch: 7,
      sequence: 3,
      lastHeardHostTime: BOOT_HOST_TIME + 15013 - 2063,
      reportedNeighbors: [
        { id: "3A7F", rssi: -46, snr: 9.5 },
        { id: "9B04", rssi: -101, snr: -7.25 },
      ],
      helloCount: 1,
    });
  });

  it("records answered and lost echoes, and the echoes it served", () => {
    expect(state.echoResults).toEqual([
      {
        outcome: "answered",
        hostTime: BOOT_HOST_TIME + 20023,
        destination: "5C21",
        number: 1,
        size: 16,
        roundTripMicroseconds: 41237,
        rssi: -38.5,
        snr: 10.25,
        remoteRssi: -40,
        remoteSnr: 9.75,
      },
      {
        outcome: "lost",
        hostTime: BOOT_HOST_TIME + 25018,
        destination: "5C21",
        number: 2,
        size: 16,
        timeoutMilliseconds: 1036,
      },
    ]);
    expect(state.servedEchoes).toEqual([
      { hostTime: BOOT_HOST_TIME + 26000, source: "5C21", number: 7, size: 16, rssi: -39, snr: 10 },
    ]);
  });

  it("counts discarded packets and keeps the errors", () => {
    expect(state.duplicateCount).toBe(1);
    expect(state.dropCount).toBe(1);
    expect(state.identifierConflictCount).toBe(1);
    expect(state.errors.map((error) => [error.command, error.reason])).toEqual([
      ["radio", "unreachable_power"],
      ["frobnicate", "unknown_command"],
      ["radio", "radio_failure"],
      ["wifi", "wifi_failure"],
      ["radio", "thermal_limit"],
    ]);
    expect(state.errors[2]).toMatchObject({ detail: "apply", code: -707 });
  });

  it("estimates the uptime and the age of the neighbors", () => {
    expect(estimateUptime(state, BOOT_HOST_TIME + 30000)).toBe(30000);
    const neighbor = state.neighbors[0]!;
    expect(neighborAge(neighbor, BOOT_HOST_TIME + 15013)).toBe(2063);
    expect(isNeighborExpired(neighbor, BOOT_HOST_TIME + 15013 + 57937)).toBe(false);
    expect(isNeighborExpired(neighbor, BOOT_HOST_TIME + 15013 + 57938)).toBe(true);
  });

  it("returns a new object for every event and leaves the previous state untouched", () => {
    const before = replay(readFixtureEvents(NODE_SESSION_LOG, BOOT_HOST_TIME).slice(0, 3));
    const snapshot = structuredClone(before);
    const after = applyConsoleEvent(
      before,
      { t: 1, ev: "wifi", state: "off", ssid: "J5-3A7F", channel: 1, clients: 0 },
      1,
    );
    expect(after).not.toBe(before);
    expect(before).toEqual(snapshot);
  });
});

describe("applyConsoleEvent with test runs", () => {
  it("follows the run of the sender", () => {
    const events = readFixtureEvents(SENDER_RUN_LOG, SENDER_BOOT_HOST_TIME);
    const runStart = events.findIndex(({ event }) => event.ev === "run_start");
    const midRun = replay(events.slice(0, runStart + 5));
    expect(midRun.senderRun).toMatchObject({
      run: 3,
      count: 10,
      size: 239,
      interval: 0,
      transmitted: 4,
      completion: null,
    });
    expect(isRunActive(midRun)).toBe(true);

    const state = replay(events);
    expect(state.senderRun).toMatchObject({
      run: 5,
      count: 3,
      transmitted: 3,
      completion: { sent: 3, duration: 49328, aborted: false },
    });
    expect(isRunActive(state)).toBe(false);
    expect(state.radio).toMatchObject({ power: 2, chip: 2, lna: null });
  });

  it("follows the receptions of the receiver", () => {
    const events = readFixtureEvents(RECEIVER_RUN_LOG, RECEIVER_BOOT_HOST_TIME);
    const firstEnd = events.findIndex(({ event }) => event.ev === "run_end");
    const midRun = replay(events.slice(0, firstEnd));
    expect(midRun.receptions).toEqual([
      expect.objectContaining({
        source: "5C21",
        run: 3,
        count: 10,
        received: 9,
        lastIndex: 9,
        end: null,
      }),
    ]);
    expect(isRunActive(midRun)).toBe(true);

    const state = replay(events);
    expect(
      state.receptions.map((reception) => [
        reception.run,
        reception.received,
        reception.end?.reason,
      ]),
    ).toEqual([
      [4, 3, "timeout"],
      [3, 9, "complete"],
    ]);
    expect(isRunActive(state)).toBe(false);
  });

  it("forgets neighbors and runs in progress when the node reboots", () => {
    const events = readFixtureEvents(NODE_SESSION_LOG, BOOT_HOST_TIME);
    const state = replay(events);
    const rebooted = applyConsoleEvent(
      state,
      {
        t: 700,
        ev: "boot",
        id: "3A7F",
        model: "V4.3",
        epoch: 13,
        firmware: "0.1.0",
        protocol: 1,
        key: "default",
      },
      BOOT_HOST_TIME + 90000,
    );
    expect(rebooted).toMatchObject({ epoch: 13, bootCount: 2, neighbors: [] });
    expect(rebooted.echoResults).toHaveLength(2);
  });

  it("starts over when another node appears behind the same transport", () => {
    const state = replay(readFixtureEvents(NODE_SESSION_LOG, BOOT_HOST_TIME));
    const other = applyConsoleEvent(
      state,
      {
        t: 5,
        ev: "status",
        id: "5C21",
        model: "V2",
        epoch: 7,
        tx: 0,
        rx: 0,
        dropped: 0,
        heap: 200000,
      },
      BOOT_HOST_TIME + 90000,
    );
    expect(other).toMatchObject({
      identifier: "5C21",
      model: "V2",
      echoResults: [],
      neighbors: [],
      radio: null,
    });
  });
});

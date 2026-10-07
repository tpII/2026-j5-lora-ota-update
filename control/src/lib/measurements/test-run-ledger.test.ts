import { describe, expect, it } from "vite-plus/test";
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import {
  RECEIVER_BOOT_HOST_TIME,
  RECEIVER_RUN_LOG,
  SENDER_BOOT_HOST_TIME,
  SENDER_RUN_LOG,
  readFixtureEvents,
  type TimedConsoleEvent,
} from "$lib/testing/console-fixtures.ts";
import {
  TestRunLedger,
  receptionGraceMilliseconds,
  type TestRunSummaryRow,
} from "./test-run-ledger.ts";

interface NodeEvent extends TimedConsoleEvent {
  readonly node: NodeIdentifier;
}

const SENDER: NodeIdentifier = "5C21";
const RECEIVER: NodeIdentifier = "3A7F";

function senderEvents(): NodeEvent[] {
  return readFixtureEvents(SENDER_RUN_LOG, SENDER_BOOT_HOST_TIME).map((item) => ({
    ...item,
    node: SENDER,
  }));
}

function receiverEvents(): NodeEvent[] {
  return readFixtureEvents(RECEIVER_RUN_LOG, RECEIVER_BOOT_HOST_TIME).map((item) => ({
    ...item,
    node: RECEIVER,
  }));
}

function interleaved(...streams: NodeEvent[][]): NodeEvent[] {
  return streams.flat().sort((first, second) => first.hostTime - second.hostTime);
}

function feed(ledger: TestRunLedger, events: readonly NodeEvent[]): void {
  for (const { node, event, hostTime } of events) {
    ledger.acceptEvent(node, event, hostTime);
  }
}

const RUN_3_ROW: TestRunSummaryRow = {
  run: 3,
  sender: "5C21",
  receiver: "3A7F",
  sender_model: "V2",
  receiver_model: "V4.3",
  freq: 915.9,
  sf: 7,
  bw: 500,
  cr: 5,
  preamble: 8,
  power: 2,
  receiver_lna: "bypass",
  size: 239,
  count: 10,
  sent: 10,
  received: 9,
  pdr: 0.9,
  rssi_avg: -38.6,
  rssi_min: -39.5,
  rssi_max: -38,
  snr_avg: 10.03,
  toa_avg: 99959.5,
  toa_calc: 99904,
  duration: 1018012,
  goodput: 16903.5,
  reason: "complete",
};

const RUN_4_ROW: TestRunSummaryRow = {
  ...RUN_3_ROW,
  run: 4,
  size: 64,
  count: 5,
  sent: 5,
  received: 3,
  pdr: 0.6,
  rssi_avg: -52.5,
  rssi_min: -53,
  rssi_max: -52,
  snr_avg: 7.25,
  toa_avg: 35950,
  toa_calc: 35904,
  duration: 580112,
  goodput: 2647.8,
  reason: "timeout",
};

const RUN_5_ROW: TestRunSummaryRow = {
  ...RUN_3_ROW,
  run: 5,
  size: 8,
  count: 3,
  sent: 3,
  received: 0,
  pdr: 0,
  rssi_avg: null,
  rssi_min: null,
  rssi_max: null,
  snr_avg: null,
  toa_avg: 15469,
  toa_calc: 15424,
  duration: 49328,
  goodput: 0,
  reason: "timeout",
};

/** Host time at which node 5C21 reported the end of run 5. */
const RUN_5_DONE_HOST_TIME = SENDER_BOOT_HOST_TIME + 60050;

describe("TestRunLedger with recorded consoles", () => {
  it("joins sender and receiver into the rows of summary.csv", () => {
    const ledger = new TestRunLedger();
    feed(ledger, interleaved(senderEvents(), receiverEvents()));
    expect(ledger.rows).toEqual([RUN_3_ROW, RUN_4_ROW]);
  });

  it("gives the same rows whatever console the panel reads first", () => {
    const receiverFirst = new TestRunLedger();
    feed(receiverFirst, [...receiverEvents(), ...senderEvents()]);
    const senderFirst = new TestRunLedger();
    feed(senderFirst, [...senderEvents(), ...receiverEvents()]);
    expect(receiverFirst.rows).toEqual([RUN_3_ROW, RUN_4_ROW]);
    expect(senderFirst.rows).toEqual([RUN_3_ROW, RUN_4_ROW]);
  });

  it("closes the silent reception of a listening receiver after its deadline", () => {
    const ledger = new TestRunLedger();
    feed(ledger, interleaved(senderEvents(), receiverEvents()));
    const grace = receptionGraceMilliseconds(0, 15424);
    expect(grace).toBe(2 * 16 + 1000 + 3000);

    expect(ledger.closeOverdueReceptions(RUN_5_DONE_HOST_TIME + grace - 1)).toBe(false);
    expect(ledger.findRun(SENDER, 5)?.receptions).toEqual([
      expect.objectContaining({ receiver: RECEIVER, received: 0, outcome: "receiving", row: null }),
    ]);

    expect(ledger.closeOverdueReceptions(RUN_5_DONE_HOST_TIME + grace)).toBe(true);
    expect(ledger.rows).toEqual([RUN_3_ROW, RUN_4_ROW, RUN_5_ROW]);
    expect(ledger.findRun(SENDER, 5)?.receptions[0]?.outcome).toBe("no_reception");
    expect(ledger.closeOverdueReceptions(RUN_5_DONE_HOST_TIME + grace + 1)).toBe(false);
  });

  it("closes a silent reception on request", () => {
    const ledger = new TestRunLedger();
    feed(ledger, interleaved(senderEvents(), receiverEvents()));
    expect(ledger.closeReceptionWithoutPackets(SENDER, 5, RECEIVER)).toBe(true);
    expect(ledger.findRow(SENDER, 5, RECEIVER)).toEqual(RUN_5_ROW);
    // A reception with packets is not silent.
    expect(ledger.closeReceptionWithoutPackets(SENDER, 4, RECEIVER)).toBe(false);
    expect(ledger.findRow(SENDER, 4, RECEIVER)).toEqual(RUN_4_ROW);
  });

  it("does not expect a reception from a node that disconnected", () => {
    const ledger = new TestRunLedger();
    const events = interleaved(senderEvents(), receiverEvents());
    const runFive = events.findIndex(
      ({ node, event }) => node === SENDER && event.ev === "run_start" && event.run === 5,
    );
    feed(ledger, events.slice(0, runFive));
    ledger.markNodeAbsent(RECEIVER);
    feed(ledger, events.slice(runFive));
    ledger.closeOverdueReceptions(RUN_5_DONE_HOST_TIME + 60_000);
    expect(ledger.findRun(SENDER, 5)?.receptions).toEqual([]);
    expect(ledger.rows).toHaveLength(2);
  });

  it("does not expect a reception from a node on another channel", () => {
    const ledger = new TestRunLedger();
    const events = interleaved(senderEvents(), receiverEvents());
    const runFive = events.findIndex(
      ({ node, event }) => node === SENDER && event.ev === "run_start" && event.run === 5,
    );
    feed(ledger, events.slice(0, runFive));
    ledger.acceptEvent(
      RECEIVER,
      {
        t: 70000,
        ev: "radio",
        freq: 915.9,
        sf: 9,
        bw: 500,
        cr: 5,
        preamble: 8,
        sync: 18,
        power: 4,
        chip: -9,
        lna: "bypass",
      },
      SENDER_BOOT_HOST_TIME + 59000,
    );
    feed(ledger, events.slice(runFive));
    ledger.closeOverdueReceptions(RUN_5_DONE_HOST_TIME + 60_000);
    expect(ledger.findRun(SENDER, 5)?.receptions).toEqual([]);
  });

  it("builds rows from the receiver alone when the sender console is not connected", () => {
    const ledger = new TestRunLedger();
    feed(ledger, receiverEvents());
    expect(ledger.rows[0]).toEqual({
      ...RUN_3_ROW,
      sender_model: null,
      power: null,
      sent: null,
      toa_avg: null,
      duration: null,
      goodput: null,
    });
  });

  it("reports the progress of runs in course", () => {
    const ledger = new TestRunLedger();
    const events = interleaved(senderEvents(), receiverEvents());
    const lastPacket = events.findIndex(
      ({ event }) => event.ev === "tx" && event.run === 3 && event.index === 9,
    );
    feed(ledger, events.slice(0, lastPacket));
    expect(ledger.findRun(SENDER, 3)).toMatchObject({
      sender: SENDER,
      run: 3,
      senderModel: "V2",
      count: 10,
      size: 239,
      interval: 0,
      transmitted: 9,
      completion: null,
      settings: expect.objectContaining({ sf: 7, bw: 500, power: 2 }),
    });
    expect(ledger.findRun(SENDER, 3)?.receptions).toEqual([
      expect.objectContaining({
        receiver: RECEIVER,
        receiverModel: "V4.3",
        received: 8,
        outcome: "receiving",
        row: null,
      }),
    ]);
  });

  it("separates runs that reuse a number after the sender reboots", () => {
    const ledger = new TestRunLedger();
    feed(ledger, interleaved(senderEvents(), receiverEvents()));
    const reboot = SENDER_BOOT_HOST_TIME + 100_000;
    ledger.acceptEvent(
      SENDER,
      {
        t: 640,
        ev: "boot",
        id: SENDER,
        model: "V2",
        epoch: 8,
        firmware: "0.1.0",
        protocol: 1,
        key: "default",
      },
      reboot,
    );
    ledger.acceptEvent(
      SENDER,
      { t: 5000, ev: "run_start", run: 3, count: 2, size: 16, interval: 0 },
      reboot + 5000,
    );
    expect(ledger.runs.filter((run) => run.run === 3).map((run) => run.count)).toEqual([10, 2]);
    expect(ledger.findRow(SENDER, 3, RECEIVER)).toBeNull();
    expect(ledger.rows[0]).toEqual(RUN_3_ROW);
  });

  it("forgets the runs on clear and keeps working", () => {
    const ledger = new TestRunLedger();
    feed(ledger, interleaved(senderEvents(), receiverEvents()));
    const revision = ledger.revision;
    ledger.clear();
    expect(ledger.revision).toBeGreaterThan(revision);
    expect(ledger.rows).toEqual([]);
    expect(ledger.runs).toEqual([]);
  });
});

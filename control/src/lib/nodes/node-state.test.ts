import { describe, expect, it } from "vite-plus/test";
import {
  NODE_SESSION_LOG,
  RECEIVER_BOOT_HOST_TIME,
  RECEIVER_RUN_LOG,
  SENDER_BOOT_HOST_TIME,
  SENDER_RUN_LOG,
  UPDATE_ORIGIN_LOG,
  UPDATE_RECEIVER_LOG,
  UPDATE_VERSION,
  readFixtureEvents,
  type TimedConsoleEvent,
} from "$lib/testing/console-fixtures.ts";
import {
  INITIAL_NODE_STATE,
  applyConsoleEvent,
  estimateUptime,
  imageReceptionFraction,
  isBurstActive,
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
      protocolVersion: 2,
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
      availableVersion: 0,
      vmFault: null,
      vmFailing: false,
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

  it("follows the HELLO hold until a boot turns the HELLO back on", () => {
    expect(state.presence).toMatchObject({ state: "on", remaining: null });
    const held = applyConsoleEvent(
      state,
      { t: 1, ev: "presence", state: "off", remaining: 600 },
      5,
    );
    expect(held.presence).toEqual({ state: "off", remaining: 600, hostTime: 5 });
    const rebooted = applyConsoleEvent(
      held,
      {
        t: 1,
        ev: "boot",
        id: "3A7F",
        model: "V4.3",
        epoch: 13,
        firmware: "0.1.0",
        protocol: 2,
        key: "default",
        operator_key: "default",
      },
      9,
    );
    expect(rebooted.presence).toEqual({ state: "on", remaining: null, hostTime: 9 });
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
        protocol: 2,
        key: "default",
        operator_key: "default",
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

describe("applyConsoleEvent with the virtual machine", () => {
  const HOST_TIME = 1_759_840_000_000;
  const loaded = applyConsoleEvent(
    INITIAL_NODE_STATE,
    { t: 10, ev: "vm", version: 3, size: 21, tick: 0, registers: [1, 2, 3, 4] },
    HOST_TIME,
  );

  it("takes the program and the registers from vm", () => {
    expect(loaded.virtualMachine).toMatchObject({
      version: 3,
      size: 21,
      tick: 0,
      registers: [1, 2, 3, 4],
    });
  });

  it("updates the printed register and keeps the output", () => {
    const printed = applyConsoleEvent(
      loaded,
      { t: 20, ev: "vm_print", tick: 1, reg: 2, value: -6 },
      HOST_TIME + 10,
    );
    expect(printed.virtualMachine?.registers).toEqual([1, -6, 3, 4]);
    expect(printed.virtualMachine?.tick).toBe(1);
    expect(printed.virtualMachinePrints).toEqual([
      { hostTime: HOST_TIME + 10, tick: 1, register: 2, value: -6 },
    ]);
  });

  it("records the last fault", () => {
    const faulted = applyConsoleEvent(
      loaded,
      { t: 30, ev: "vm_fault", tick: 1, pc: 6, reason: "division_by_zero" },
      HOST_TIME + 20,
    );
    expect(faulted.lastVirtualMachineFault).toMatchObject({
      address: 6,
      reason: "division_by_zero",
    });
  });

  it("returns to the factory program after a boot", () => {
    const rebooted = applyConsoleEvent(
      loaded,
      {
        t: 5,
        ev: "boot",
        id: "3A7F",
        model: "V2",
        epoch: 2,
        firmware: "0.1.0",
        protocol: 2,
        key: "default",
        operator_key: "default",
      },
      HOST_TIME + 30,
    );
    expect(rebooted.virtualMachine).toMatchObject({ version: 0, size: 0, registers: [0, 0, 0, 0] });
  });
});

describe("applyConsoleEvent with an update", () => {
  const receiverEvents = readFixtureEvents(UPDATE_RECEIVER_LOG, RECEIVER_BOOT_HOST_TIME);
  const originEvents = readFixtureEvents(UPDATE_ORIGIN_LOG, SENDER_BOOT_HOST_TIME);
  const receiver = replay(receiverEvents);
  const origin = replay(originEvents);

  /** State of the receiver right after the first event that satisfies `isLast`. */
  function receiverUntil(isLast: (event: TimedConsoleEvent["event"]) => boolean): NodeState {
    const end = receiverEvents.findIndex(({ event }) => isLast(event));
    return replay(receiverEvents.slice(0, end + 1));
  }

  it("boots with version 0, no image and fragments of 231 bytes", () => {
    const booted = replay(receiverEvents.slice(0, 1));
    expect(booted).toMatchObject({
      operatorKey: "default",
      activeVersion: 0,
      availableVersion: 0,
      imageReception: null,
      transfer: {
        activeVersion: 0,
        availableVersion: 0,
        receivingVersion: null,
        fragmentSize: 231,
      },
    });
  });

  it("follows the reception fragment by fragment", () => {
    const afterThird = receiverUntil((event) => event.ev === "fragment_rx" && event.index === 3);
    expect(afterThird.imageReception).toMatchObject({
      version: UPDATE_VERSION,
      source: "5C21",
      fragmentSize: 32,
      fragmentCount: 4,
      heldFragments: [0, 2, 3],
      acceptedFragments: 3,
      newFragments: 3,
      reportsSent: 0,
    });
    expect(imageReceptionFraction(afterThird.imageReception!)).toBe(0.75);
    const afterReport = receiverUntil((event) => event.ev === "report_sent");
    expect(afterReport.imageReception).toMatchObject({
      heldFragments: [0, 2, 3],
      reportsSent: 1,
      firstReport: { peer: "5C21", missing: [1], round: 1, fragmentCount: 4 },
    });
  });

  it("closes the reception with the image and records it", () => {
    const completed = receiverUntil((event) => event.ev === "image");
    expect(completed.imageReception).toBeNull();
    expect(completed.availableVersion).toBe(UPDATE_VERSION);
    expect(completed.activeVersion).toBe(0);
    expect(receiver.images).toEqual([
      {
        hostTime: RECEIVER_BOOT_HOST_TIME + 60196,
        version: UPDATE_VERSION,
        programSize: 29,
        imageSize: 102,
        via: "radio",
        source: "5C21",
        fragments: 4,
        reports: 1,
        durationMilliseconds: 137,
      },
    ]);
  });

  it("counts the fragments of each burst", () => {
    expect(receiver.bursts).toEqual([
      {
        version: UPDATE_VERSION,
        fragmentSize: 32,
        count: 4,
        cause: "complete",
        trigger: null,
        startHostTime: RECEIVER_BOOT_HOST_TIME + 60217,
        transmitted: 4,
        completion: {
          sent: 4,
          durationMicroseconds: 99000,
          hostTime: RECEIVER_BOOT_HOST_TIME + 60316,
        },
      },
    ]);
    expect(origin.bursts.map((burst) => [burst.cause, burst.trigger, burst.transmitted])).toEqual([
      ["load", null, 4],
      ["report", "3A7F", 1],
    ]);
    expect(isBurstActive(origin)).toBe(false);
    const sending = replay(
      originEvents.slice(
        0,
        originEvents.findIndex(({ event }) => event.ev === "burst_done"),
      ),
    );
    expect(isBurstActive(sending)).toBe(true);
  });

  it("records the reports it receives and the fragments it ignores", () => {
    expect(origin.reportsReceived).toEqual([
      {
        hostTime: SENDER_BOOT_HOST_TIME + 50164,
        peer: "3A7F",
        version: UPDATE_VERSION,
        fragmentSize: 32,
        fragmentCount: 4,
        missing: [1],
        round: null,
      },
    ]);
    expect(origin.ignoredFragmentCount).toBe(4);
    expect(origin.imageReception).toBeNull();
  });

  it("activates with the HELLO of the origin", () => {
    expect(receiver.activeVersion).toBe(UPDATE_VERSION);
    expect(receiver.activations).toEqual([
      {
        hostTime: RECEIVER_BOOT_HOST_TIME + 80022,
        version: UPDATE_VERSION,
        previous: 0,
        cause: "hello",
        source: "5C21",
      },
    ]);
    expect(origin.activations[0]).toMatchObject({ cause: "console", source: null });
  });

  it("learns the versions of the neighbors from their HELLO", () => {
    const beforeActivation = receiverUntil(
      (event) => event.ev === "hello" && event.available === UPDATE_VERSION,
    );
    expect(beforeActivation.neighbors[0]).toMatchObject({
      id: "5C21",
      version: 0,
      availableVersion: UPDATE_VERSION,
    });
    expect(origin.neighbors[0]).toMatchObject({
      id: "3A7F",
      version: UPDATE_VERSION,
      availableVersion: UPDATE_VERSION,
      vmFault: null,
      vmFailing: false,
    });
  });

  it("keeps the active program and the transfer state", () => {
    expect(receiver.program).toEqual({
      hostTime: RECEIVER_BOOT_HOST_TIME + 90001,
      version: UPDATE_VERSION,
      size: 29,
      code: "020105000000020203000000110102010112010a000000150102010100",
    });
    expect(receiver.transfer).toEqual({
      activeVersion: UPDATE_VERSION,
      availableVersion: UPDATE_VERSION,
      receivingVersion: null,
      missingBytes: null,
      fragmentSize: 231,
      hostTime: RECEIVER_BOOT_HOST_TIME + 91002,
    });
    expect(origin.transfer?.fragmentSize).toBe(32);
  });

  it("drops a reception whose image fails the verification", () => {
    expect(receiver.imageReception).toBeNull();
    expect(receiver.imageRejections).toEqual([
      {
        hostTime: RECEIVER_BOOT_HOST_TIME + 95002,
        version: UPDATE_VERSION + 100,
        reason: "signature",
        source: "9B04",
      },
    ]);
    expect(receiver.availableVersion).toBe(UPDATE_VERSION);
  });

  it("starts a new reception when a newer version arrives and forgets the old one on boot", () => {
    const fragment = (version: number, index: number, t: number) =>
      applyConsoleEvent(
        receiverUntil((event) => event.ev === "image"),
        {
          t,
          ev: "fragment_rx",
          src: "9B04",
          version,
          index,
          count: 2,
          size: 231,
          remaining: 1 - index,
          accepted: true,
          new: true,
          rssi: -90,
          snr: 1,
        },
        RECEIVER_BOOT_HOST_TIME + t,
      );
    const newer = fragment(UPDATE_VERSION + 7, 0, 70000);
    expect(newer.imageReception).toMatchObject({ version: UPDATE_VERSION + 7, heldFragments: [0] });
    const loaded = applyConsoleEvent(
      newer,
      {
        t: 70100,
        ev: "image",
        version: UPDATE_VERSION + 9,
        size: 29,
        image_size: 102,
        via: "console",
        src: null,
        fragments: 0,
        reports: 0,
        duration: 0,
      },
      RECEIVER_BOOT_HOST_TIME + 70100,
    );
    expect(loaded.imageReception).toBeNull();
    expect(loaded.availableVersion).toBe(UPDATE_VERSION + 9);
    const rebooted = applyConsoleEvent(
      newer,
      {
        t: 5,
        ev: "boot",
        id: "3A7F",
        model: "V4.3",
        epoch: 13,
        firmware: "0.1.0",
        protocol: 2,
        key: "default",
        operator_key: "custom",
      },
      RECEIVER_BOOT_HOST_TIME + 80000,
    );
    expect(rebooted).toMatchObject({
      operatorKey: "custom",
      activeVersion: 0,
      availableVersion: 0,
      imageReception: null,
      program: null,
    });
  });

  it("records the faults since the last activation", () => {
    const faulted = applyConsoleEvent(
      receiver,
      { t: 100000, ev: "vm_fault", tick: 3, pc: 6, reason: "division_by_zero" },
      RECEIVER_BOOT_HOST_TIME + 100000,
    );
    expect(faulted.faultSinceActivation).toBe("division_by_zero");
    const reactivated = applyConsoleEvent(
      faulted,
      {
        t: 100100,
        ev: "activation",
        version: UPDATE_VERSION + 1,
        previous: UPDATE_VERSION,
        cause: "console",
        src: null,
      },
      RECEIVER_BOOT_HOST_TIME + 100100,
    );
    expect(reactivated.faultSinceActivation).toBeNull();
    expect(reactivated.lastVirtualMachineFault?.reason).toBe("division_by_zero");
  });
});

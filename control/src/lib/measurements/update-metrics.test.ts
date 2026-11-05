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
import { TEST_VECTOR_IMAGE } from "$lib/testing/image-test-vector.ts";
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import type { NodeConsoleEvent } from "./event-journal.ts";
import {
  acceptLoadImage,
  computeUpdateMetrics,
  nodeConsoleEventsOf,
  parseUpdateCommand,
  updateCommandTimesOf,
  type UpdateCommandRecord,
} from "./update-metrics.ts";

const S = SENDER_BOOT_HOST_TIME;

const originEvents = nodeConsoleEventsOf(
  "5C21",
  readFixtureEvents(UPDATE_ORIGIN_LOG, SENDER_BOOT_HOST_TIME),
);
const receiverEvents = nodeConsoleEventsOf(
  "3A7F",
  readFixtureEvents(UPDATE_RECEIVER_LOG, RECEIVER_BOOT_HOST_TIME),
);

function measure(
  events: readonly NodeConsoleEvent[],
  activate: number | null = UPDATE_ACTIVATE_HOST_TIME,
) {
  return computeUpdateMetrics({
    version: UPDATE_VERSION,
    loadHostTime: UPDATE_LOAD_HOST_TIME,
    activateHostTime: activate,
    events,
  });
}

describe("computeUpdateMetrics with both consoles", () => {
  const metrics = measure([...receiverEvents, ...originEvents]);

  it("takes the graph from the events and the origin from the console load", () => {
    expect(metrics.nodes).toEqual(["3A7F", "5C21"]);
    expect(metrics.origin).toBe("5C21");
  });

  it("measures M1 and its distribution and activation phases", () => {
    expect(metrics.convergence.distribution).toEqual({
      startHostTime: UPDATE_LOAD_HOST_TIME,
      endHostTime: S + 50_195,
      milliseconds: 195,
      pendingNodes: [],
    });
    expect(metrics.convergence.total).toMatchObject({
      endHostTime: S + 70_021,
      milliseconds: 20_021,
    });
    expect(metrics.convergence.activation).toMatchObject({
      startHostTime: UPDATE_ACTIVATE_HOST_TIME,
      milliseconds: 21,
    });
    expect(metrics.convergence.nodes).toEqual([
      { id: "3A7F", availableHostTime: S + 50_195, activeHostTime: S + 70_021 },
      { id: "5C21", availableHostTime: S + 50_010, activeHostTime: S + 70_005 },
    ]);
  });

  it("measures M2 from the HELLO counters", () => {
    const { efficiency } = metrics;
    expect(efficiency.nodes).toEqual([
      {
        id: "3A7F",
        startCount: 9,
        startHostTime: S + 46_000,
        startsAfterLoad: false,
        endCount: 17,
        endHostTime: S + 70_041,
        transmitted: 8,
      },
      {
        id: "5C21",
        startCount: 8,
        startHostTime: S + 44_000,
        startsAfterLoad: false,
        endCount: 16,
        endHostTime: S + 70_021,
        transmitted: 8,
      },
    ]);
    expect(efficiency).toMatchObject({ transmitted: 16, fragmentCount: 4, minimum: 4, ratio: 4 });
    expect(efficiency.transferFrames).toEqual({
      fragments: 9,
      reports: 1,
      countedNodes: ["3A7F", "5C21"],
      complete: true,
    });
  });

  it("measures M3 for the receiver", () => {
    expect(metrics.receivers).toEqual([
      {
        id: "3A7F",
        connected: true,
        firstReport: {
          hostTime: S + 50_131,
          fragmentCount: 4,
          missing: [1],
          seenAs: "report_sent",
        },
        missingPercent: 25,
        repairRounds: 1,
        observedReports: 1,
        image: { hostTime: S + 50_195, fragments: 4, reports: 1, durationMilliseconds: 137 },
      },
    ]);
  });
});

describe("computeUpdateMetrics with the origin console only", () => {
  const metrics = measure(originEvents);

  it("relies on the HELLO of the receiver", () => {
    expect(metrics.convergence.distribution.milliseconds).toBe(216);
    expect(metrics.convergence.total.milliseconds).toBe(20_041);
    expect(metrics.efficiency.transferFrames).toMatchObject({
      fragments: 5,
      reports: 0,
      complete: false,
    });
  });

  it("takes the first report from the report the origin received", () => {
    expect(metrics.receivers).toEqual([
      {
        id: "3A7F",
        connected: false,
        firstReport: {
          hostTime: S + 50_164,
          fragmentCount: 4,
          missing: [1],
          seenAs: "report_received",
        },
        missingPercent: 25,
        repairRounds: null,
        observedReports: 1,
        image: null,
      },
    ]);
  });
});

describe("computeUpdateMetrics before the update ends", () => {
  it("names the nodes the phases still wait for", () => {
    const until = S + 50_100;
    const metrics = measure(
      [...originEvents, ...receiverEvents].filter((entry) => entry.hostTime <= until),
      null,
    );
    expect(metrics.convergence.distribution).toMatchObject({
      endHostTime: null,
      milliseconds: null,
      pendingNodes: ["3A7F"],
    });
    expect(metrics.convergence.total.pendingNodes).toEqual(["3A7F", "5C21"]);
    expect(metrics.convergence.activation).toBeNull();
    expect(metrics.receivers[0]).toMatchObject({ firstReport: null, missingPercent: null });
  });

  it("counts a node whose version is never heard as pending", () => {
    const metrics = computeUpdateMetrics({
      version: UPDATE_VERSION,
      loadHostTime: UPDATE_LOAD_HOST_TIME,
      activateHostTime: UPDATE_ACTIVATE_HOST_TIME,
      events: [...originEvents, ...receiverEvents],
      nodes: ["3A7F", "5C21", "9B04"],
    });
    expect(metrics.convergence.total).toMatchObject({ endHostTime: null, pendingNodes: ["9B04"] });
    expect(metrics.efficiency).toMatchObject({ transmitted: null, minimum: 8, ratio: null });
    expect(metrics.receivers.map((receiver) => receiver.id)).toEqual(["3A7F", "9B04"]);
  });
});

describe("computeUpdateMetrics edge cases", () => {
  function event(node: string, hostTime: number, value: ConsoleEvent): NodeConsoleEvent {
    return { node, hostTime, event: value };
  }

  function hello(
    src: string,
    t: number,
    version: number,
    available: number,
    tx: number,
    epoch = 1,
    neighbors: readonly string[] = [],
  ): ConsoleEvent {
    return {
      t,
      ev: "hello",
      src,
      epoch,
      seq: tx,
      model: "V2",
      version,
      available,
      vm_fault: null,
      vm_failing: false,
      tx,
      rssi: -50,
      snr: 8,
      ferr: 0,
      neighbors: neighbors.map((id) => ({ id, rssi: -50, snr: 8 })),
    };
  }

  function neighbor(
    id: string,
    t: number,
    version: number,
    available: number,
    tx: number,
    age: number,
  ): ConsoleEvent {
    return {
      t,
      ev: "neighbor",
      id,
      model: "V2",
      version,
      available,
      vm_fault: null,
      vm_failing: false,
      tx,
      rssi: -50,
      snr: 8,
      age,
    };
  }

  function status(id: string, t: number, tx: number, epoch = 1): ConsoleEvent {
    return { t, ev: "status", id, model: "V2", epoch, tx, rx: 0, dropped: 0, heap: 200000 };
  }

  it("adds the packets of a node that rebooted during the update", () => {
    const metrics = computeUpdateMetrics({
      version: 9,
      loadHostTime: 1000,
      activateHostTime: null,
      fragmentCount: 5,
      nodes: ["0001", "0002"],
      events: [
        event("0001", 500, hello("0002", 500, 0, 0, 40)),
        event("0001", 2000, hello("0002", 2000, 0, 0, 45)),
        // 0002 reboots: its epoch grows and its counter starts again.
        event("0001", 3000, hello("0002", 3000, 0, 0, 3, 2)),
        event("0001", 4000, hello("0002", 4000, 9, 9, 10, 2)),
      ],
    });
    expect(metrics.efficiency.nodes.find((node) => node.id === "0002")).toMatchObject({
      startCount: 40,
      endCount: 10,
      transmitted: 15,
    });
  });

  it("ignores a stale neighbor counter that arrives after a fresher status", () => {
    const metrics = computeUpdateMetrics({
      version: 9,
      loadHostTime: 1000,
      activateHostTime: null,
      fragmentCount: 5,
      nodes: ["000A", "000C"],
      events: [
        event("000C", 500, hello("000A", 500, 0, 0, 100)),
        event("000C", 900, hello("000A", 900, 0, 0, 160)),
        event("000A", 2000, status("000A", 2000, 200)),
        // The table of 000C still holds the counter of the HELLO at 900.
        event("000C", 2010, neighbor("000A", 2010, 0, 0, 160, 1110)),
        event("000C", 3000, hello("000A", 3000, 9, 9, 210)),
      ],
    });
    expect(metrics.efficiency.nodes.find((node) => node.id === "000A")).toMatchObject({
      startCount: 160,
      endCount: 210,
      transmitted: 50,
    });
  });

  it("ignores an older HELLO counter that a second console reports", () => {
    const metrics = computeUpdateMetrics({
      version: 9,
      loadHostTime: 1000,
      activateHostTime: null,
      fragmentCount: 5,
      nodes: ["000A", "000B", "000C"],
      events: [
        event("000B", 900, hello("000A", 900, 0, 0, 100)),
        event("000B", 2000, hello("000A", 2000, 0, 0, 140)),
        // 000C missed the HELLO at 2000 and reports the one before it.
        event("000C", 2100, neighbor("000A", 2100, 0, 0, 100, 1200)),
        event("000B", 3000, hello("000A", 3000, 9, 9, 150)),
      ],
    });
    expect(metrics.efficiency.nodes.find((node) => node.id === "000A")).toMatchObject({
      transmitted: 50,
    });
  });

  it("does not let a stale neighbor entry undo a fresher activation", () => {
    const metrics = computeUpdateMetrics({
      version: 9,
      loadHostTime: 1000,
      activateHostTime: 2000,
      nodes: ["000A", "000C"],
      events: [
        event("000C", 1500, hello("000A", 1500, 0, 9, 10)),
        event("000C", 1500, hello("000C", 1500, 0, 9, 10)),
        event("000C", 2100, hello("000A", 2100, 9, 9, 12)),
        // The entry dates from the HELLO at 1500, before the activation.
        event("000C", 2200, neighbor("000A", 2200, 0, 9, 10, 700)),
        event("000C", 2300, hello("000C", 2300, 9, 9, 12)),
      ],
    });
    expect(metrics.convergence.total.endHostTime).toBe(2300);
  });

  it("keeps a finished update closed when a node appears afterwards", () => {
    const events = [
      event("000A", 1000, hello("000B", 1000, 0, 0, 1, 1, ["000A"])),
      event("000B", 1100, hello("000A", 1100, 0, 9, 2, 1, ["000B"])),
      event("000A", 1500, hello("000B", 1500, 0, 9, 3, 1, ["000A"])),
      event("000B", 2000, hello("000A", 2000, 9, 9, 4, 1, ["000B"])),
      event("000A", 2100, hello("000B", 2100, 9, 9, 5, 1, ["000A"])),
      // 000D shows up later and only ever receives version 10.
      event("000A", 9000, hello("000B", 9000, 9, 9, 6, 1, ["000A", "000D"])),
      event("000B", 9100, hello("000D", 9100, 0, 10, 1, 1, ["000B"])),
    ];
    const metrics = computeUpdateMetrics({
      version: 9,
      loadHostTime: 1000,
      activateHostTime: null,
      events,
    });
    expect(metrics.nodes).toEqual(["000A", "000B"]);
    expect(metrics.convergence.total).toMatchObject({
      endHostTime: 2100,
      milliseconds: 1100,
      pendingNodes: [],
    });
  });

  it("leaves out the events after the next update and the nodes that expired", () => {
    const metrics = computeUpdateMetrics({
      version: 9,
      loadHostTime: 1000,
      activateHostTime: null,
      endHostTime: 100_000,
      events: [
        event("000A", 1000, hello("000E", 1000, 0, 0, 1, 1, ["000A"])),
        event("000A", 1100, hello("000B", 1100, 0, 9, 1, 1, ["000A"])),
        event("000B", 1200, hello("000A", 1200, 0, 9, 1, 1, ["000B"])),
        event("000B", 80_000, hello("000A", 80_000, 9, 9, 2, 1, ["000B"])),
        event("000A", 80_100, hello("000B", 80_100, 9, 9, 2, 1, ["000A"])),
        event("000A", 100_000, hello("000B", 100_000, 0, 10, 3, 1, ["000A"])),
      ],
    });
    // 000E was last heard more than a minute before the convergence.
    expect(metrics.nodes).toEqual(["000A", "000B"]);
    expect(metrics.convergence.total.endHostTime).toBe(80_100);
    expect(metrics.convergence.nodes.find((node) => node.id === "000B")?.activeHostTime).toBe(
      80_100,
    );
  });

  it("counts no loss for a receiver whose image needed no report", () => {
    const metrics = computeUpdateMetrics({
      version: 9,
      loadHostTime: 1000,
      activateHostTime: null,
      nodes: ["0001", "0002"],
      events: [
        event("0001", 1001, {
          t: 1,
          ev: "image",
          version: 9,
          size: 20,
          image_size: 93,
          via: "console",
          src: null,
          fragments: 0,
          reports: 0,
          duration: 0,
        }),
        event("0002", 1100, {
          t: 1,
          ev: "image",
          version: 9,
          size: 20,
          image_size: 93,
          via: "radio",
          src: "0001",
          fragments: 1,
          reports: 0,
          duration: 12,
        }),
      ],
    });
    expect(metrics.origin).toBe("0001");
    expect(metrics.receivers).toEqual([
      expect.objectContaining({
        id: "0002",
        missingPercent: 0,
        repairRounds: 0,
        firstReport: null,
      }),
    ]);
    expect(metrics.convergence.distribution.milliseconds).toBe(100);
  });
});

describe("update commands", () => {
  it("reads the version of load_image and activate", () => {
    expect(parseUpdateCommand(`load_image ${TEST_VECTOR_IMAGE}`)).toEqual({
      kind: "load_image",
      version: UPDATE_VERSION,
    });
    expect(parseUpdateCommand("activate 1762300800")).toEqual({
      kind: "activate",
      version: UPDATE_VERSION,
    });
    expect(parseUpdateCommand("activate")).toBeNull();
    expect(parseUpdateCommand("load_image 4a35")).toBeNull();
    expect(parseUpdateCommand("status")).toBeNull();
  });

  const record = (
    hostTime: number,
    command: UpdateCommandRecord["command"],
    accepted?: boolean,
    connectionKey = "usb-1",
  ): UpdateCommandRecord => ({
    connectionKey,
    node: "5C21",
    hostTime,
    command,
    ...(accepted === undefined ? {} : { accepted }),
  });

  it("finds the first accepted load of a version and the first activation after it", () => {
    const commands = [
      record(10, { kind: "activate", version: 7 }),
      record(20, { kind: "load_image", version: 7 }, true),
      record(25, { kind: "load_image", version: 7 }),
      record(30, { kind: "activate", version: 7 }),
      record(40, { kind: "activate", version: 7 }),
      record(50, { kind: "load_image", version: 8 }),
      record(60, { kind: "load_image", version: 9 }, true),
    ];
    expect(updateCommandTimesOf(commands, 7)).toEqual({
      loadHostTime: 20,
      activateHostTime: 30,
      endHostTime: 60,
    });
    expect(updateCommandTimesOf(commands, 8)).toBeNull();
  });

  it("marks the load that the image event of the console answers", () => {
    const commands = [
      record(10, { kind: "load_image", version: 7 }, undefined, "usb-1"),
      record(20, { kind: "load_image", version: 7 }, undefined, "ws-1"),
    ];
    // usb-1 answered `error invalid_image signature`; ws-1 answered with its `image` event.
    expect(acceptLoadImage(commands, "usb-1", 8, 15)).toBe(commands);
    const accepted = acceptLoadImage(commands, "ws-1", 7, 21);
    expect(accepted.map((command) => command.accepted === true)).toEqual([false, true]);
    expect(updateCommandTimesOf(accepted, 7)).toMatchObject({ loadHostTime: 20 });
    expect(updateCommandTimesOf(commands, 7)).toBeNull();
  });
});

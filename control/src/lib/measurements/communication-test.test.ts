import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_RADIO_SETTINGS } from "$lib/protocol/protocol-contract.ts";
import {
  CommunicationTest,
  presenceHoldSecondsFor,
  validateCommunicationTestConfiguration,
  type CommunicationTestConfiguration,
  type CommunicationTestSnapshot,
} from "./communication-test.ts";
import { CommunicationReceiver } from "./communication-receiver.ts";
import { computeCommunicationTestMetrics, nominalBitRateOf } from "./communication-test-metrics.ts";
import type { EchoResult } from "$lib/nodes/echo-records.ts";
import type { NodePort } from "$lib/nodes/node-port.ts";
import { type RadioSettings } from "$lib/radio/radio-settings.ts";
import {
  createSimulatedPair,
  type SimulatedNode,
  type SimulatedNodeBehavior,
} from "$lib/testing/simulated-node.ts";
import { ManualTimeSource, flushAsyncWork } from "$lib/testing/manual-time-source.ts";

const START_TIME = 1_759_850_000_000;

const DEFAULT_RADIO: RadioSettings = { ...DEFAULT_RADIO_SETTINGS, chip: 4, lna: null };
const TEST_MODULATION = { sf: 9, bw: 500, cr: 6 } as const;

interface Scenario {
  readonly clock: ManualTimeSource;
  readonly sender: SimulatedNode;
  readonly receiverNode: SimulatedNode;
  readonly test: CommunicationTest;
}

function createScenario(
  configuration: Partial<CommunicationTestConfiguration>,
  senderBehavior: SimulatedNodeBehavior = {},
  receiverBehavior: SimulatedNodeBehavior = {},
  onChange?: (snapshot: CommunicationTestSnapshot, test: CommunicationTest) => void,
): Scenario {
  const clock = new ManualTimeSource(START_TIME);
  const { sender, receiver: receiverNode } = createSimulatedPair(
    clock,
    senderBehavior,
    receiverBehavior,
  );
  const test: CommunicationTest = new CommunicationTest({
    node: sender,
    radio: DEFAULT_RADIO,
    destination: receiverNode.identifier.toLowerCase(),
    configuration: { ...TEST_MODULATION, count: 10, ...configuration },
    timeSource: clock,
    onChange: (snapshot) => onChange?.(snapshot, test),
  });
  return { clock, sender, receiverNode, test };
}

/** The operator of the neighbor activates receiver mode, the sender runs, then it deactivates. */
async function runWithReceiver(scenario: Scenario) {
  const { clock, receiverNode, test } = scenario;
  const receiver = new CommunicationReceiver({
    node: receiverNode,
    radio: { ...DEFAULT_RADIO, chip: -9, lna: "bypass" },
    modulation: TEST_MODULATION,
    timeSource: clock,
  });
  await clock.advanceUntilSettled(receiver.activate());
  const snapshot = await clock.advanceUntilSettled(test.run());
  const receiverSnapshot = await clock.advanceUntilSettled(receiver.deactivate());
  return { snapshot, receiverSnapshot };
}

describe("CommunicationTest", () => {
  it("measures against a neighbor in receiver mode and leaves both nodes as they were", async () => {
    const scenario = createScenario({});
    const { sender, receiverNode } = scenario;
    const { snapshot, receiverSnapshot } = await runWithReceiver(scenario);

    expect(snapshot.status).toBe("finished");
    expect(snapshot.responder).toBe("3A7F");
    expect(snapshot.restored).toBe(true);
    expect(snapshot.exchanges).toHaveLength(10);
    expect(snapshot.exchanges.every((exchange) => exchange.outcome === "answered")).toBe(true);
    expect(sender.commands).toEqual([
      `presence off ${presenceHoldSecondsFor({ ...TEST_MODULATION, count: 10 }, 8)}`,
      "radio sf 9 bw 500 cr 6",
      ...Array.from({ length: 10 }, () => "echo 3A7F 4"),
      "radio sf 7 bw 500 cr 5",
      "presence on",
    ]);

    expect(receiverSnapshot.status).toBe("inactive");
    expect(receiverSnapshot.restored).toBe(true);
    expect(receiverSnapshot.servedEchoes).toHaveLength(10);
    expect(receiverSnapshot.servedEchoes[0]).toMatchObject({ source: "5C21", number: 1, size: 4 });
    expect(receiverNode.commands).toEqual([
      "presence off 3600",
      "radio sf 9 bw 500 cr 6",
      "radio sf 7 bw 500 cr 5",
      "presence on",
    ]);

    for (const node of [sender, receiverNode]) {
      expect(node.modulation).toEqual({ sf: 7, bw: 500, cr: 5 });
      expect(node.presenceHoldSeconds).toBeNull();
    }
  });

  it("records the lost echoes and the quality in both directions", async () => {
    const scenario = createScenario({}, {}, { losesEchoRequest: (number) => number % 5 === 0 });
    const { snapshot, receiverSnapshot } = await runWithReceiver(scenario);
    const metrics = computeCommunicationTestMetrics(snapshot);

    expect(metrics.requested).toBe(10);
    expect(metrics.answered).toBe(8);
    expect(metrics.lost).toBe(2);
    expect(metrics.deliveryRatio).toBe(0.8);
    expect(metrics.forward.rssi.minimum).toBe(-62);
    expect(metrics.forward.rssi.maximum).toBe(-60);
    expect(metrics.reverse.snr.average).toBe(6.5);
    // 8 answered echoes, 4 bytes each way.
    expect(metrics.usefulBits).toBe(8 * 2 * 4 * 8);
    expect(metrics.frameLength).toBe(20);
    expect(metrics.usefulShare).toBe(0.2);
    expect(receiverSnapshot.servedEchoes).toHaveLength(8);
  });

  it("loses every echo when the neighbor is not in receiver mode, and still restores", async () => {
    const { clock, sender, test } = createScenario({ count: 3 });
    const snapshot = await clock.advanceUntilSettled(test.run());

    expect(snapshot.status).toBe("finished");
    expect(computeCommunicationTestMetrics(snapshot).deliveryRatio).toBe(0);
    expect(snapshot.restored).toBe(true);
    expect(sender.modulation).toEqual({ sf: 7, bw: 500, cr: 5 });
  });

  it("counts in its progress the echoes that got no result in time", async () => {
    const clock = new ManualTimeSource(START_TIME);
    const { sender } = createSimulatedPair(clock);
    // The console of the sender loses every echo_lost, so no echo gets a result.
    const port: NodePort = {
      identifier: sender.identifier,
      sendCommand: (command) => sender.sendCommand(command),
      subscribe: (listener) =>
        sender.subscribe((event, hostTime) => {
          if (event.ev !== "echo_lost") {
            listener(event, hostTime);
          }
        }),
    };
    const progress: number[] = [];
    const test = new CommunicationTest({
      node: port,
      radio: DEFAULT_RADIO,
      destination: "3A7F",
      configuration: { ...TEST_MODULATION, count: 2 },
      timeSource: clock,
      onChange: (snapshot) => progress.push(snapshot.progress),
    });
    const snapshot = await clock.advanceUntilSettled(test.run());

    expect(snapshot.exchanges).toEqual([]);
    expect(snapshot.progress).toBe(1);
    expect(progress).toContain(0.5);
  });

  it("stops after the echo in course and still restores the node", async () => {
    const scenario = createScenario({ count: 50 }, {}, {}, (snapshot, running) => {
      if (snapshot.exchanges.length === 3) {
        running.stop();
      }
    });
    const { snapshot } = await runWithReceiver(scenario);

    expect(snapshot.status).toBe("stopped");
    expect(snapshot.exchanges).toHaveLength(3);
    expect(snapshot.restored).toBe(true);
    expect(scenario.sender.modulation).toEqual({ sf: 7, bw: 500, cr: 5 });
  });

  it("stops during the wait that follows the modulation, before any echo", async () => {
    const { clock, sender, test } = createScenario({});
    const finished = test.run();
    await flushAsyncWork();
    expect(sender.commands).toContain("radio sf 9 bw 500 cr 6");
    test.stop();
    const snapshot = await clock.advanceUntilSettled(finished);

    expect(snapshot.status).toBe("stopped");
    expect(snapshot.failure).toBeNull();
    expect(sender.commands.some((command) => command.startsWith("echo"))).toBe(false);
    expect(snapshot.restored).toBe(true);
  });

  it("fails without echoes when the node refuses to hold its HELLO", async () => {
    const { clock, sender, test } = createScenario({}, { presenceRefusal: "unknown_command" });
    const snapshot = await clock.advanceUntilSettled(test.run());

    expect(snapshot.status).toBe("failed");
    expect(snapshot.failure).toContain("unknown_command");
    expect(snapshot.exchanges).toHaveLength(0);
    expect(sender.commands.some((command) => command.startsWith("echo"))).toBe(false);
    expect(sender.modulation).toEqual({ sf: 7, bw: 500, cr: 5 });
    expect(snapshot.restored).toBe(false);
  });
});

describe("validateCommunicationTestConfiguration", () => {
  it("accepts the default test and rejects counts out of range", () => {
    expect(
      validateCommunicationTestConfiguration({ sf: 7, bw: 500, cr: 5, count: 100 }, 8),
    ).toEqual([]);
    expect(
      validateCommunicationTestConfiguration({ sf: 7, bw: 500, cr: 5, count: 0 }, 8),
    ).toHaveLength(1);
  });

  it("rejects a test whose worst case outlasts the longest HELLO hold", () => {
    expect(
      validateCommunicationTestConfiguration({ sf: 12, bw: 125, cr: 8, count: 1000 }, 8),
    ).toHaveLength(1);
  });
});

type AnsweredEcho = Extract<EchoResult, { outcome: "answered" }>;
type LostEcho = Extract<EchoResult, { outcome: "lost" }>;

function answered(fields: Partial<AnsweredEcho>): AnsweredEcho {
  return {
    outcome: "answered",
    hostTime: 0,
    destination: "3A7F",
    number: 1,
    size: 4,
    roundTripMicroseconds: 8000,
    rssi: -42,
    snr: 8,
    remoteRssi: -40,
    remoteSnr: 9,
    ...fields,
  };
}

function lost(fields: Partial<LostEcho>): LostEcho {
  return {
    outcome: "lost",
    hostTime: 0,
    destination: "3A7F",
    number: 1,
    size: 4,
    timeoutMilliseconds: 1020,
    ...fields,
  };
}

describe("communication test metrics", () => {
  it("computes the nominal bit rate of a modulation", () => {
    expect(nominalBitRateOf({ sf: 7, bw: 500, cr: 5 })).toBe(21875);
    expect(nominalBitRateOf({ sf: 12, bw: 125, cr: 8 })).toBeCloseTo(183.1, 1);
  });

  it("divides the useful bits by the round-trip times", () => {
    const metrics = computeCommunicationTestMetrics({
      settings: { freq: 915.9, preamble: 8, sync: 18, sf: 7, bw: 500, cr: 5, size: 4, count: 2 },
      exchanges: [
        answered({ number: 1, hostTime: 0, roundTripMicroseconds: 8000, rssi: -42, snr: 8 }),
        lost({ number: 2, hostTime: 1 }),
      ],
    });
    // 64 useful bits in 8 ms.
    expect(metrics.usefulBits).toBe(64);
    expect(metrics.usefulBitRate).toBe(8000);
    expect(metrics.roundTrip.average).toBe(8000);
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  CapacityTestCampaign,
  type CampaignSnapshot,
  type CapacityTestCampaignOptions,
} from "./capacity-test-campaign.ts";
import {
  DEFAULT_CAPACITY_TEST_CONFIGURATION,
  buildCapacityTestPlan,
  estimatePlanDurationMilliseconds,
  type CapacityTestConfiguration,
} from "./capacity-test-plan.ts";
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import { createSimulatedPair, type SimulatedNodeBehavior } from "$lib/testing/simulated-node.ts";
import { TestRunLedger } from "./test-run-ledger.ts";
import { ManualTimeSource } from "$lib/utils/time-source.ts";

const START_TIME = 1_759_850_000_000;

/** Lets every pending promise continuation run. */
function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Runs the campaign, moving the manual clock forward whenever it waits for a timer. */
async function runToEnd(
  campaign: CapacityTestCampaign,
  clock: ManualTimeSource,
): Promise<CampaignSnapshot> {
  let settled = false;
  const result = campaign.run().finally(() => {
    settled = true;
  });
  for (let step = 0; step < 10_000 && !settled; step += 1) {
    await flushAsyncWork();
    if (!settled) {
      clock.advanceBy(250);
    }
  }
  return result;
}

interface Scenario {
  readonly clock: ManualTimeSource;
  readonly sender: ReturnType<typeof createSimulatedPair>["sender"];
  readonly receiver: ReturnType<typeof createSimulatedPair>["receiver"];
  readonly campaign: CapacityTestCampaign;
  readonly silentReceptions: [NodeIdentifier, number, NodeIdentifier][];
  readonly snapshots: CampaignSnapshot[];
}

function createScenario(
  configuration: Partial<CapacityTestConfiguration>,
  senderBehavior: SimulatedNodeBehavior = {},
  receiverBehavior: SimulatedNodeBehavior = {},
  options: Partial<CapacityTestCampaignOptions> = {},
): Scenario {
  const clock = new ManualTimeSource(START_TIME);
  const { sender, receiver } = createSimulatedPair(clock, senderBehavior, receiverBehavior);
  const silentReceptions: [NodeIdentifier, number, NodeIdentifier][] = [];
  const snapshots: CampaignSnapshot[] = [];
  const campaign = new CapacityTestCampaign({
    sender,
    receiver,
    points: buildCapacityTestPlan({ ...DEFAULT_CAPACITY_TEST_CONFIGURATION, ...configuration }),
    timeSource: clock,
    onChange: (snapshot) => snapshots.push(snapshot),
    onSilentReception: (...arguments_) => silentReceptions.push(arguments_),
    ...options,
  });
  return { clock, sender, receiver, campaign, silentReceptions, snapshots };
}

describe("CapacityTestCampaign", () => {
  it("measures every point of the default plan", async () => {
    const { campaign, sender, receiver } = createScenario({});
    const snapshot = await campaign.run();

    expect(snapshot.status).toBe("finished");
    expect(snapshot.finishedCount).toBe(6);
    expect(snapshot.progress).toBe(1);
    expect(snapshot.estimatedRemainingMilliseconds).toBe(0);
    expect(
      snapshot.results.map((result) => [
        result.point.sf,
        result.status,
        result.run,
        result.received,
      ]),
    ).toEqual([
      [7, "completed", 1, 300],
      [8, "completed", 2, 300],
      [9, "completed", 3, 300],
      [10, "completed", 4, 300],
      [11, "completed", 5, 300],
      [12, "completed", 6, 300],
    ]);
    expect(sender.commands.slice(0, 2)).toEqual([
      "radio freq 915.9 sf 7 bw 500 cr 5 preamble 8 sync 18",
      "run 300 239 0",
    ]);
    expect(receiver.commands).toEqual(
      [7, 8, 9, 10, 11, 12].map((sf) => `radio freq 915.9 sf ${sf} bw 500 cr 5 preamble 8 sync 18`),
    );
    expect(sender.commands.filter((command) => command.startsWith("run"))).toHaveLength(6);
  });

  it("feeds a ledger that yields one summary row per point", async () => {
    const { campaign, sender, receiver } = createScenario(
      { spreadingFactors: [7, 9], packetCount: 20 },
      {},
      { losesPacket: (_run, index) => index === 3 },
    );
    const ledger = new TestRunLedger();
    sender.subscribe((event, hostTime) => ledger.acceptEvent(sender.identifier, event, hostTime));
    receiver.subscribe((event, hostTime) =>
      ledger.acceptEvent(receiver.identifier, event, hostTime),
    );
    // The panel asks every node for its status when it connects.
    await sender.sendCommand("status");
    await receiver.sendCommand("status");
    await flushAsyncWork();
    await campaign.run();

    expect(
      ledger.rows.map((row) => [
        row.run,
        row.sf,
        row.bw,
        row.size,
        row.count,
        row.sent,
        row.received,
        row.pdr,
        row.reason,
      ]),
    ).toEqual([
      [1, 7, 500, 239, 20, 20, 19, 0.95, "complete"],
      [2, 9, 500, 239, 20, 20, 19, 0.95, "complete"],
    ]);
    expect(ledger.rows[0]).toMatchObject({
      sender_model: "V2",
      receiver_model: "V4.3",
      receiver_lna: "bypass",
      toa_calc: 99904,
    });
    expect(ledger.rows[0]?.goodput).toBeGreaterThan(0);
  });

  it("marks a point failed when a node refuses the radio settings and continues", async () => {
    const { campaign } = createScenario(
      { spreadingFactors: [7, 8] },
      {},
      { radioRefusal: { reason: "out_of_range", times: 1 } },
    );
    const snapshot = await campaign.run();
    expect(snapshot.results.map((result) => [result.status, result.failure])).toEqual([
      ["failed", "El nodo 3A7F rechazó el comando radio (out_of_range)."],
      ["completed", null],
    ]);
  });

  it("repeats the radio command while a node answers busy", async () => {
    const { campaign, clock, receiver } = createScenario(
      { spreadingFactors: [7] },
      {},
      { radioRefusal: { reason: "busy", times: 2 } },
    );
    const snapshot = await runToEnd(campaign, clock);
    expect(snapshot.results[0]?.status).toBe("completed");
    expect(receiver.commands.filter((command) => command.startsWith("radio"))).toHaveLength(3);
  });

  it("marks a point failed when a node does not confirm the radio settings in time", async () => {
    const { campaign, clock } = createScenario({ spreadingFactors: [7] }, { ignoresRadio: true });
    const snapshot = await runToEnd(campaign, clock);
    expect(snapshot.results[0]).toMatchObject({
      status: "failed",
      failure: "El nodo 5C21 no confirmó los parámetros de radio a tiempo.",
    });
  });

  it("records a run the receiver did not hear at all", async () => {
    const { campaign, clock, silentReceptions } = createScenario(
      { spreadingFactors: [7], packetCount: 10 },
      {},
      { losesPacket: () => true },
    );
    const snapshot = await runToEnd(campaign, clock);
    expect(snapshot.results[0]).toMatchObject({ status: "completed", run: 1, received: 0 });
    expect(silentReceptions).toEqual([["5C21", 1, "3A7F"]]);
  });

  it("marks a point failed when the receiver heard packets but never reported run_end", async () => {
    const { campaign, clock } = createScenario(
      { spreadingFactors: [7], packetCount: 10 },
      {},
      { omitsRunEnd: true },
    );
    const snapshot = await runToEnd(campaign, clock);
    expect(snapshot.results[0]).toMatchObject({
      status: "failed",
      failure: "El receptor recibió 10 paquetes pero no informó el fin de la corrida.",
    });
  });

  it("pauses after the point in course and resumes", async () => {
    const { campaign } = createScenario({ spreadingFactors: [7, 8, 9], packetCount: 5 });
    const finished = campaign.run();
    campaign.pause();
    expect(campaign.snapshot.status).toBe("pausing");
    await flushAsyncWork();
    expect(campaign.snapshot.status).toBe("paused");
    expect(campaign.snapshot.results.map((result) => result.status)).toEqual([
      "completed",
      "pending",
      "pending",
    ]);
    campaign.resume();
    const snapshot = await finished;
    expect(snapshot.status).toBe("finished");
    expect(snapshot.finishedCount).toBe(3);
  });

  it("stops the run in course and leaves the remaining points pending", async () => {
    const { campaign, sender } = createScenario(
      { spreadingFactors: [7, 8], packetCount: 5 },
      { holdsRun: true },
    );
    const finished = campaign.run();
    await flushAsyncWork();
    expect(campaign.snapshot.results[0]?.status).toBe("transmitting");
    campaign.stop();
    const snapshot = await finished;
    expect(snapshot.status).toBe("stopped");
    expect(snapshot.results.map((result) => result.status)).toEqual(["stopped", "pending"]);
    expect(sender.commands.at(-1)).toBe("run stop");
  });

  it("estimates the remaining time from the plan and from the points already measured", async () => {
    const configuration = { spreadingFactors: [7, 8, 9], packetCount: 50 };
    const { campaign, snapshots } = createScenario(configuration);
    const total = estimatePlanDurationMilliseconds(
      buildCapacityTestPlan({ ...DEFAULT_CAPACITY_TEST_CONFIGURATION, ...configuration }),
    );
    expect(campaign.snapshot.estimatedRemainingMilliseconds).toBe(Math.round(total));
    expect(campaign.snapshot.progress).toBe(0);
    await campaign.run();
    const remaining = snapshots.map((snapshot) => snapshot.estimatedRemainingMilliseconds);
    expect(remaining.at(-1)).toBe(0);
    const afterFirstPoint = snapshots.find((snapshot) => snapshot.finishedCount === 1);
    expect(afterFirstPoint?.estimatedRemainingMilliseconds).toBeLessThan(total);
    expect(afterFirstPoint?.progress).toBeGreaterThan(0);
  });

  it("stops when a command cannot reach a node", async () => {
    const { campaign, receiver } = createScenario({ spreadingFactors: [7, 8, 9], packetCount: 5 });
    const sendCommand = receiver.sendCommand.bind(receiver);
    let radioCommands = 0;
    receiver.sendCommand = (command) => {
      if (command.startsWith("radio") && ++radioCommands === 2) {
        return Promise.reject(new Error("El nodo no está conectado."));
      }
      return sendCommand(command);
    };
    const snapshot = await campaign.run();
    expect(snapshot.status).toBe("stopped");
    expect(snapshot.results.map((result) => result.status)).toEqual([
      "completed",
      "failed",
      "pending",
    ]);
    expect(snapshot.results[1]?.failure).toBe(
      "No se pudo enviar «radio freq 915.9 sf 8 bw 500 cr 5 preamble 8 sync 18» al nodo 3A7F: El nodo no está conectado.",
    );
  });

  it("refuses to use the same node as sender and receiver", () => {
    const clock = new ManualTimeSource(START_TIME);
    const { sender } = createSimulatedPair(clock);
    expect(
      () => new CapacityTestCampaign({ sender, receiver: sender, points: [], timeSource: clock }),
    ).toThrow();
  });

  it("can be stopped before it starts", async () => {
    const { campaign } = createScenario({ spreadingFactors: [7] });
    campaign.stop();
    expect(campaign.snapshot.status).toBe("stopped");
    await expect(campaign.run()).rejects.toThrow();
  });
});

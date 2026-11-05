import { describe, expect, it } from "vite-plus/test";
import type { ConsoleEvent, ConsoleEventOf, ConsoleEventName } from "$lib/console/console-event.ts";
import type { NodeConsoleEvent } from "$lib/measurements/event-journal.ts";
import { computeUpdateMetrics } from "$lib/measurements/update-metrics.ts";
import { buildConnectionGraph, activationReadiness } from "$lib/nodes/connection-graph.ts";
import { INITIAL_NODE_STATE, applyConsoleEvent, type NodeState } from "$lib/nodes/node-state.ts";
import { ManualTimeSource } from "$lib/utils/time-source.ts";
import {
  TEST_VECTOR_IMAGE,
  TEST_VECTOR_PROGRAM,
  TEST_VECTOR_VERSION,
} from "./image-test-vector.ts";
import {
  createSimulatedPair,
  type SimulatedNode,
  type SimulatedNodeBehavior,
} from "./simulated-node.ts";

const START_HOST_TIME = 1_762_300_000_000;

interface Recorder {
  readonly events: NodeConsoleEvent[];
  state: NodeState;
}

function record(node: SimulatedNode): Recorder {
  const recorder: Recorder = { events: [], state: INITIAL_NODE_STATE };
  node.subscribe((event, hostTime) => {
    recorder.events.push({ node: node.identifier, hostTime, event });
    recorder.state = applyConsoleEvent(recorder.state, event, hostTime);
  });
  return recorder;
}

function eventsNamed<Name extends ConsoleEventName>(
  recorder: Recorder,
  name: Name,
): ConsoleEventOf<Name>[] {
  return recorder.events
    .map(({ event }) => event)
    .filter((event: ConsoleEvent): event is ConsoleEventOf<Name> => event.ev === name);
}

async function command(node: SimulatedNode, line: string): Promise<void> {
  await node.sendCommand(line);
  await node.settle();
}

function setUp(receiverBehavior: SimulatedNodeBehavior = {}) {
  const clock = new ManualTimeSource(START_HOST_TIME);
  const { sender, receiver } = createSimulatedPair(clock, {}, receiverBehavior);
  const origin = record(sender);
  const target = record(receiver);
  return { clock, sender, receiver, origin, target };
}

describe("SimulatedNode with images", () => {
  it("distributes, repairs and activates an image like the firmware", async () => {
    const { clock, sender, receiver, origin, target } = setUp({
      losesFragment: (_version, index, delivery) => index === 1 && delivery === 1,
    });
    // The panel asks for status when it connects, which identifies the nodes.
    await command(sender, "status");
    await command(receiver, "status");
    sender.sendHello();
    receiver.sendHello();
    await command(sender, "fragment_size 32");
    const loadHostTime = clock.now();
    await command(sender, `load_image ${TEST_VECTOR_IMAGE}`);

    expect(sender.versions).toEqual({ active: 0, available: TEST_VECTOR_VERSION });
    expect(receiver.versions).toEqual({ active: 0, available: TEST_VECTOR_VERSION });
    expect(eventsNamed(origin, "burst_start").map((burst) => [burst.cause, burst.count])).toEqual([
      ["load", 4],
      ["report", 1],
    ]);
    expect(eventsNamed(target, "report_sent")).toEqual([
      expect.objectContaining({ dst: "5C21", count: 4, size: 32, missing: [1], round: 1 }),
    ]);
    expect(eventsNamed(target, "image")).toEqual([
      expect.objectContaining({
        via: "radio",
        src: "5C21",
        reports: 1,
        fragments: 4,
        image_size: 102,
      }),
    ]);
    expect(eventsNamed(target, "burst_start").map((burst) => burst.cause)).toEqual(["complete"]);
    expect(eventsNamed(origin, "fragment_rx").every((fragment) => !fragment.accepted)).toBe(true);

    const graph = buildConnectionGraph([origin.state, target.state], clock.now());
    expect(activationReadiness(graph, TEST_VECTOR_VERSION)).toMatchObject({
      ready: true,
      nodeCount: 2,
    });

    clock.advanceBy(5000);
    const activateHostTime = clock.now();
    await command(sender, `activate ${TEST_VECTOR_VERSION}`);
    expect(sender.versions.active).toBe(TEST_VECTOR_VERSION);
    expect(receiver.versions.active).toBe(TEST_VECTOR_VERSION);
    expect(eventsNamed(target, "activation")).toEqual([
      expect.objectContaining({ cause: "hello", src: "5C21", previous: 0 }),
    ]);
    expect(eventsNamed(target, "vm_print").map((print) => print.value)).toEqual([8, -6]);
    expect(target.state.neighbors[0]).toMatchObject({
      version: TEST_VECTOR_VERSION,
      availableVersion: TEST_VECTOR_VERSION,
    });

    const metrics = computeUpdateMetrics({
      version: TEST_VECTOR_VERSION,
      loadHostTime,
      activateHostTime,
      events: [...origin.events, ...target.events],
    });
    expect(metrics.origin).toBe("5C21");
    expect(metrics.convergence.total.endHostTime).not.toBeNull();
    expect(metrics.convergence.activation?.milliseconds).toBeGreaterThan(0);
    expect(metrics.receivers).toEqual([
      expect.objectContaining({ id: "3A7F", missingPercent: 25, repairRounds: 1 }),
    ]);
    expect(metrics.efficiency).toMatchObject({ fragmentCount: 4, minimum: 4 });
    // 4 + 1 repaired by the origin, and 1 by the receiver, whose fragments stay at 231 bytes.
    expect(metrics.efficiency.transferFrames).toMatchObject({ fragments: 6, reports: 1 });
  });

  it("returns the active program and the transfer state", async () => {
    const { sender, origin } = setUp();
    await command(sender, `load_image ${TEST_VECTOR_IMAGE}`);
    await command(sender, `activate ${TEST_VECTOR_VERSION}`);
    await command(sender, "program");
    expect(eventsNamed(origin, "program")).toEqual([
      expect.objectContaining({
        version: TEST_VECTOR_VERSION,
        size: 29,
        code: TEST_VECTOR_PROGRAM,
      }),
    ]);
    await command(sender, "status");
    expect(eventsNamed(origin, "transfer").at(-1)).toMatchObject({
      active: TEST_VECTOR_VERSION,
      available: TEST_VECTOR_VERSION,
      receiving: null,
      fragment_size: 231,
    });
    expect(origin.state.neighbors).toEqual([
      expect.objectContaining({ id: "3A7F", version: TEST_VECTOR_VERSION }),
    ]);
  });

  it("answers the errors of the image commands", async () => {
    const { sender, origin } = setUp();
    const forged = TEST_VECTOR_IMAGE.slice(0, -2) + "00";
    await command(sender, `load_image ${forged}`);
    await command(sender, "load_image xyz");
    await command(sender, `activate ${TEST_VECTOR_VERSION}`);
    await command(sender, "fragment_size 20");
    await command(sender, `load_image ${TEST_VECTOR_IMAGE}`);
    await command(sender, `load_image ${TEST_VECTOR_IMAGE}`);
    expect(
      eventsNamed(origin, "error").map((error) => [error.cmd, error.reason, error.detail]),
    ).toEqual([
      ["load_image", "invalid_image", "signature"],
      ["load_image", "invalid_image", "format: not hexadecimal"],
      ["activate", "not_available", undefined],
      ["fragment_size", "out_of_range", "fragment_size 32..231"],
      ["load_image", "version_not_newer", undefined],
    ]);
  });

  it("checks the format, then the version, then the signature of load_image", async () => {
    const { sender, origin } = setUp();
    await command(sender, `load_image ${TEST_VECTOR_IMAGE}`);
    const forged = TEST_VECTOR_IMAGE.slice(0, -2) + "00";
    const truncated = TEST_VECTOR_IMAGE.slice(0, -2);
    await command(sender, `load_image ${forged}`);
    await command(sender, `load_image ${truncated}`);
    expect(
      eventsNamed(origin, "error").map((error) => [error.cmd, error.reason, error.detail]),
    ).toEqual([
      ["load_image", "version_not_newer", undefined],
      ["load_image", "invalid_image", "format"],
    ]);
  });
});

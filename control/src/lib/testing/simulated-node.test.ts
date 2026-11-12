import { describe, expect, it } from "vite-plus/test";
import type { ConsoleEvent, ConsoleEventOf, ConsoleEventName } from "$lib/console/console-event.ts";
import type { NodeConsoleEvent } from "$lib/measurements/event-journal.ts";
import { buildConnectionGraph } from "$lib/node-session/connection-graph.ts";
import { activationReadiness } from "$lib/update/activation.ts";
import { computeUpdateMetrics } from "$lib/update/update-metrics.ts";
import {
  INITIAL_NODE_STATE,
  applyConsoleEvent,
  type NodeState,
} from "$lib/node-session/node-state.ts";
import {
  CONSOLE_LINE_CAPACITY,
  DEFAULT_FRAGMENT_SIZE,
  FIRST_HELLO_MAXIMUM_DELAY_MILLISECONDS,
  HELLO_PERIOD_MILLISECONDS,
  IMAGE_LINE_CAPACITY,
  NEIGHBOR_EXPIRY_MILLISECONDS,
} from "$lib/protocol/protocol-contract.ts";
import { ManualTimeSource, flushAsyncWork } from "$lib/testing/manual-time-source.ts";
import firmwareConsoleLines from "../../../../firmware/protocol/test-vectors/firmware-console-lines.jsonl?raw";
import signedImageVector from "../../../../firmware/protocol/test-vectors/signed-image.json";
import defaultOperatorKeyPem from "../../../../firmware/protocol/default_operator_key.pem?raw";
import {
  importOperatorPrivateKey,
  signImage,
  type OperatorSigningKey,
} from "$lib/image/image-signing.ts";
import { formatHex } from "$lib/utils/hex.ts";
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
    await command(sender, `load_image ${signedImageVector.image}`);

    expect(sender.versions).toEqual({ active: 0, available: signedImageVector.version });
    expect(receiver.versions).toEqual({ active: 0, available: signedImageVector.version });
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
    expect(activationReadiness(graph, signedImageVector.version)).toMatchObject({
      ready: true,
      nodeCount: 2,
    });

    clock.advanceBy(5000);
    const activateHostTime = clock.now();
    await command(sender, `activate ${signedImageVector.version}`);
    expect(sender.versions.active).toBe(signedImageVector.version);
    expect(receiver.versions.active).toBe(signedImageVector.version);
    expect(eventsNamed(target, "activation")).toEqual([
      expect.objectContaining({ cause: "hello", src: "5C21", previous: 0 }),
    ]);
    expect(eventsNamed(target, "vm_print").map((print) => print.value)).toEqual([8, -6]);
    expect(target.state.neighbors[0]).toMatchObject({
      version: signedImageVector.version,
      availableVersion: signedImageVector.version,
    });

    const metrics = computeUpdateMetrics({
      version: signedImageVector.version,
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
    // 4 + 1 repaired by the origin, and 1 by the receiver, whose fragments keep the default size.
    expect(metrics.efficiency.transferFrames).toMatchObject({ fragments: 6, reports: 1 });
  });

  it("returns the active program and the transfer state", async () => {
    const { sender, origin } = setUp();
    await command(sender, `load_image ${signedImageVector.image}`);
    await command(sender, `activate ${signedImageVector.version}`);
    await command(sender, "program");
    expect(eventsNamed(origin, "program")).toEqual([
      expect.objectContaining({
        version: signedImageVector.version,
        size: signedImageVector.programLength,
        code: signedImageVector.program,
      }),
    ]);
    await command(sender, "status");
    expect(eventsNamed(origin, "transfer").at(-1)).toMatchObject({
      active: signedImageVector.version,
      available: signedImageVector.version,
      receiving: null,
      fragment_size: DEFAULT_FRAGMENT_SIZE,
    });
    expect(origin.state.neighbors).toEqual([
      expect.objectContaining({ id: "3A7F", version: signedImageVector.version }),
    ]);
  });

  it("answers the errors of the image commands", async () => {
    const { sender, origin } = setUp();
    const forged = signedImageVector.image.slice(0, -2) + "00";
    await command(sender, `load_image ${forged}`);
    await command(sender, "load_image xyz");
    await command(sender, `activate ${signedImageVector.version}`);
    await command(sender, "fragment_size 20");
    await command(sender, `load_image ${signedImageVector.image}`);
    await command(sender, `load_image ${signedImageVector.image}`);
    expect(
      eventsNamed(origin, "error").map((error) => [error.cmd, error.reason, error.detail]),
    ).toEqual([
      ["load_image", "invalid_image", "signature: not signed by the operator"],
      ["load_image", "invalid_image", "format: not hexadecimal"],
      ["activate", "not_available", "available version 0"],
      ["fragment_size", "out_of_range", "bytes 32..231"],
      ["load_image", "version_not_newer", `available version ${signedImageVector.version}`],
    ]);
    expect(errorsOf(origin).filter((error) => !FIRMWARE_ERRORS.has(error))).toEqual([]);
  });

  it("checks the format, then the version, then the signature of load_image", async () => {
    const { sender, origin } = setUp();
    await command(sender, `load_image ${signedImageVector.image}`);
    const forged = signedImageVector.image.slice(0, -2) + "00";
    const lengthened = `${signedImageVector.image}00`;
    await command(sender, `load_image ${forged}`);
    await command(sender, `load_image ${lengthened}`);
    expect(
      eventsNamed(origin, "error").map((error) => [error.cmd, error.reason, error.detail]),
    ).toEqual([
      ["load_image", "version_not_newer", `available version ${signedImageVector.version}`],
      ["load_image", "invalid_image", "format: length does not match the header"],
    ]);
  });
});

async function defaultOperatorKey(): Promise<OperatorSigningKey> {
  const result = await importOperatorPrivateKey(defaultOperatorKeyPem);
  if (!result.valid) {
    throw new Error(result.message);
  }
  return result.key;
}

/** The error events of the firmware host tests, with their time set to 0. */
const FIRMWARE_ERRORS = new Set(
  firmwareConsoleLines
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { t: number; ev: string })
    .filter((event) => event.ev === "error")
    .map((event) => JSON.stringify({ ...event, t: 0 })),
);

function errorsOf(recorder: Recorder): string[] {
  return eventsNamed(recorder, "error").map((event) => JSON.stringify({ ...event, t: 0 }));
}

describe("SimulatedNode commands", () => {
  it("answers malformed commands with the errors the firmware writes", async () => {
    const { sender, origin } = setUp();
    const lines = [
      "help me",
      "frobnicate 1 2",
      "STATUS",
      "abcdefghijklmnopqrstuvwxyz",
      `status${" ".repeat(CONSOLE_LINE_CAPACITY - 5)}`,
      "x".repeat(CONSOLE_LINE_CAPACITY + 1),
      `load_image ${"a".repeat(IMAGE_LINE_CAPACITY - 10)}`,
      "status now",
      "radio sf",
      "echo",
      "echo 5C21",
      "run",
      "run stop",
      "wifi",
      "resend 1",
      "presence",
      "load_registers 1 2 3",
      "load_image",
      "activate",
      "fragment_size 64 64",
      "program 1",
      "resend",
      "echo 3A7F 3",
      "run 0 16 0",
      "run 1 7 0",
      "run 1 16 60001",
      "presence off 0",
      "fragment_size 31",
      "activate 4294967296",
      "load_registers 1 2 3 4294967296",
      "radio sf 13",
      "radio bw 300",
      "load_image xyz",
      `load_image ${signedImageVector.image}00`,
      `load_image ${signedImageVector.image.slice(0, -2)}00`,
      `load_image ${formatHex(await signImage(Uint8Array.of(0xff), 2, await defaultOperatorKey()))}`,
    ];
    for (const line of lines) {
      await command(sender, line);
    }
    const errors = errorsOf(origin);
    expect(errors).toHaveLength(lines.length);
    expect(errors.filter((error) => !FIRMWARE_ERRORS.has(error))).toEqual([]);
  });

  it("refuses radio and test commands as busy while a run is in progress", async () => {
    const { sender, origin } = setUp();
    sender.behavior = { holdsRun: true };
    for (const line of [
      "run 5 16 0",
      "radio sf 8",
      "radio reset",
      "echo 3A7F",
      "run 1 16 0",
      "resend",
    ]) {
      await command(sender, line);
    }
    expect(errorsOf(origin).filter((error) => !FIRMWARE_ERRORS.has(error))).toEqual([]);
    expect(eventsNamed(origin, "error").map((error) => [error.cmd, error.reason])).toEqual([
      ["radio", "busy"],
      ["radio", "busy"],
      ["echo", "busy"],
      ["run", "busy"],
      ["resend", "busy"],
    ]);
  });

  it("lists in help the usage of every command, as its usage errors carry it", async () => {
    const { sender } = setUp();
    await command(sender, "help");
    const usages = sender.emittedLines.slice(1).map((line) => line.trim());
    expect(sender.emittedLines[0]).toBe("commands:");
    const details = [...FIRMWARE_ERRORS].map(
      (error) => (JSON.parse(error) as { detail?: string }).detail,
    );
    expect(usages.filter((usage) => !details.includes(usage))).toEqual([]);
  });

  it("sends its HELLO messages on its own once started", () => {
    const { clock, sender, receiver, target } = setUp();
    const stop = sender.start(() => 0.5);
    clock.advanceBy(FIRST_HELLO_MAXIMUM_DELAY_MILLISECONDS + 100);
    expect(eventsNamed(target, "hello")).toHaveLength(1);
    clock.advanceBy(HELLO_PERIOD_MILLISECONDS);
    expect(eventsNamed(target, "hello")).toHaveLength(2);
    stop();
    clock.advanceBy(2 * HELLO_PERIOD_MILLISECONDS);
    expect(eventsNamed(target, "hello")).toHaveLength(2);
    expect(receiver.versions.active).toBe(0);
  });
});

describe("SimulatedNode echoes and runs", () => {
  // The test setup compares these lines with those of the firmware, as it does in every test.
  it("writes the events of an answered echo, a lost echo and a run", async () => {
    const { sender, origin, target } = setUp({ losesEchoRequest: (number) => number === 2 });
    await command(sender, "echo 3A7F");
    await command(sender, "echo 3A7F");
    await command(sender, "run 3 16 0");

    const transmitted = (recorder: Recorder) =>
      eventsNamed(recorder, "tx").map((transmission) => transmission.type);
    expect(eventsNamed(origin, "echo").map((echo) => echo.n)).toEqual([1]);
    expect(eventsNamed(origin, "echo_lost").map((echo) => echo.n)).toEqual([2]);
    expect(eventsNamed(target, "echo_served").map((echo) => echo.n)).toEqual([1]);
    expect(eventsNamed(target, "test_rx").map((packet) => packet.index)).toEqual([0, 1, 2]);
    expect(eventsNamed(origin, "run_done")).toHaveLength(1);
    expect(eventsNamed(target, "run_end").map((run) => run.reason)).toEqual(["complete"]);
    expect(transmitted(origin)).toEqual(["echo_request", "echo_request", "test", "test", "test"]);
    expect(transmitted(target)).toEqual(["echo_reply"]);
  });
});

describe("SimulatedNode repairs", () => {
  it("stops reporting while the sender is out of its neighbor table and resumes when it hears it", async () => {
    let lossy = true;
    const { clock, sender, receiver, target } = setUp({
      losesFragment: (_version, index) => lossy && index === 1,
    });
    await sender.sendCommand("fragment_size 32");
    await sender.sendCommand(`load_image ${signedImageVector.image}`);
    while (sender.versions.available === 0) {
      await flushAsyncWork();
      clock.advanceBy(1);
    }
    clock.advanceBy(5000);
    expect(eventsNamed(target, "report_sent").length).toBeGreaterThan(2);

    // The sender moves to another modulation: the receiver no longer hears its repairs.
    await sender.sendCommand("radio sf 8");
    await flushAsyncWork();
    clock.advanceBy(NEIGHBOR_EXPIRY_MILLISECONDS + 5000);
    const reportsAfterExpiry = eventsNamed(target, "report_sent").length;
    clock.advanceBy(NEIGHBOR_EXPIRY_MILLISECONDS);
    expect(eventsNamed(target, "report_sent")).toHaveLength(reportsAfterExpiry);

    lossy = false;
    await sender.sendCommand("radio sf 7");
    await flushAsyncWork();
    sender.sendHello();
    await sender.settle();
    expect(receiver.versions.available).toBe(signedImageVector.version);
    expect(eventsNamed(target, "report_sent").length).toBeGreaterThan(reportsAfterExpiry);
  });
});

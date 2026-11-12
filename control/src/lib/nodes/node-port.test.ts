import { describe, expect, it } from "vite-plus/test";
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import { parseConsoleLine } from "$lib/console/console-line-parser.ts";
import {
  BUSY_RETRY_DELAY_MILLISECONDS,
  CommandFailure,
  MAXIMUM_BUSY_RETRIES,
  retryWhileBusy,
  sendAndAwait,
  type NodePort,
} from "./node-port.ts";
import { CAPACITY_TEST_INTERVAL } from "$lib/measurements/capacity-test-plan.ts";
import {
  DEFAULT_PREAMBLE_LENGTH,
  MAXIMUM_CODING_RATE_DENOMINATOR,
  MAXIMUM_SPREADING_FACTOR,
  MAXIMUM_TEST_SIZE,
  ON_AIR_BANDWIDTH_KILOHERTZ,
  runReceptionDeadlineMilliseconds,
} from "$lib/protocol/protocol-contract.ts";
import { timeOnAirOfPayload } from "$lib/radio/time-on-air.ts";
import { ManualTimeSource } from "$lib/testing/manual-time-source.ts";

const PRESENCE_OFF = '{"t":1,"ev":"presence","state":"off","remaining":60}';
const BUSY = '{"t":1,"ev":"error","cmd":"presence","reason":"busy"}';
const UNKNOWN_COMMAND = '{"t":1,"ev":"error","cmd":"presence","reason":"unknown_command"}';
const OTHER_ERROR = '{"t":1,"ev":"error","cmd":"radio","reason":"busy"}';

/** A node that answers each command with the next scripted console lines. */
class ScriptedNode implements NodePort {
  readonly identifier = "3A7F";
  readonly commands: string[] = [];
  readonly #answers: (readonly string[])[];
  readonly #listeners = new Set<(event: ConsoleEvent, hostTime: number) => void>();

  constructor(answers: (readonly string[])[]) {
    this.#answers = answers;
  }

  sendCommand(command: string): Promise<void> {
    this.commands.push(command);
    const lines = this.#answers.shift() ?? [];
    queueMicrotask(() => {
      for (const line of lines) {
        const parsed = parseConsoleLine(line);
        if (parsed.kind === "event") {
          for (const listener of this.#listeners) {
            listener(parsed.event, 0);
          }
        }
      }
    });
    return Promise.resolve();
  }

  subscribe(listener: (event: ConsoleEvent, hostTime: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

const isPresenceOff = (event: ConsoleEvent): boolean =>
  event.ev === "presence" && event.state === "off";

function failureOf(promise: Promise<unknown>): Promise<CommandFailure> {
  return promise.then(
    () => {
      throw new Error("the command was confirmed");
    },
    (error: unknown) => {
      if (error instanceof CommandFailure) {
        return error;
      }
      throw error;
    },
  );
}

describe("sendAndAwait", () => {
  it("resolves with the event that confirms the command, ignoring errors of other commands", async () => {
    const clock = new ManualTimeSource(0);
    const node = new ScriptedNode([[OTHER_ERROR, PRESENCE_OFF]]);
    const confirmation = await clock.advanceUntilSettled(
      sendAndAwait(node, "presence off 60", isPresenceOff, {
        timeSource: clock,
        timeoutMilliseconds: 5000,
      }),
    );
    expect(confirmation.event).toMatchObject({ ev: "presence", state: "off" });
    expect(clock.pendingCallCount).toBe(0);
  });

  it("fails on an error about the command, on timeout and when cancelled", async () => {
    const clock = new ManualTimeSource(0);
    const options = { timeSource: clock, timeoutMilliseconds: 5000 };
    const refused = await clock.advanceUntilSettled(
      failureOf(
        sendAndAwait(
          new ScriptedNode([[UNKNOWN_COMMAND]]),
          "presence off 60",
          isPresenceOff,
          options,
        ),
      ),
    );
    expect(refused).toMatchObject({ kind: "refused", node: "3A7F", reason: "unknown_command" });

    const silent = await clock.advanceUntilSettled(
      failureOf(sendAndAwait(new ScriptedNode([]), "presence off 60", isPresenceOff, options)),
    );
    expect(silent.kind).toBe("timeout");
    expect(clock.now()).toBe(5000);

    const controller = new AbortController();
    const cancelled = failureOf(
      sendAndAwait(new ScriptedNode([]), "presence off 60", isPresenceOff, {
        ...options,
        signal: controller.signal,
      }),
    );
    controller.abort();
    expect((await cancelled).kind).toBe("cancelled");
  });

  it("fails when the command cannot reach the node", async () => {
    const clock = new ManualTimeSource(0);
    const node = new ScriptedNode([]);
    node.sendCommand = () => Promise.reject(new Error("closed"));
    const failure = await failureOf(
      sendAndAwait(node, "presence off 60", isPresenceOff, {
        timeSource: clock,
        timeoutMilliseconds: 5000,
      }),
    );
    expect(failure).toMatchObject({ kind: "unsent", reason: "closed" });
  });
});

describe("retryWhileBusy", () => {
  it("keeps retrying past the run_end deadline of the slowest run of a capacity test on the air", () => {
    const slowest = {
      sf: MAXIMUM_SPREADING_FACTOR,
      bw: ON_AIR_BANDWIDTH_KILOHERTZ,
      cr: MAXIMUM_CODING_RATE_DENOMINATOR,
      preamble: DEFAULT_PREAMBLE_LENGTH,
    };
    const deadline = runReceptionDeadlineMilliseconds(
      CAPACITY_TEST_INTERVAL,
      timeOnAirOfPayload(MAXIMUM_TEST_SIZE, slowest),
    );
    expect(BUSY_RETRY_DELAY_MILLISECONDS * MAXIMUM_BUSY_RETRIES).toBeGreaterThan(deadline);
  });

  it("repeats the command while the node is busy, with the pause of the policy", async () => {
    const clock = new ManualTimeSource(0);
    const node = new ScriptedNode([[BUSY], [BUSY], [PRESENCE_OFF]]);
    const options = { timeSource: clock, timeoutMilliseconds: 5000 };
    await clock.advanceUntilSettled(
      retryWhileBusy(() => sendAndAwait(node, "presence off 60", isPresenceOff, options), clock),
    );
    expect(node.commands).toHaveLength(3);
    expect(clock.now()).toBe(2 * BUSY_RETRY_DELAY_MILLISECONDS);
  });

  it("gives up after the last retry and does not repeat other refusals", async () => {
    const clock = new ManualTimeSource(0);
    const options = { timeSource: clock, timeoutMilliseconds: 5000 };
    const alwaysBusy = new ScriptedNode(Array.from({ length: 20 }, () => [BUSY]));
    const busy = await clock.advanceUntilSettled(
      failureOf(
        retryWhileBusy(
          () => sendAndAwait(alwaysBusy, "presence off 60", isPresenceOff, options),
          clock,
        ),
      ),
    );
    expect(busy.isBusyRefusal).toBe(true);
    expect(alwaysBusy.commands).toHaveLength(MAXIMUM_BUSY_RETRIES + 1);

    const refusing = new ScriptedNode([[UNKNOWN_COMMAND]]);
    const refused = await clock.advanceUntilSettled(
      failureOf(
        retryWhileBusy(
          () => sendAndAwait(refusing, "presence off 60", isPresenceOff, options),
          clock,
        ),
      ),
    );
    expect(refused.reason).toBe("unknown_command");
    expect(refusing.commands).toHaveLength(1);
  });
});

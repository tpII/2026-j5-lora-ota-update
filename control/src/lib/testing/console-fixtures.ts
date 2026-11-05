/**
 * Console sessions recorded in the format of docs/protocol/console.md, for the tests. Node 3A7F is
 * a V4.3 and node 5C21 a V2; the clock of 3A7F runs 10001 ms ahead of the clock of 5C21.
 */
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import { parseConsoleLine } from "$lib/console/console-line-parser.ts";
import nodeSessionLog from "./fixtures/node-3a7f-session.log?raw";
import receiverRunLog from "./fixtures/run-receiver-3a7f.log?raw";
import senderRunLog from "./fixtures/run-sender-5c21.log?raw";
import updateOriginLog from "./fixtures/update-origin-5c21.log?raw";
import updateReceiverLog from "./fixtures/update-receiver-3a7f.log?raw";

/** Boot, presence, status, echoes, errors and malformed lines seen by node 3A7F. */
export const NODE_SESSION_LOG: string = nodeSessionLog;

/** Node 5C21 transmitting runs 3, 4 and 5. */
export const SENDER_RUN_LOG: string = senderRunLog;

/** Node 3A7F receiving runs 3 and 4 of node 5C21; it hears nothing of run 5. */
export const RECEIVER_RUN_LOG: string = receiverRunLog;

/**
 * Node 5C21, the origin of an update: the operator sets fragments of 32 bytes, loads the image of
 * the test vector (4 fragments), repairs the fragment 1 that 3A7F reports missing and, 20 s
 * later, activates the version. Same clocks as the runs.
 */
export const UPDATE_ORIGIN_LOG: string = updateOriginLog;

/**
 * Node 3A7F during the same update: it loses fragment 1, reports it, completes the image, sends
 * its own burst once and activates the version with the HELLO of 5C21. Afterwards it answers
 * `program` and `status` and rejects a forged image of node 9B04.
 */
export const UPDATE_RECEIVER_LOG: string = updateReceiverLog;

/** Version of the update: the version of the test vector. */
export const UPDATE_VERSION = 1_762_300_800;

/** Host time, in milliseconds since 1970, at which node 5C21 booted. */
export const SENDER_BOOT_HOST_TIME = 1_759_850_000_000;

/** Host time at which node 3A7F booted, so that both clocks agree on the host. */
export const RECEIVER_BOOT_HOST_TIME = SENDER_BOOT_HOST_TIME - 10_001;

/** Host time at which the panel sent `load_image` to 5C21 in the update sessions. */
export const UPDATE_LOAD_HOST_TIME = SENDER_BOOT_HOST_TIME + 50_000;

/** Host time at which the panel sent `activate` to 5C21 in the update sessions. */
export const UPDATE_ACTIVATE_HOST_TIME = SENDER_BOOT_HOST_TIME + 70_000;

export function splitFixtureLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

export interface TimedConsoleEvent {
  readonly event: ConsoleEvent;
  readonly hostTime: number;
}

/** Events of a recorded session, timed on the host as if the node booted at `bootHostTime`. */
export function readFixtureEvents(text: string, bootHostTime: number): TimedConsoleEvent[] {
  const events: TimedConsoleEvent[] = [];
  for (const line of splitFixtureLines(text)) {
    const parsed = parseConsoleLine(line);
    if (parsed.kind === "event") {
      events.push({ event: parsed.event, hostTime: bootHostTime + parsed.event.t });
    }
  }
  return events;
}

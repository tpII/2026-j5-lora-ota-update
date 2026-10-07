/**
 * Console sessions recorded in the format of docs/protocol/console.md, for the tests. Node 3A7F is
 * a V4.3 and node 5C21 a V2; the clock of 3A7F runs 10001 ms ahead of the clock of 5C21.
 */
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import { parseConsoleLine } from "$lib/console/console-line-parser.ts";
import nodeSessionLog from "./fixtures/node-3a7f-session.log?raw";
import receiverRunLog from "./fixtures/run-receiver-3a7f.log?raw";
import senderRunLog from "./fixtures/run-sender-5c21.log?raw";

/** Boot, presence, status, echoes, errors and malformed lines seen by node 3A7F. */
export const NODE_SESSION_LOG: string = nodeSessionLog;

/** Node 5C21 transmitting runs 3, 4 and 5. */
export const SENDER_RUN_LOG: string = senderRunLog;

/** Node 3A7F receiving runs 3 and 4 of node 5C21; it hears nothing of run 5. */
export const RECEIVER_RUN_LOG: string = receiverRunLog;

/** Host time, in milliseconds since 1970, at which node 5C21 booted. */
export const SENDER_BOOT_HOST_TIME = 1_759_850_000_000;

/** Host time at which node 3A7F booted, so that both clocks agree on the host. */
export const RECEIVER_BOOT_HOST_TIME = SENDER_BOOT_HOST_TIME - 10_001;

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

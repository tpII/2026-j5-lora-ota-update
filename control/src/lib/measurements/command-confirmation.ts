/**
 * Commands whose effect the node confirms with an event: the panel sends the command and waits for
 * that event, or for an `error` about the command, within a deadline.
 */
import type { CampaignNode } from "./capacity-test-campaign.ts";
import {
  PRESENCE_ON_COMMAND,
  buildPresenceOffCommand,
  buildRadioSetCommand,
  commandWordOf,
} from "$lib/console/console-command.ts";
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import type { TimeSource } from "$lib/utils/time-source.ts";

export const DEFAULT_CONFIRMATION_TIMEOUT_MILLISECONDS = 5000;

export interface Modulation {
  readonly sf: number;
  readonly bw: number;
  readonly cr: number;
}

/**
 * Sends `command` and waits for the event that confirms it or for an `error` about it. Resolves to
 * null when confirmed, or to the problem in Spanish.
 */
export function sendAndConfirm(
  node: CampaignNode,
  command: string,
  confirms: (event: ConsoleEvent) => boolean,
  timeSource: TimeSource,
  timeoutMilliseconds = DEFAULT_CONFIRMATION_TIMEOUT_MILLISECONDS,
): Promise<string | null> {
  const word = commandWordOf(command);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (problem: string | null): void => {
      if (!settled) {
        settled = true;
        unsubscribe();
        cancelTimer();
        resolve(problem);
      }
    };
    const unsubscribe = node.subscribe((event) => {
      if (confirms(event)) {
        finish(null);
      } else if (event.ev === "error" && event.cmd === word) {
        const detail = event.detail === undefined ? "" : `: ${event.detail}`;
        finish(`el nodo ${node.identifier} rechazó «${command}» (${event.reason}${detail}).`);
      }
    });
    const cancelTimer = timeSource.schedule(
      () => finish(`el nodo ${node.identifier} no confirmó «${command}» a tiempo.`),
      timeoutMilliseconds,
    );
    node.sendCommand(command).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      finish(`no se pudo enviar «${command}» al nodo ${node.identifier}: ${message}`);
    });
  });
}

/** `radio sf <sf> bw <bw> cr <cr>`, confirmed by a `radio` event with that modulation. */
export function applyModulation(
  node: CampaignNode,
  modulation: Modulation,
  timeSource: TimeSource,
  timeoutMilliseconds?: number,
): Promise<string | null> {
  const command = buildRadioSetCommand(modulation, null);
  if (!command.valid) {
    return Promise.resolve(command.problems.map((problem) => problem.message).join(" "));
  }
  return sendAndConfirm(
    node,
    command.command,
    (event) =>
      event.ev === "radio" &&
      event.sf === modulation.sf &&
      event.bw === modulation.bw &&
      event.cr === modulation.cr,
    timeSource,
    timeoutMilliseconds,
  );
}

/** `presence off <seconds>`, confirmed by a `presence` event with state "off". */
export function holdPresence(
  node: CampaignNode,
  seconds: number,
  timeSource: TimeSource,
  timeoutMilliseconds?: number,
): Promise<string | null> {
  const command = buildPresenceOffCommand(seconds);
  if (!command.valid) {
    return Promise.resolve(command.problems.map((problem) => problem.message).join(" "));
  }
  return sendAndConfirm(
    node,
    command.command,
    (event) => event.ev === "presence" && event.state === "off",
    timeSource,
    timeoutMilliseconds,
  );
}

/** `presence on`, confirmed by a `presence` event with state "on". */
export function releasePresence(
  node: CampaignNode,
  timeSource: TimeSource,
  timeoutMilliseconds?: number,
): Promise<string | null> {
  return sendAndConfirm(
    node,
    PRESENCE_ON_COMMAND,
    (event) => event.ev === "presence" && event.state === "on",
    timeSource,
    timeoutMilliseconds,
  );
}

/** Puts back a modulation and the HELLO messages; returns the problems found, in Spanish. */
export async function restoreNode(
  node: CampaignNode,
  modulation: Modulation,
  timeSource: TimeSource,
  timeoutMilliseconds?: number,
): Promise<string[]> {
  const problems: string[] = [];
  const radio = await applyModulation(node, modulation, timeSource, timeoutMilliseconds);
  if (radio !== null) {
    problems.push(radio);
  }
  const presence = await releasePresence(node, timeSource, timeoutMilliseconds);
  if (presence !== null) {
    problems.push(presence);
  }
  return problems;
}

/**
 * A connected and identified node as the panel workflows see it (capacity test, echo series and
 * both sides of the communication test), and the primitives they share to command it: send a
 * command and wait for the event that confirms it, repeat a command the node refused as busy,
 * apply radio settings and tell the operator why a command was not confirmed.
 */
import { buildRadioSetCommand } from "$lib/commands/console-command.ts";
import { commandWordOf } from "$lib/console/console-command-table.ts";
import type { ConsoleEvent, NodeIdentifier } from "$lib/console/console-event.ts";
import {
  settingsMatch,
  type RadioSettingChanges,
  type RadioSettingKey,
  type RadioSettings,
} from "$lib/radio/radio-settings.ts";
import type { TimeSource } from "$lib/utils/time-source.ts";

/**
 * Time a node has to answer a command with the event that confirms it: the console crosses the
 * transport twice and the node acts on the command in the next pass of its main loop.
 */
export const COMMAND_CONFIRMATION_MILLISECONDS = 5000;

export interface NodePort {
  readonly identifier: NodeIdentifier;
  sendCommand(command: string): Promise<void>;
  /** Receives every event of the node; returns the function that ends the subscription. */
  subscribe(listener: (event: ConsoleEvent, hostTime: number) => void): () => void;
}

/**
 * Why a command was not confirmed: the node answered with an `error` event about it, no
 * confirmation arrived in time, the command could not reach the node, or the caller gave up.
 */
export type CommandFailureKind = "refused" | "timeout" | "unsent" | "cancelled";

export class CommandFailure extends Error {
  readonly kind: CommandFailureKind;
  readonly node: NodeIdentifier;
  readonly command: string;
  /** Reason of the `error` event when refused, or the transport message when unsent. */
  readonly reason: string | null;
  readonly detail: string | null;

  constructor(
    kind: CommandFailureKind,
    node: NodeIdentifier,
    command: string,
    reason: string | null = null,
    detail: string | null = null,
  ) {
    super(`${kind}: "${command}" to node ${node}${reason === null ? "" : ` (${reason})`}`);
    this.name = "CommandFailure";
    this.kind = kind;
    this.node = node;
    this.command = command;
    this.reason = reason;
    this.detail = detail;
  }

  get isBusyRefusal(): boolean {
    return this.kind === "refused" && this.reason === "busy";
  }
}

/**
 * Why a command was not confirmed, in Spanish, as a clause that a notice continues or starts:
 * "el nodo 3A7F rechazó «radio sf 9» (busy)."
 */
export function describeCommandFailure(failure: CommandFailure): string {
  const { node, command, reason, detail } = failure;
  switch (failure.kind) {
    case "refused":
      return `el nodo ${node} rechazó «${command}» (${reason}${detail === null ? "" : `: ${detail}`}).`;
    case "timeout":
      return `el nodo ${node} no confirmó «${command}» a tiempo.`;
    case "unsent":
      return `no se pudo enviar «${command}» al nodo ${node}: ${reason}`;
    case "cancelled":
      return `el panel dejó de esperar que el nodo ${node} confirmara «${command}».`;
  }
}

export function describeCommandFailureSentence(failure: CommandFailure): string {
  const clause = describeCommandFailure(failure);
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

export interface Confirmation<Event extends ConsoleEvent> {
  readonly event: Event;
  readonly hostTime: number;
}

export interface AwaitOptions {
  readonly timeSource: TimeSource;
  readonly timeoutMilliseconds: number;
  /** Gives up the wait, which then fails as "cancelled". */
  readonly signal?: AbortSignal;
}

/**
 * Sends `command` to `node` and resolves with the first event that `confirms` accepts. Fails with
 * a CommandFailure on an `error` event about the command, on timeout, when the command cannot be
 * sent or when `signal` aborts.
 */
export function sendAndAwait<Event extends ConsoleEvent>(
  node: NodePort,
  command: string,
  confirms: (event: ConsoleEvent) => event is Event,
  options: AwaitOptions,
): Promise<Confirmation<Event>>;
export function sendAndAwait(
  node: NodePort,
  command: string,
  confirms: (event: ConsoleEvent) => boolean,
  options: AwaitOptions,
): Promise<Confirmation<ConsoleEvent>>;
export function sendAndAwait(
  node: NodePort,
  command: string,
  confirms: (event: ConsoleEvent) => boolean,
  options: AwaitOptions,
): Promise<Confirmation<ConsoleEvent>> {
  const { timeSource, timeoutMilliseconds, signal } = options;
  const word = commandWordOf(command);
  const failure = (kind: CommandFailureKind, reason?: string, detail?: string | null) =>
    new CommandFailure(kind, node.identifier, command, reason ?? null, detail ?? null);
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(failure("cancelled"));
      return;
    }
    let settled = false;
    let cancelTimer = (): void => {};
    let unsubscribe = (): void => {};
    const finish = (outcome: Confirmation<ConsoleEvent> | CommandFailure): void => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      cancelTimer();
      signal?.removeEventListener("abort", cancel);
      if (outcome instanceof CommandFailure) {
        reject(outcome);
      } else {
        resolve(outcome);
      }
    };
    const cancel = (): void => finish(failure("cancelled"));
    unsubscribe = node.subscribe((event, hostTime) => {
      if (confirms(event)) {
        finish({ event, hostTime });
      } else if (event.ev === "error" && event.cmd === word) {
        finish(failure("refused", event.reason, event.detail));
      }
    });
    cancelTimer = timeSource.schedule(() => finish(failure("timeout")), timeoutMilliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
    node.sendCommand(command).catch((error: unknown) => {
      finish(failure("unsent", error instanceof Error ? error.message : String(error)));
    });
  });
}

/**
 * The firmware refuses `radio` and `echo` as busy while a run is open (sending, or receiving until
 * its run_end deadline) or while an echo waits for its reply or its loss deadline, and it emits no
 * event when it is idle again. The panel repeats such a command every BUSY_RETRY_DELAY_MILLISECONDS,
 * MAXIMUM_BUSY_RETRIES times at most: longer than the run_end deadline of the slowest capacity
 * test point on the air, as node-port.test.ts checks.
 */
export const BUSY_RETRY_DELAY_MILLISECONDS = 1000;
export const MAXIMUM_BUSY_RETRIES = 10;

/**
 * Runs `attempt` again while it fails because the node is busy, with the pause of the busy retry
 * policy in between. `signal` interrupts the pause, which then fails as "cancelled".
 */
export async function retryWhileBusy<Value>(
  attempt: () => Promise<Value>,
  timeSource: TimeSource,
  signal?: AbortSignal,
): Promise<Value> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (
        !(error instanceof CommandFailure) ||
        !error.isBusyRefusal ||
        retry >= MAXIMUM_BUSY_RETRIES
      ) {
        throw error;
      }
      await timeSource.wait(BUSY_RETRY_DELAY_MILLISECONDS, signal);
      if (signal?.aborted === true) {
        throw new CommandFailure("cancelled", error.node, error.command);
      }
    }
  }
}

export interface RadioSettingsOptions {
  readonly timeSource: TimeSource;
  /** Gives up the command, which then fails as "cancelled". */
  readonly signal?: AbortSignal;
}

/**
 * Sends `radio` with the `fields` of `settings` and waits for the `radio` event that reports them,
 * repeating the command while the node refuses it as busy. Resolves to null once confirmed, or to
 * the failure. The callers validate the settings first: settings the builder refuses throw.
 */
export async function applyRadioSettings<const Field extends RadioSettingKey>(
  node: NodePort,
  settings: { readonly [Key in Field]: NonNullable<RadioSettings[Key]> },
  fields: readonly Field[],
  options: RadioSettingsOptions,
): Promise<CommandFailure | null> {
  const changes = Object.fromEntries(
    fields.map((field) => [field, settings[field]]),
  ) as RadioSettingChanges;
  const command = buildRadioSetCommand(changes, null);
  if (!command.valid) {
    throw new Error(command.problems.map((problem) => problem.message).join(" "));
  }
  const { timeSource, signal } = options;
  try {
    await retryWhileBusy(
      () =>
        sendAndAwait(
          node,
          command.command,
          (event) => event.ev === "radio" && settingsMatch(event, settings, fields),
          { timeSource, timeoutMilliseconds: COMMAND_CONFIRMATION_MILLISECONDS, signal },
        ),
      timeSource,
      signal,
    );
    return null;
  } catch (error) {
    if (error instanceof CommandFailure) {
      return error;
    }
    throw error;
  }
}

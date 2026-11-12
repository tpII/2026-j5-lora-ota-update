/**
 * What a communication test does to the radio of a node, on either side (CONTEXT.md): it holds the
 * HELLO messages and applies the modulation of the test; afterwards the node returns to its
 * previous modulation and sends its HELLO messages again. Each step waits for the event with which
 * the node confirms it.
 */
import { PRESENCE_ON_COMMAND, buildPresenceOffCommand } from "$lib/commands/console-command.ts";
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import {
  COMMAND_CONFIRMATION_MILLISECONDS,
  CommandFailure,
  applyRadioSettings,
  describeCommandFailure,
  sendAndAwait,
  type NodePort,
} from "$lib/nodes/node-port.ts";
import {
  MODULATION_FIELDS,
  type Modulation,
  type RadioSettings,
} from "$lib/radio/radio-settings.ts";
import type { TimeSource } from "$lib/utils/time-source.ts";

export class CommunicationTestSession {
  readonly #node: NodePort;
  readonly #previousModulation: Modulation;
  readonly #timeSource: TimeSource;

  /** `previousRadio` is what the node reported before the test, which restore() puts back. */
  constructor(node: NodePort, previousRadio: RadioSettings, timeSource: TimeSource) {
    const { sf, bw, cr } = previousRadio;
    this.#node = node;
    this.#previousModulation = { sf, bw, cr };
    this.#timeSource = timeSource;
  }

  /**
   * Holds the HELLO messages for `holdSeconds` and then applies `modulation`. Resolves to the
   * problem in Spanish, or to null. When `signal` aborts during the hold, the modulation is left
   * as it was.
   */
  async prepare(
    modulation: Modulation,
    holdSeconds: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const held = await this.renewHold(holdSeconds);
    if (held !== null) {
      return `No se pudieron suspender los HELLO: ${held}`;
    }
    if (signal?.aborted === true) {
      return null;
    }
    const modulated = await this.#applyModulation(modulation);
    return modulated === null
      ? null
      : `No se pudo aplicar la modulación de la prueba: ${modulated}`;
  }

  /**
   * `presence off <holdSeconds>`, confirmed by a `presence` event with state "off": holds the HELLO
   * messages again for `holdSeconds`. Resolves to the problem in Spanish, or to null.
   */
  renewHold(holdSeconds: number): Promise<string | null> {
    const command = buildPresenceOffCommand(holdSeconds);
    if (!command.valid) {
      return Promise.resolve(command.problems.map((problem) => problem.message).join(" "));
    }
    return this.#confirm(
      command.command,
      (event) => event.ev === "presence" && event.state === "off",
    );
  }

  /** Puts back the previous modulation and the HELLO messages; returns the problems, in Spanish. */
  async restore(): Promise<string[]> {
    const problems: string[] = [];
    const radio = await this.#applyModulation(this.#previousModulation);
    if (radio !== null) {
      problems.push(radio);
    }
    const presence = await this.#confirm(
      PRESENCE_ON_COMMAND,
      (event) => event.ev === "presence" && event.state === "on",
    );
    if (presence !== null) {
      problems.push(presence);
    }
    return problems;
  }

  async #applyModulation(modulation: Modulation): Promise<string | null> {
    const failure = await applyRadioSettings(this.#node, modulation, MODULATION_FIELDS, {
      timeSource: this.#timeSource,
    });
    return failure === null ? null : describeCommandFailure(failure);
  }

  /**
   * Sends `command` and waits for the event that confirms it or for an `error` about it. Resolves
   * to null when confirmed, or to the problem in Spanish.
   */
  async #confirm(
    command: string,
    confirms: (event: ConsoleEvent) => boolean,
  ): Promise<string | null> {
    try {
      await sendAndAwait(this.#node, command, confirms, {
        timeSource: this.#timeSource,
        timeoutMilliseconds: COMMAND_CONFIRMATION_MILLISECONDS,
      });
      return null;
    } catch (error) {
      if (error instanceof CommandFailure) {
        return describeCommandFailure(error);
      }
      throw error;
    }
  }
}

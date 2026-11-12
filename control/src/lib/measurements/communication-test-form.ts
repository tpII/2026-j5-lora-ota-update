/**
 * The sender form of a communication test: the modulation both operators agree on, the number of
 * echoes and the neighbor that answers them, read into the configuration the test runs with.
 */
import { buildEchoCommand, normalizeNodeIdentifier } from "$lib/commands/console-command.ts";
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import type { SupportedModulation } from "$lib/radio/radio-settings.ts";
import {
  validateCommunicationTestConfiguration,
  type CommunicationTestConfiguration,
} from "./communication-test.ts";

export interface CommunicationTestForm extends SupportedModulation {
  count: number;
  /** The neighbor that answers, as the operator types it. */
  destination: string;
}

export interface CommunicationTestRequest {
  readonly configuration: CommunicationTestConfiguration;
  /** The destination as the console takes it, in uppercase and without spaces. */
  readonly destination: string;
  /** What is wrong with the destination, or null. */
  readonly destinationProblem: string | null;
  /** Every problem of the form, the destination included; empty when the test can start. */
  readonly problems: readonly string[];
}

/**
 * Reads the form of the node `self`, whose radio uses `preamble`: the test asks another node for
 * the echoes.
 */
export function readCommunicationTestForm(
  form: CommunicationTestForm,
  self: NodeIdentifier | null,
  preamble: number,
): CommunicationTestRequest {
  const configuration: CommunicationTestConfiguration = {
    sf: form.sf,
    bw: form.bw,
    cr: form.cr,
    count: form.count,
  };
  const destination = normalizeNodeIdentifier(form.destination);
  const command = buildEchoCommand(destination);
  const destinationProblem = !command.valid
    ? (command.problems[0]?.message ?? null)
    : destination === self
      ? "El destino tiene que ser otro nodo."
      : null;
  return {
    configuration,
    destination,
    destinationProblem,
    problems: [
      ...validateCommunicationTestConfiguration(configuration, preamble),
      ...(destinationProblem === null ? [] : [destinationProblem]),
    ],
  };
}

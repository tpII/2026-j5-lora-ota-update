import * as z from "zod/mini";
import { consoleEventSchema, type ConsoleEvent } from "./console-event.ts";

/**
 * A console line classified according to docs/protocol/console.md:
 * - "event": a JSON object that satisfies the contract;
 * - "unrecognized": a JSON object that does not (unknown event name or invalid fields); it is
 *   still an event emitted by the node, so it is recorded and exported;
 * - "debug": any other line, including malformed JSON.
 */
export type ParsedConsoleLine =
  | { readonly kind: "event"; readonly text: string; readonly event: ConsoleEvent }
  | {
      readonly kind: "unrecognized";
      readonly text: string;
      readonly object: Readonly<Record<string, unknown>>;
      /** Description of the deviation from the contract, in Spanish, for the operator. */
      readonly problem: string;
    }
  | { readonly kind: "debug"; readonly text: string };

/** Describes the first deviation from the contract, in Spanish, for the operator. */
function describeProblem(
  issue: z.core.$ZodIssue,
  object: Readonly<Record<string, unknown>>,
): string {
  if (issue.code === "invalid_union") {
    // Only the event name fails this way: no event of the contract has that name.
    return typeof object.ev === "string"
      ? `evento desconocido: ${object.ev}`
      : "falta el campo ev o no es un texto";
  }
  if (issue.path.length === 0) {
    // A rule that involves several fields of the event.
    return issue.message;
  }
  const field = z.core.toDotPath(issue.path);
  return issue.input === undefined
    ? `falta el campo ${field}`
    : `el campo ${field} debería ser ${issue.message}`;
}

/** Classifies one console line (without its line end). */
export function parseConsoleLine(line: string): ParsedConsoleLine {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!text.startsWith("{")) {
    return { kind: "debug", text };
  }
  let object: Record<string, unknown>;
  try {
    // Valid JSON that starts with { is always an object.
    object = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { kind: "debug", text };
  }
  if (object.truncated === true) {
    // The firmware never emits a cut object: it replaces an event that does not fit its buffer
    // with the header and this mark.
    const problem = "el nodo truncó el evento porque no entraba en su búfer";
    return { kind: "unrecognized", text, object, problem };
  }
  const result = consoleEventSchema.safeParse(object, { reportInput: true });
  if (!result.success) {
    const problem = describeProblem(result.error.issues[0], object);
    return { kind: "unrecognized", text, object, problem };
  }
  // The fields the contract does not define stay in the event, so the export keeps them.
  return { kind: "event", text, event: { ...object, ...result.data } };
}

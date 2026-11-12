/** The `error` events of a node: the commands it refused or failed to carry out. */
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import { appendBounded } from "$lib/utils/bounded-log.ts";

const MAXIMUM_ERROR_RECORDS = 50;

export interface NodeErrorRecord {
  readonly hostTime: number;
  readonly command: string;
  readonly reason: string;
  readonly detail: string | null;
  readonly code: number | null;
}

export interface ErrorRecordState {
  /** Newest last. */
  readonly errors: readonly NodeErrorRecord[];
}

export const INITIAL_ERROR_RECORD_STATE: ErrorRecordState = { errors: [] };

export function reduceErrorRecords<State extends ErrorRecordState>(
  state: State,
  event: ConsoleEvent,
  hostTime: number,
): State {
  if (event.ev !== "error") {
    return state;
  }
  const record: NodeErrorRecord = {
    hostTime,
    command: event.cmd,
    reason: event.reason,
    detail: event.detail ?? null,
    code: event.code ?? null,
  };
  return { ...state, errors: appendBounded(state.errors, record, MAXIMUM_ERROR_RECORDS) };
}

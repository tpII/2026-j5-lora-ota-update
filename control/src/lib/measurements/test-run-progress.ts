/**
 * The test runs one node transmits and receives, from its own `run_start`, `tx`, `run_done`,
 * `test_rx` and `run_end` events, and the rule that says whether a run is in progress on it. Two
 * other readers of the same events keep what this per-node view forgets, so a change to the run
 * events reaches them too: the test run ledger (test-run-ledger.ts) matches them across every node
 * and keeps every run, across reboots; the capacity test (`RunObservation` in
 * capacity-test-campaign.ts) follows the run of its point by number, and keeps counting a
 * reception across a reboot of the receiver.
 */
import type { ConsoleEvent, NodeIdentifier, RunEndEvent } from "$lib/console/console-event.ts";

const MAXIMUM_FINISHED_RECEPTIONS = 20;

/** A run this node transmits or transmitted. */
export interface SenderRunProgress {
  readonly run: number;
  readonly count: number;
  readonly size: number;
  readonly interval: number;
  /** TEST frames reported by `tx` so far. */
  readonly transmitted: number;
  readonly startHostTime: number;
  readonly completion: {
    readonly sent: number;
    readonly duration: number;
    readonly aborted: boolean;
    readonly hostTime: number;
  } | null;
}

/** A run this node receives or received from another node. */
export interface ReceptionProgress {
  readonly source: NodeIdentifier;
  readonly run: number;
  readonly count: number;
  readonly received: number;
  readonly lastIndex: number | null;
  readonly lastRssi: number | null;
  readonly lastSnr: number | null;
  readonly startHostTime: number;
  readonly end: RunEndEvent | null;
}

export interface TestRunProgressState {
  readonly senderRun: SenderRunProgress | null;
  /** Receptions in progress first, then the finished ones, newest first. */
  readonly receptions: readonly ReceptionProgress[];
}

export const INITIAL_TEST_RUN_PROGRESS_STATE: TestRunProgressState = {
  senderRun: null,
  receptions: [],
};

function orderReceptions(receptions: readonly ReceptionProgress[]): ReceptionProgress[] {
  const active = receptions.filter((reception) => reception.end === null);
  const finished = receptions
    .filter((reception) => reception.end !== null)
    .slice(0, MAXIMUM_FINISHED_RECEPTIONS);
  return [...active, ...finished];
}

function findOpenReception(
  receptions: readonly ReceptionProgress[],
  source: NodeIdentifier,
  run: number,
): ReceptionProgress | undefined {
  return receptions.find(
    (reception) => reception.source === source && reception.run === run && reception.end === null,
  );
}

export function reduceTestRunProgress<State extends TestRunProgressState>(
  state: State,
  event: ConsoleEvent,
  hostTime: number,
): State {
  switch (event.ev) {
    case "boot":
      // The runs of a node do not survive a reboot; the finished receptions stay as history.
      return {
        ...state,
        senderRun: null,
        receptions: state.receptions.filter((reception) => reception.end !== null),
      };
    case "run_start":
      return {
        ...state,
        senderRun: {
          run: event.run,
          count: event.count,
          size: event.size,
          interval: event.interval,
          transmitted: 0,
          startHostTime: hostTime,
          completion: null,
        },
      };
    case "tx": {
      const run = activeSenderRun(state);
      if (event.type !== "test" || run === null || event.run !== run.run) {
        return state;
      }
      return { ...state, senderRun: { ...run, transmitted: run.transmitted + 1 } };
    }
    case "run_done": {
      const run = state.senderRun;
      if (run === null || run.run !== event.run) {
        return state;
      }
      return {
        ...state,
        senderRun: {
          ...run,
          completion: {
            sent: event.sent,
            duration: event.duration,
            aborted: event.aborted,
            hostTime,
          },
        },
      };
    }
    case "test_rx": {
      const existing = findOpenReception(state.receptions, event.src, event.run);
      const updated: ReceptionProgress = {
        source: event.src,
        run: event.run,
        count: event.count,
        received: (existing?.received ?? 0) + 1,
        lastIndex: event.index,
        lastRssi: event.rssi,
        lastSnr: event.snr,
        startHostTime: existing?.startHostTime ?? hostTime,
        end: null,
      };
      const others = state.receptions.filter((reception) => reception !== existing);
      return { ...state, receptions: orderReceptions([updated, ...others]) };
    }
    case "run_end": {
      const existing = findOpenReception(state.receptions, event.src, event.run);
      const updated: ReceptionProgress = {
        source: event.src,
        run: event.run,
        count: event.count,
        received: event.received,
        lastIndex: existing?.lastIndex ?? null,
        lastRssi: existing?.lastRssi ?? null,
        lastSnr: existing?.lastSnr ?? null,
        startHostTime: existing?.startHostTime ?? hostTime,
        end: event,
      };
      const others = state.receptions.filter((reception) => reception !== existing);
      const active = others.filter((reception) => reception.end === null);
      const finished = others.filter((reception) => reception.end !== null);
      return { ...state, receptions: orderReceptions([...active, updated, ...finished]) };
    }
    default:
      return state;
  }
}

export function activeSenderRun(state: TestRunProgressState): SenderRunProgress | null {
  return state.senderRun !== null && state.senderRun.completion === null ? state.senderRun : null;
}

export function activeReceptions(state: TestRunProgressState): readonly ReceptionProgress[] {
  return state.receptions.filter((reception) => reception.end === null);
}

/**
 * True while the node transmits a run or receives one: the firmware refuses `radio` with `busy`.
 */
export function isRunActive(state: TestRunProgressState): boolean {
  return activeSenderRun(state) !== null || activeReceptions(state).length > 0;
}

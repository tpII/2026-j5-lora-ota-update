/**
 * State of a node derived from its event stream. The reducer is pure: every event yields a new
 * state object and leaves the previous one untouched, so views can compare states by reference.
 */
import type {
  BoardModel,
  ConsoleEvent,
  EchoEvent,
  EchoLostEvent,
  ErrorEvent,
  HelloNeighborReport,
  KeyKind,
  NodeIdentifier,
  PresenceState,
  RunEndEvent,
  WifiState,
} from "$lib/console/console-event.ts";
import { radioSettingsOf, type RadioSettings } from "$lib/radio/radio-settings.ts";

/** A node stops listing a neighbor after 60 s without packets from it (docs/protocol/frame.md). */
export const NEIGHBOR_EXPIRY_MILLISECONDS = 60_000;

const MAXIMUM_ECHO_RESULTS = 200;
const MAXIMUM_ERROR_RECORDS = 50;
const MAXIMUM_FINISHED_RECEPTIONS = 20;

export interface WifiStatus {
  readonly state: WifiState;
  readonly ssid: string;
  readonly channel: number;
  readonly clients: number;
}

/** HELLO messages of the node, from the last `presence` event. */
export interface PresenceStatus {
  readonly state: PresenceState;
  /** Seconds until a hold expires, as the node reported them; null when the HELLO are on. */
  readonly remaining: number | null;
  readonly hostTime: number;
}

/** Counters reported by the last `status` event. */
export interface NodeCounters {
  readonly transmitted: number;
  readonly received: number;
  readonly droppedLines: number;
  readonly freeHeap: number;
  readonly hostTime: number;
}

export interface NeighborRecord {
  readonly id: NodeIdentifier;
  readonly model: BoardModel;
  /** Version of the program the neighbor runs. */
  readonly version: number;
  /** Packets the neighbor reported as transmitted in its last HELLO. */
  readonly transmitted: number;
  readonly rssi: number;
  readonly snr: number;
  /** Frequency error of the last HELLO, in Hz; null when only a `neighbor` event was seen. */
  readonly frequencyError: number | null;
  readonly epoch: number | null;
  readonly sequence: number | null;
  /** Host time of the last packet received from the neighbor. */
  readonly lastHeardHostTime: number;
  /** How the neighbor hears its own neighbors, from its last HELLO. */
  readonly reportedNeighbors: readonly HelloNeighborReport[] | null;
  readonly helloCount: number;
}

export type EchoResult =
  | {
      readonly outcome: "answered";
      readonly hostTime: number;
      readonly destination: NodeIdentifier;
      readonly number: number;
      readonly size: number;
      readonly roundTripMicroseconds: number;
      /** Quality of the reply as received by this node. */
      readonly rssi: number;
      readonly snr: number;
      /** Quality of the request as received by the other node. */
      readonly remoteRssi: number;
      readonly remoteSnr: number;
    }
  | {
      readonly outcome: "lost";
      readonly hostTime: number;
      readonly destination: NodeIdentifier;
      readonly number: number;
      readonly size: number;
      readonly timeoutMilliseconds: number;
    };

export interface ServedEchoRecord {
  readonly hostTime: number;
  readonly source: NodeIdentifier;
  readonly number: number;
  readonly size: number;
  readonly rssi: number;
  readonly snr: number;
}

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

export interface NodeErrorRecord {
  readonly hostTime: number;
  readonly command: string;
  readonly reason: string;
  readonly detail: string | null;
  readonly code: number | null;
}

export interface NodeState {
  readonly identifier: NodeIdentifier | null;
  readonly model: BoardModel | null;
  readonly epoch: number | null;
  readonly firmwareVersion: string | null;
  readonly protocolVersion: number | null;
  readonly networkKey: KeyKind | null;
  /** Boots observed since the panel connected. */
  readonly bootCount: number;
  readonly radio: RadioSettings | null;
  readonly wifi: WifiStatus | null;
  readonly presence: PresenceStatus | null;
  readonly counters: NodeCounters | null;
  /** Sorted by identifier. */
  readonly neighbors: readonly NeighborRecord[];
  /** Oldest first. */
  readonly echoResults: readonly EchoResult[];
  readonly servedEchoes: readonly ServedEchoRecord[];
  readonly senderRun: SenderRunProgress | null;
  /** Receptions in progress first, then the finished ones, newest first. */
  readonly receptions: readonly ReceptionProgress[];
  /** Newest last. */
  readonly errors: readonly NodeErrorRecord[];
  readonly duplicateCount: number;
  readonly dropCount: number;
  readonly identifierConflictCount: number;
  /** Value of `t` and host time of the last event, to estimate the uptime of the node. */
  readonly lastEventNodeTime: number | null;
  readonly lastEventHostTime: number | null;
}

export const INITIAL_NODE_STATE: NodeState = {
  identifier: null,
  model: null,
  epoch: null,
  firmwareVersion: null,
  protocolVersion: null,
  networkKey: null,
  bootCount: 0,
  radio: null,
  wifi: null,
  presence: null,
  counters: null,
  neighbors: [],
  echoResults: [],
  servedEchoes: [],
  senderRun: null,
  receptions: [],
  errors: [],
  duplicateCount: 0,
  dropCount: 0,
  identifierConflictCount: 0,
  lastEventNodeTime: null,
  lastEventHostTime: null,
};

function appendBounded<Item>(items: readonly Item[], item: Item, capacity: number): Item[] {
  const result = [...items, item];
  return result.length > capacity ? result.slice(result.length - capacity) : result;
}

function upsertNeighbor(
  neighbors: readonly NeighborRecord[],
  identifier: NodeIdentifier,
  update: (previous: NeighborRecord | undefined) => NeighborRecord,
): NeighborRecord[] {
  const previous = neighbors.find((neighbor) => neighbor.id === identifier);
  const others = neighbors.filter((neighbor) => neighbor.id !== identifier);
  return [...others, update(previous)].sort((first, second) => first.id.localeCompare(second.id));
}

function recordEcho(
  state: NodeState,
  event: EchoEvent | EchoLostEvent,
  hostTime: number,
): NodeState {
  const result: EchoResult =
    event.ev === "echo"
      ? {
          outcome: "answered",
          hostTime,
          destination: event.dst,
          number: event.n,
          size: event.size,
          roundTripMicroseconds: event.rtt,
          rssi: event.rssi,
          snr: event.snr,
          remoteRssi: event.remote_rssi,
          remoteSnr: event.remote_snr,
        }
      : {
          outcome: "lost",
          hostTime,
          destination: event.dst,
          number: event.n,
          size: event.size,
          timeoutMilliseconds: event.timeout,
        };
  return { ...state, echoResults: appendBounded(state.echoResults, result, MAXIMUM_ECHO_RESULTS) };
}

function recordError(state: NodeState, event: ErrorEvent, hostTime: number): NodeState {
  const record: NodeErrorRecord = {
    hostTime,
    command: event.cmd,
    reason: event.reason,
    detail: event.detail ?? null,
    code: event.code ?? null,
  };
  return { ...state, errors: appendBounded(state.errors, record, MAXIMUM_ERROR_RECORDS) };
}

function orderReceptions(receptions: readonly ReceptionProgress[]): ReceptionProgress[] {
  const active = receptions.filter((reception) => reception.end === null);
  const finished = receptions
    .filter((reception) => reception.end !== null)
    .slice(0, MAXIMUM_FINISHED_RECEPTIONS);
  return [...active, ...finished];
}

function isSameReception(
  reception: ReceptionProgress,
  source: NodeIdentifier,
  run: number,
): boolean {
  return reception.source === source && reception.run === run;
}

/** Applies one event received at `hostTime` (milliseconds since 1970 on the host). */
export function applyConsoleEvent(
  state: NodeState,
  event: ConsoleEvent,
  hostTime: number,
): NodeState {
  const next = reduceEvent(state, event, hostTime);
  return { ...next, lastEventNodeTime: event.t, lastEventHostTime: hostTime };
}

function reduceEvent(state: NodeState, event: ConsoleEvent, hostTime: number): NodeState {
  switch (event.ev) {
    case "boot": {
      // Another node behind the same transport: start over. The same node rebooting keeps its
      // history but loses its neighbors and runs, as the firmware does.
      const base =
        state.identifier !== null && state.identifier !== event.id ? INITIAL_NODE_STATE : state;
      return {
        ...base,
        identifier: event.id,
        model: event.model,
        epoch: event.epoch,
        firmwareVersion: event.firmware,
        protocolVersion: event.protocol,
        networkKey: event.key,
        bootCount: base.bootCount + 1,
        // The node always boots with its HELLO messages on.
        presence: { state: "on", remaining: null, hostTime },
        neighbors: [],
        senderRun: null,
        receptions: base.receptions.filter((reception) => reception.end !== null),
      };
    }
    case "status": {
      const base =
        state.identifier !== null && state.identifier !== event.id ? INITIAL_NODE_STATE : state;
      return {
        ...base,
        identifier: event.id,
        model: event.model,
        epoch: event.epoch,
        counters: {
          transmitted: event.tx,
          received: event.rx,
          droppedLines: event.dropped,
          freeHeap: event.heap,
          hostTime,
        },
      };
    }
    case "radio":
      return { ...state, radio: radioSettingsOf(event) };
    case "wifi":
      return {
        ...state,
        wifi: {
          state: event.state,
          ssid: event.ssid,
          channel: event.channel,
          clients: event.clients,
        },
      };
    case "presence":
      return {
        ...state,
        presence: { state: event.state, remaining: event.remaining, hostTime },
      };
    case "neighbor":
      return {
        ...state,
        neighbors: upsertNeighbor(state.neighbors, event.id, (previous) => ({
          id: event.id,
          model: event.model,
          version: event.version,
          transmitted: event.tx,
          rssi: event.rssi,
          snr: event.snr,
          frequencyError: previous?.frequencyError ?? null,
          epoch: previous?.epoch ?? null,
          sequence: previous?.sequence ?? null,
          lastHeardHostTime: hostTime - event.age,
          reportedNeighbors: previous?.reportedNeighbors ?? null,
          helloCount: previous?.helloCount ?? 0,
        })),
      };
    case "hello":
      return {
        ...state,
        neighbors: upsertNeighbor(state.neighbors, event.src, (previous) => ({
          id: event.src,
          model: event.model,
          version: event.version,
          transmitted: event.tx,
          rssi: event.rssi,
          snr: event.snr,
          frequencyError: event.ferr,
          epoch: event.epoch,
          sequence: event.seq,
          lastHeardHostTime: hostTime,
          reportedNeighbors: event.neighbors,
          helloCount: (previous?.helloCount ?? 0) + 1,
        })),
      };
    case "echo":
    case "echo_lost":
      return recordEcho(state, event, hostTime);
    case "echo_served":
      return {
        ...state,
        servedEchoes: appendBounded(
          state.servedEchoes,
          {
            hostTime,
            source: event.src,
            number: event.n,
            size: event.size,
            rssi: event.rssi,
            snr: event.snr,
          },
          MAXIMUM_ECHO_RESULTS,
        ),
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
      const run = state.senderRun;
      if (
        event.type !== "test" ||
        run === null ||
        run.completion !== null ||
        event.run !== run.run
      ) {
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
      const existing = state.receptions.find(
        (reception) => isSameReception(reception, event.src, event.run) && reception.end === null,
      );
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
      const existing = state.receptions.find(
        (reception) => isSameReception(reception, event.src, event.run) && reception.end === null,
      );
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
    case "duplicate":
      return { ...state, duplicateCount: state.duplicateCount + 1 };
    case "drop":
      return { ...state, dropCount: state.dropCount + 1 };
    case "id_conflict":
      return { ...state, identifierConflictCount: state.identifierConflictCount + 1 };
    case "error":
      return recordError(state, event, hostTime);
  }
}

/** True while the node transmits a run or receives one: the firmware refuses `radio` with `busy`. */
export function isRunActive(state: NodeState): boolean {
  return (
    (state.senderRun !== null && state.senderRun.completion === null) ||
    state.receptions.some((reception) => reception.end === null)
  );
}

/** Milliseconds since the last packet of the neighbor, at host time `now`. */
export function neighborAge(neighbor: NeighborRecord, now: number): number {
  return Math.max(0, now - neighbor.lastHeardHostTime);
}

export function isNeighborExpired(neighbor: NeighborRecord, now: number): boolean {
  return neighborAge(neighbor, now) > NEIGHBOR_EXPIRY_MILLISECONDS;
}

/** Uptime of the node at host time `now`, estimated from the `t` of its last event. */
export function estimateUptime(state: NodeState, now: number): number | null {
  if (state.lastEventNodeTime === null || state.lastEventHostTime === null) {
    return null;
  }
  return state.lastEventNodeTime + Math.max(0, now - state.lastEventHostTime);
}

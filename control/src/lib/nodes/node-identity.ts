/**
 * Identity of a node, from its `boot` and `status` events, and the counters `status` reports.
 */
import type {
  BoardModel,
  ConsoleEvent,
  KeyKind,
  NodeIdentifier,
} from "$lib/console/console-event.ts";

/** Counters reported by the last `status` event. */
export interface NodeCounters {
  readonly transmitted: number;
  readonly received: number;
  readonly droppedLines: number;
  readonly freeHeap: number;
  readonly hostTime: number;
}

export interface NodeIdentityState {
  readonly identifier: NodeIdentifier | null;
  readonly model: BoardModel | null;
  readonly epoch: number | null;
  readonly firmwareVersion: string | null;
  readonly protocolVersion: number | null;
  readonly networkKey: KeyKind | null;
  /** Whether the node verifies images with the default operator public key. */
  readonly operatorKey: KeyKind | null;
  readonly counters: NodeCounters | null;
}

export const INITIAL_NODE_IDENTITY_STATE: NodeIdentityState = {
  identifier: null,
  model: null,
  epoch: null,
  firmwareVersion: null,
  protocolVersion: null,
  networkKey: null,
  operatorKey: null,
  counters: null,
};

/**
 * True when `event` identifies a node other than the one the state describes: another node is
 * behind the same transport, so the state starts over.
 */
export function identifiesAnotherNode(state: NodeIdentityState, event: ConsoleEvent): boolean {
  return (
    (event.ev === "boot" || event.ev === "status") &&
    state.identifier !== null &&
    state.identifier !== event.id
  );
}

export function reduceNodeIdentity<State extends NodeIdentityState>(
  state: State,
  event: ConsoleEvent,
  hostTime: number,
): State {
  switch (event.ev) {
    case "boot":
      return {
        ...state,
        identifier: event.id,
        model: event.model,
        epoch: event.epoch,
        firmwareVersion: event.firmware,
        protocolVersion: event.protocol,
        networkKey: event.key,
        operatorKey: event.operator_key,
      };
    case "status":
      return {
        ...state,
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
    default:
      return state;
  }
}

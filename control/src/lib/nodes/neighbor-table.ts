/**
 * The neighbors of a node, from the HELLO messages it hears (`hello`) and the entries of its
 * neighbor table that `status` lists (`neighbor`).
 */
import type {
  BoardModel,
  ConsoleEvent,
  HelloEvent,
  HelloNeighborReport,
  NeighborEvent,
  NodeIdentifier,
} from "$lib/console/console-event.ts";
import { isNeighborExpired as isNeighborExpiredAfter } from "$lib/protocol/protocol-contract.ts";
import type { VmFault } from "$lib/vm/virtual-machine.ts";

export interface NeighborRecord {
  readonly id: NodeIdentifier;
  /** Null until the neighbor announces a model of the contract in a HELLO. */
  readonly model: BoardModel | null;
  /** Active version of the neighbor: the program its VM runs. */
  readonly version: number;
  /** Available version of the neighbor: the highest whose verified image it holds. */
  readonly availableVersion: number;
  /** Last VM fault of the neighbor since its activation; null when there was none. */
  readonly vmFault: VmFault | null;
  /** True when the program of the neighbor faulted between its last two HELLO messages. */
  readonly vmFailing: boolean;
  /** Packets the neighbor reported as transmitted in its last HELLO. */
  readonly transmitted: number;
  readonly rssi: number;
  readonly snr: number;
  /** Frequency error of the last HELLO, in Hz; null when only a `neighbor` event was seen. */
  readonly frequencyError: number | null;
  /** Host time of the last packet received from the neighbor. */
  readonly lastHeardHostTime: number;
  /** How the neighbor hears its own neighbors, from its last HELLO. */
  readonly reportedNeighbors: readonly HelloNeighborReport[] | null;
  readonly helloCount: number;
}

export interface NeighborTableState {
  /** Sorted by identifier. */
  readonly neighbors: readonly NeighborRecord[];
}

export const INITIAL_NEIGHBOR_TABLE_STATE: NeighborTableState = { neighbors: [] };

/**
 * Host time of the last packet the observer heard from the neighbor an event describes, for an
 * event received at `hostTime`: a HELLO is heard now, a `neighbor` entry `age` milliseconds ago.
 */
export function neighborLastHeardHostTime(
  event: HelloEvent | NeighborEvent,
  hostTime: number,
): number {
  return event.ev === "hello" ? hostTime : hostTime - event.age;
}

function neighborRecordOf(
  event: HelloEvent | NeighborEvent,
  hostTime: number,
  previous: NeighborRecord | undefined,
): NeighborRecord {
  const announced = {
    model: event.model,
    version: event.version,
    availableVersion: event.available,
    vmFault: event.vm_fault,
    vmFailing: event.vm_failing,
    transmitted: event.tx,
    rssi: event.rssi,
    snr: event.snr,
    lastHeardHostTime: neighborLastHeardHostTime(event, hostTime),
  };
  return event.ev === "hello"
    ? {
        id: event.src,
        ...announced,
        frequencyError: event.ferr,
        reportedNeighbors: event.neighbors,
        helloCount: (previous?.helloCount ?? 0) + 1,
      }
    : {
        id: event.id,
        ...announced,
        frequencyError: previous?.frequencyError ?? null,
        reportedNeighbors: previous?.reportedNeighbors ?? null,
        helloCount: previous?.helloCount ?? 0,
      };
}

export function reduceNeighborTable<State extends NeighborTableState>(
  state: State,
  event: ConsoleEvent,
  hostTime: number,
): State {
  switch (event.ev) {
    case "boot":
      // The node forgets its neighbors when it reboots.
      return { ...state, neighbors: [] };
    case "hello":
    case "neighbor": {
      const identifier = event.ev === "hello" ? event.src : event.id;
      const previous = state.neighbors.find((neighbor) => neighbor.id === identifier);
      const others = state.neighbors.filter((neighbor) => neighbor.id !== identifier);
      return {
        ...state,
        neighbors: [...others, neighborRecordOf(event, hostTime, previous)].sort((first, second) =>
          first.id.localeCompare(second.id),
        ),
      };
    }
    default:
      return state;
  }
}

/** Milliseconds since the last packet of the neighbor, at host time `now`. */
export function neighborAge(neighbor: NeighborRecord, now: number): number {
  return Math.max(0, now - neighbor.lastHeardHostTime);
}

/** True when the node has dropped the neighbor from its table, at host time `now`. */
export function isNeighborExpired(neighbor: NeighborRecord, now: number): boolean {
  return isNeighborExpiredAfter(neighborAge(neighbor, now));
}

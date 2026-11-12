/**
 * What a node reports about echoes (docs/protocol/console.md): the result of each echo it asked for
 * (`echo` or `echo_lost`) and each echo it answered for another node (`echo_served`). The node
 * state, the echo series and both sides of the communication test keep these same records.
 */
import { appendBounded } from "$lib/utils/bounded-log.ts";
import type {
  ConsoleEvent,
  ConsoleEventOf,
  EchoEvent,
  EchoLostEvent,
  NodeIdentifier,
} from "$lib/console/console-event.ts";

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

/** One echo the node answered for another node. */
export interface ServedEcho {
  readonly hostTime: number;
  readonly source: NodeIdentifier;
  readonly number: number;
  readonly size: number;
  /** Quality of the request as this node received it. */
  readonly rssi: number;
  readonly snr: number;
}

/** True for the event that ends an echo this node asked `destination` for. */
export function isEchoResultEvent(
  event: ConsoleEvent,
  destination: NodeIdentifier,
): event is EchoEvent | EchoLostEvent {
  return (event.ev === "echo" || event.ev === "echo_lost") && event.dst === destination;
}

export function echoResultOf(event: EchoEvent | EchoLostEvent, hostTime: number): EchoResult {
  return event.ev === "echo"
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
}

export function servedEchoOf(event: ConsoleEventOf<"echo_served">, hostTime: number): ServedEcho {
  return {
    hostTime,
    source: event.src,
    number: event.n,
    size: event.size,
    rssi: event.rssi,
    snr: event.snr,
  };
}

const MAXIMUM_ECHO_RECORDS = 200;

export interface EchoRecordState {
  /** Oldest first. */
  readonly echoResults: readonly EchoResult[];
  /** Oldest first. */
  readonly servedEchoes: readonly ServedEcho[];
}

export const INITIAL_ECHO_RECORD_STATE: EchoRecordState = { echoResults: [], servedEchoes: [] };

export function reduceEchoRecords<State extends EchoRecordState>(
  state: State,
  event: ConsoleEvent,
  hostTime: number,
): State {
  switch (event.ev) {
    case "echo":
    case "echo_lost":
      return {
        ...state,
        echoResults: appendBounded(
          state.echoResults,
          echoResultOf(event, hostTime),
          MAXIMUM_ECHO_RECORDS,
        ),
      };
    case "echo_served":
      return {
        ...state,
        servedEchoes: appendBounded(
          state.servedEchoes,
          servedEchoOf(event, hostTime),
          MAXIMUM_ECHO_RECORDS,
        ),
      };
    default:
      return state;
  }
}

/** Round-trip latency per destination (metric M4): every `echo_lost` counts as a loss. */
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import type { EchoResult } from "$lib/nodes/node-state.ts";

export interface EchoStatistics {
  readonly destination: NodeIdentifier;
  readonly requested: number;
  readonly answered: number;
  readonly lost: number;
  /** Round-trip times in microseconds; null without answers. */
  readonly meanRoundTrip: number | null;
  readonly minimumRoundTrip: number | null;
  readonly maximumRoundTrip: number | null;
}

export function summarizeEchoResults(results: readonly EchoResult[]): EchoStatistics[] {
  const byDestination = new Map<NodeIdentifier, EchoResult[]>();
  for (const result of results) {
    const list = byDestination.get(result.destination) ?? [];
    list.push(result);
    byDestination.set(result.destination, list);
  }
  return [...byDestination.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([destination, list]) => {
      const roundTrips = list.flatMap((result) =>
        result.outcome === "answered" ? [result.roundTripMicroseconds] : [],
      );
      return {
        destination,
        requested: list.length,
        answered: roundTrips.length,
        lost: list.length - roundTrips.length,
        meanRoundTrip:
          roundTrips.length === 0
            ? null
            : roundTrips.reduce((sum, value) => sum + value, 0) / roundTrips.length,
        minimumRoundTrip: roundTrips.length === 0 ? null : Math.min(...roundTrips),
        maximumRoundTrip: roundTrips.length === 0 ? null : Math.max(...roundTrips),
      };
    });
}

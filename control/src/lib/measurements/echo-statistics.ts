/** Round-trip latency per destination (metric M4): every `echo_lost` counts as a loss. */
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import type { EchoResult } from "$lib/nodes/echo-records.ts";

/** Average, minimum and maximum of a quantity; null without samples. */
export interface SampleSummary {
  readonly average: number | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
}

export function summarizeSamples(values: readonly number[]): SampleSummary {
  if (values.length === 0) {
    return { average: null, minimum: null, maximum: null };
  }
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
  };
}

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
      const roundTrip = summarizeSamples(roundTrips);
      return {
        destination,
        requested: list.length,
        answered: roundTrips.length,
        lost: list.length - roundTrips.length,
        meanRoundTrip: roundTrip.average,
        minimumRoundTrip: roundTrip.minimum,
        maximumRoundTrip: roundTrip.maximum,
      };
    });
}

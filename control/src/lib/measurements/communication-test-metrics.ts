/**
 * Metrics of a communication test: link quality in each direction, delivery, round-trip time and
 * useful bits. The useful bits of an echo are the bits of its body, which crosses the link twice:
 * once in the request and once in the reply. The files of its export are in
 * communication-test-export.ts.
 */
import type { CommunicationTestSnapshot } from "./communication-test.ts";
import { summarizeSamples, type SampleSummary } from "./echo-statistics.ts";
import type { ServedEcho } from "$lib/nodes/echo-records.ts";
import { computeFrameLength, timeOnAirOfPayload } from "$lib/radio/time-on-air.ts";

export interface LinkQuality {
  readonly rssi: SampleSummary;
  readonly snr: SampleSummary;
}

export interface CommunicationTestMetrics {
  readonly requested: number;
  readonly answered: number;
  readonly lost: number;
  /** Answered over requested; null before the first result. */
  readonly deliveryRatio: number | null;
  /** Requests as the responder received them. */
  readonly forward: LinkQuality;
  /** Replies as the requester received them. */
  readonly reverse: LinkQuality;
  /** Round-trip time in microseconds. */
  readonly roundTrip: SampleSummary;
  /** Length of each echo frame, header and tag included, in bytes. */
  readonly frameLength: number;
  /** Time on air of each frame according to the Semtech formula, in microseconds. */
  readonly timeOnAirMicroseconds: number;
  /** Raw bit rate of the modulation: SF × BW / 2^SF × 4 / (4 + CR), in bits per second. */
  readonly nominalBitRate: number;
  /** Share of each frame that is body. */
  readonly usefulShare: number;
  /** Body bits delivered: twice the body of every answered echo. */
  readonly usefulBits: number;
  /** Useful bits over the time the answered echoes took, in bits per second. */
  readonly usefulBitRate: number | null;
}

export function nominalBitRateOf(settings: {
  readonly sf: number;
  readonly bw: number;
  readonly cr: number;
}): number {
  return ((settings.sf * settings.bw * 1000) / 2 ** settings.sf) * (4 / settings.cr);
}

export function computeCommunicationTestMetrics(
  snapshot: Pick<CommunicationTestSnapshot, "settings" | "exchanges">,
): CommunicationTestMetrics {
  const { settings, exchanges } = snapshot;
  const answered = exchanges.flatMap((exchange) =>
    exchange.outcome === "answered" ? [exchange] : [],
  );
  const frameLength = computeFrameLength(settings.size);
  const usefulBits = answered.length * 2 * settings.size * 8;
  const roundTripTotal = answered.reduce(
    (sum, exchange) => sum + exchange.roundTripMicroseconds,
    0,
  );
  return {
    requested: exchanges.length,
    answered: answered.length,
    lost: exchanges.length - answered.length,
    deliveryRatio: exchanges.length === 0 ? null : answered.length / exchanges.length,
    forward: {
      rssi: summarizeSamples(answered.map((exchange) => exchange.remoteRssi)),
      snr: summarizeSamples(answered.map((exchange) => exchange.remoteSnr)),
    },
    reverse: {
      rssi: summarizeSamples(answered.map((exchange) => exchange.rssi)),
      snr: summarizeSamples(answered.map((exchange) => exchange.snr)),
    },
    roundTrip: summarizeSamples(answered.map((exchange) => exchange.roundTripMicroseconds)),
    frameLength,
    timeOnAirMicroseconds: timeOnAirOfPayload(settings.size, settings),
    nominalBitRate: nominalBitRateOf(settings),
    usefulShare: settings.size / frameLength,
    usefulBits,
    usefulBitRate: roundTripTotal > 0 ? usefulBits / (roundTripTotal / 1_000_000) : null,
  };
}

/** What the receiver heard from one sender. */
export interface ServedEchoSummary {
  readonly source: string;
  readonly served: number;
  readonly rssi: SampleSummary;
  readonly snr: SampleSummary;
  readonly firstHostTime: number;
  readonly lastHostTime: number;
}

/** Echoes answered in receiver mode, grouped by sender in order of first appearance. */
export function summarizeServedEchoes(echoes: readonly ServedEcho[]): ServedEchoSummary[] {
  const bySource = new Map<string, ServedEcho[]>();
  for (const echo of echoes) {
    const list = bySource.get(echo.source) ?? [];
    list.push(echo);
    bySource.set(echo.source, list);
  }
  return [...bySource.entries()].map(([source, list]) => ({
    source,
    served: list.length,
    rssi: summarizeSamples(list.map((echo) => echo.rssi)),
    snr: summarizeSamples(list.map((echo) => echo.snr)),
    firstHostTime: list[0]?.hostTime ?? 0,
    lastHostTime: list.at(-1)?.hostTime ?? 0,
  }));
}

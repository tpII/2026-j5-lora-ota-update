/**
 * Metrics of a communication test and the files of its export: link quality in each direction,
 * delivery, round-trip time and useful bits. The useful bits of an echo are the bits of its body,
 * which crosses the link twice: once in the request and once in the reply.
 */
import type { CommunicationTestSnapshot, EchoExchange } from "./communication-test.ts";
import type { ReceiverModeSnapshot, ServedEcho } from "./communication-receiver.ts";
import {
  EVENTS_FILE_NAME,
  METADATA_FILE_NAME,
  SUMMARY_FILE_NAME,
  buildEventLines,
  formatCsvValue,
  formatLocalTimestamp,
  type ExportedEvent,
  type MeasurementDescription,
  type MeasurementFile,
  type ParticipatingNode,
} from "./measurement-export.ts";
import { timeOnAirFor } from "$lib/radio/radio-settings.ts";
import { computeFrameLength } from "$lib/radio/time-on-air.ts";

export const COMMUNICATION_TEST = "communication-test";
export const ECHOES_FILE_NAME = "echoes.csv";

/** Average, minimum and maximum of a quantity; null without samples. */
export interface SampleSummary {
  readonly average: number | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
}

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

function summarize(values: readonly number[]): SampleSummary {
  if (values.length === 0) {
    return { average: null, minimum: null, maximum: null };
  }
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
  };
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
      rssi: summarize(answered.map((exchange) => exchange.forwardRssi)),
      snr: summarize(answered.map((exchange) => exchange.forwardSnr)),
    },
    reverse: {
      rssi: summarize(answered.map((exchange) => exchange.reverseRssi)),
      snr: summarize(answered.map((exchange) => exchange.reverseSnr)),
    },
    roundTrip: summarize(answered.map((exchange) => exchange.roundTripMicroseconds)),
    frameLength,
    timeOnAirMicroseconds: timeOnAirFor(frameLength, settings),
    nominalBitRate: nominalBitRateOf(settings),
    usefulShare: settings.size / frameLength,
    usefulBits,
    usefulBitRate: roundTripTotal > 0 ? usefulBits / (roundTripTotal / 1_000_000) : null,
  };
}

/** Columns of summary.csv of a communication test, in order. */
export const COMMUNICATION_SUMMARY_COLUMNS = [
  "requester",
  "responder",
  "requester_model",
  "freq",
  "sf",
  "bw",
  "cr",
  "preamble",
  "power",
  "size",
  "frame_size",
  "count",
  "requested",
  "answered",
  "lost",
  "pdr",
  "forward_rssi_avg",
  "forward_rssi_min",
  "forward_rssi_max",
  "forward_snr_avg",
  "forward_snr_min",
  "forward_snr_max",
  "reverse_rssi_avg",
  "reverse_rssi_min",
  "reverse_rssi_max",
  "reverse_snr_avg",
  "reverse_snr_min",
  "reverse_snr_max",
  "rtt_avg",
  "rtt_min",
  "rtt_max",
  "toa_calc",
  "nominal_bitrate",
  "useful_share",
  "useful_bits",
  "useful_bitrate",
  "status",
] as const;

/** Columns of echoes.csv, in order. */
export const ECHO_COLUMNS = [
  "n",
  "host_time",
  "outcome",
  "rtt",
  "forward_rssi",
  "forward_snr",
  "reverse_rssi",
  "reverse_snr",
] as const;

function rounded(value: number | null, decimals: number): number | null {
  return value === null ? null : Number(value.toFixed(decimals));
}

function modelOf(nodes: readonly ParticipatingNode[], id: string): string | null {
  return nodes.find((node) => node.id === id)?.model ?? null;
}

export function buildCommunicationSummaryCsv(
  snapshot: CommunicationTestSnapshot,
  metrics: CommunicationTestMetrics,
  nodes: readonly ParticipatingNode[],
): string {
  const { settings } = snapshot;
  const row: {
    readonly [Column in (typeof COMMUNICATION_SUMMARY_COLUMNS)[number]]: string | number | null;
  } = {
    requester: snapshot.requester,
    responder: snapshot.responder,
    requester_model: modelOf(nodes, snapshot.requester),
    freq: settings.freq,
    sf: settings.sf,
    bw: settings.bw,
    cr: settings.cr,
    preamble: settings.preamble,
    power: snapshot.requesterRadio.power,
    size: settings.size,
    frame_size: metrics.frameLength,
    count: settings.count,
    requested: metrics.requested,
    answered: metrics.answered,
    lost: metrics.lost,
    pdr: rounded(metrics.deliveryRatio, 4),
    forward_rssi_avg: rounded(metrics.forward.rssi.average, 1),
    forward_rssi_min: metrics.forward.rssi.minimum,
    forward_rssi_max: metrics.forward.rssi.maximum,
    forward_snr_avg: rounded(metrics.forward.snr.average, 2),
    forward_snr_min: metrics.forward.snr.minimum,
    forward_snr_max: metrics.forward.snr.maximum,
    reverse_rssi_avg: rounded(metrics.reverse.rssi.average, 1),
    reverse_rssi_min: metrics.reverse.rssi.minimum,
    reverse_rssi_max: metrics.reverse.rssi.maximum,
    reverse_snr_avg: rounded(metrics.reverse.snr.average, 2),
    reverse_snr_min: metrics.reverse.snr.minimum,
    reverse_snr_max: metrics.reverse.snr.maximum,
    rtt_avg: rounded(metrics.roundTrip.average, 0),
    rtt_min: metrics.roundTrip.minimum,
    rtt_max: metrics.roundTrip.maximum,
    toa_calc: metrics.timeOnAirMicroseconds,
    nominal_bitrate: rounded(metrics.nominalBitRate, 1),
    useful_share: rounded(metrics.usefulShare, 4),
    useful_bits: metrics.usefulBits,
    useful_bitrate: rounded(metrics.usefulBitRate, 1),
    status: snapshot.status,
  };
  const header = COMMUNICATION_SUMMARY_COLUMNS.join(",");
  const values = COMMUNICATION_SUMMARY_COLUMNS.map((column) => formatCsvValue(row[column]));
  return `${header}\n${values.join(",")}\n`;
}

function echoRow(exchange: EchoExchange): (string | number | null)[] {
  if (exchange.outcome === "lost") {
    return [exchange.number, exchange.hostTime, "lost", null, null, null, null, null];
  }
  return [
    exchange.number,
    exchange.hostTime,
    "answered",
    exchange.roundTripMicroseconds,
    exchange.forwardRssi,
    exchange.forwardSnr,
    exchange.reverseRssi,
    exchange.reverseSnr,
  ];
}

export function buildEchoesCsv(exchanges: readonly EchoExchange[]): string {
  const lines = [ECHO_COLUMNS.join(",")];
  for (const exchange of exchanges) {
    lines.push(echoRow(exchange).map(formatCsvValue).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export type CommunicationTestRole = "sender" | "receiver";

/** Content of metadata.json of a communication test, on either side. */
export interface CommunicationTestMetadata {
  readonly test: typeof COMMUNICATION_TEST;
  readonly role: CommunicationTestRole;
  readonly date: string;
  readonly place: string;
  readonly distance_m: number | null;
  readonly antennas: string;
  readonly operators: string;
  readonly notes: string;
  readonly nodes: readonly ParticipatingNode[];
  readonly panel_version: string;
  /** The connected node: the one that sends the echoes, or the one that answers them. */
  readonly node: string;
  /** The neighbor the sender asked for echoes; null on the receiver. */
  readonly destination: string | null;
  readonly settings: {
    readonly freq: number;
    readonly preamble: number;
    readonly sync: number;
    readonly sf: number;
    readonly bw: number;
    readonly cr: number;
    readonly size: number | null;
    readonly count: number | null;
  };
}

export type CommunicationTestDescription = Omit<MeasurementDescription, "test">;

interface MetadataSubject {
  readonly role: CommunicationTestRole;
  readonly node: string;
  readonly destination: string | null;
  readonly settings: CommunicationTestMetadata["settings"];
}

function buildMetadataFile(
  subject: MetadataSubject,
  description: CommunicationTestDescription,
  nodes: readonly ParticipatingNode[],
  exportDate: Date,
  panelVersion: string,
  offsetMinutes?: number,
): MeasurementFile {
  const metadata: CommunicationTestMetadata = {
    test: COMMUNICATION_TEST,
    role: subject.role,
    date: formatLocalTimestamp(exportDate, offsetMinutes),
    place: description.place.trim(),
    distance_m: description.distanceMeters,
    antennas: description.antennas.trim(),
    operators: description.operators.trim(),
    notes: description.notes.trim(),
    nodes: [...nodes].sort((first, second) => first.id.localeCompare(second.id)),
    panel_version: panelVersion,
    node: subject.node,
    destination: subject.destination,
    settings: subject.settings,
  };
  return {
    name: METADATA_FILE_NAME,
    mediaType: "application/json",
    content: `${JSON.stringify(metadata, null, 2)}\n`,
  };
}

export function buildCommunicationTestFiles(
  snapshot: CommunicationTestSnapshot,
  description: CommunicationTestDescription,
  nodes: readonly ParticipatingNode[],
  events: Iterable<ExportedEvent>,
  exportDate: Date,
  panelVersion: string,
  offsetMinutes?: number,
): MeasurementFile[] {
  const metrics = computeCommunicationTestMetrics(snapshot);
  const subject: MetadataSubject = {
    role: "sender",
    node: snapshot.requester,
    destination: snapshot.responder,
    settings: snapshot.settings,
  };
  return [
    buildMetadataFile(subject, description, nodes, exportDate, panelVersion, offsetMinutes),
    { name: EVENTS_FILE_NAME, mediaType: "application/x-ndjson", content: buildEventLines(events) },
    {
      name: SUMMARY_FILE_NAME,
      mediaType: "text/csv",
      content: buildCommunicationSummaryCsv(snapshot, metrics, nodes),
    },
    { name: ECHOES_FILE_NAME, mediaType: "text/csv", content: buildEchoesCsv(snapshot.exchanges) },
  ];
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
    rssi: summarize(list.map((echo) => echo.rssi)),
    snr: summarize(list.map((echo) => echo.snr)),
    firstHostTime: list[0]?.hostTime ?? 0,
    lastHostTime: list.at(-1)?.hostTime ?? 0,
  }));
}

/** Columns of summary.csv on the receiver, in order: one row per sender. */
export const RECEIVER_SUMMARY_COLUMNS = [
  "node",
  "node_model",
  "source",
  "freq",
  "sf",
  "bw",
  "cr",
  "preamble",
  "power",
  "lna",
  "served",
  "rssi_avg",
  "rssi_min",
  "rssi_max",
  "snr_avg",
  "snr_min",
  "snr_max",
  "first_host_time",
  "last_host_time",
] as const;

/** Columns of echoes.csv on the receiver, in order. */
export const SERVED_ECHO_COLUMNS = ["n", "host_time", "src", "size", "rssi", "snr"] as const;

export function buildReceiverSummaryCsv(
  snapshot: ReceiverModeSnapshot,
  nodes: readonly ParticipatingNode[],
): string {
  const radio = snapshot.previousRadio;
  const lines = [RECEIVER_SUMMARY_COLUMNS.join(",")];
  for (const summary of summarizeServedEchoes(snapshot.servedEchoes)) {
    const row: {
      readonly [Column in (typeof RECEIVER_SUMMARY_COLUMNS)[number]]: string | number | null;
    } = {
      node: snapshot.node,
      node_model: modelOf(nodes, snapshot.node),
      source: summary.source,
      freq: radio.freq,
      sf: snapshot.modulation.sf,
      bw: snapshot.modulation.bw,
      cr: snapshot.modulation.cr,
      preamble: radio.preamble,
      power: radio.power,
      lna: radio.lna,
      served: summary.served,
      rssi_avg: rounded(summary.rssi.average, 1),
      rssi_min: summary.rssi.minimum,
      rssi_max: summary.rssi.maximum,
      snr_avg: rounded(summary.snr.average, 2),
      snr_min: summary.snr.minimum,
      snr_max: summary.snr.maximum,
      first_host_time: summary.firstHostTime,
      last_host_time: summary.lastHostTime,
    };
    lines.push(RECEIVER_SUMMARY_COLUMNS.map((column) => formatCsvValue(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function buildServedEchoesCsv(echoes: readonly ServedEcho[]): string {
  const lines = [SERVED_ECHO_COLUMNS.join(",")];
  for (const echo of echoes) {
    lines.push(
      [echo.number, echo.hostTime, echo.source, echo.size, echo.rssi, echo.snr]
        .map(formatCsvValue)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function buildReceiverFiles(
  snapshot: ReceiverModeSnapshot,
  description: CommunicationTestDescription,
  nodes: readonly ParticipatingNode[],
  events: Iterable<ExportedEvent>,
  exportDate: Date,
  panelVersion: string,
  offsetMinutes?: number,
): MeasurementFile[] {
  const radio = snapshot.previousRadio;
  const subject: MetadataSubject = {
    role: "receiver",
    node: snapshot.node,
    destination: null,
    settings: {
      freq: radio.freq,
      preamble: radio.preamble,
      sync: radio.sync,
      ...snapshot.modulation,
      size: null,
      count: null,
    },
  };
  return [
    buildMetadataFile(subject, description, nodes, exportDate, panelVersion, offsetMinutes),
    { name: EVENTS_FILE_NAME, mediaType: "application/x-ndjson", content: buildEventLines(events) },
    {
      name: SUMMARY_FILE_NAME,
      mediaType: "text/csv",
      content: buildReceiverSummaryCsv(snapshot, nodes),
    },
    {
      name: ECHOES_FILE_NAME,
      mediaType: "text/csv",
      content: buildServedEchoesCsv(snapshot.servedEchoes),
    },
  ];
}

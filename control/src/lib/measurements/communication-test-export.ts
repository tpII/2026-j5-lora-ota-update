/**
 * The export of each side of a communication test (docs/measurement-exports.md): the sender writes its
 * metrics and the result of each echo, the receiver what it heard from each sender and each echo it
 * answered.
 */
import type { CommunicationTestSnapshot } from "./communication-test.ts";
import type { ReceiverModeSnapshot } from "./communication-receiver.ts";
import {
  computeCommunicationTestMetrics,
  summarizeServedEchoes,
} from "./communication-test-metrics.ts";
import {
  SUMMARY_FILE_NAME,
  measurementExportOf,
  type CsvTable,
  type CsvValue,
  type ExportLayoutOf,
  type ExportedEvent,
  type MeasurementDescription,
  type MeasurementExport,
  type ParticipatingNode,
} from "./measurement-export.ts";
import type { EchoResult, ServedEcho } from "$lib/nodes/echo-records.ts";
import { roundToDecimals } from "$lib/utils/format.ts";

export const ECHOES_FILE_NAME = "echoes.csv";

/** Columns of summary.csv of the sender, in order. */
export const SENDER_SUMMARY_COLUMNS = [
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

/** Columns of echoes.csv of the sender, in order. */
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

/** Columns of summary.csv of the receiver, in order: one row per sender. */
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

/** Columns of echoes.csv of the receiver, in order. */
export const SERVED_ECHO_COLUMNS = ["n", "host_time", "src", "size", "rssi", "snr"] as const;

type RowOf<Columns extends readonly string[]> = { readonly [Column in Columns[number]]: CsvValue };

export type SenderSummaryRow = RowOf<typeof SENDER_SUMMARY_COLUMNS>;
export type EchoRow = RowOf<typeof ECHO_COLUMNS>;
export type ReceiverSummaryRow = RowOf<typeof RECEIVER_SUMMARY_COLUMNS>;
export type ServedEchoRow = RowOf<typeof SERVED_ECHO_COLUMNS>;

export const SENDER_SUMMARY_TABLE: CsvTable<SenderSummaryRow> = {
  fileName: SUMMARY_FILE_NAME,
  description: "las métricas",
  columns: SENDER_SUMMARY_COLUMNS,
};

export const ECHO_TABLE: CsvTable<EchoRow> = {
  fileName: ECHOES_FILE_NAME,
  description: "un renglón por eco",
  columns: ECHO_COLUMNS,
};

export const RECEIVER_SUMMARY_TABLE: CsvTable<ReceiverSummaryRow> = {
  fileName: SUMMARY_FILE_NAME,
  description: "una fila por emisor",
  columns: RECEIVER_SUMMARY_COLUMNS,
};

export const SERVED_ECHO_TABLE: CsvTable<ServedEchoRow> = {
  fileName: ECHOES_FILE_NAME,
  description: "un renglón por eco respondido",
  columns: SERVED_ECHO_COLUMNS,
};

export const SENDER_EXPORT_LAYOUT: ExportLayoutOf<[SenderSummaryRow, EchoRow]> = {
  test: "communication-test",
  role: "sender",
  metadata: null,
  events: "los eventos del nodo durante la prueba",
  tables: [SENDER_SUMMARY_TABLE, ECHO_TABLE],
};

export const RECEIVER_EXPORT_LAYOUT: ExportLayoutOf<[ReceiverSummaryRow, ServedEchoRow]> = {
  test: "communication-test",
  role: "receiver",
  metadata: null,
  events: "los eventos del nodo mientras estuvo activo el modo receptor",
  tables: [RECEIVER_SUMMARY_TABLE, SERVED_ECHO_TABLE],
};

function modelOf(nodes: readonly ParticipatingNode[], id: string): string | null {
  return nodes.find((node) => node.id === id)?.model ?? null;
}

export function buildSenderSummaryRow(
  snapshot: CommunicationTestSnapshot,
  nodes: readonly ParticipatingNode[],
): SenderSummaryRow {
  const { settings } = snapshot;
  const metrics = computeCommunicationTestMetrics(snapshot);
  return {
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
    pdr: roundToDecimals(metrics.deliveryRatio, 4),
    forward_rssi_avg: roundToDecimals(metrics.forward.rssi.average, 1),
    forward_rssi_min: metrics.forward.rssi.minimum,
    forward_rssi_max: metrics.forward.rssi.maximum,
    forward_snr_avg: roundToDecimals(metrics.forward.snr.average, 2),
    forward_snr_min: metrics.forward.snr.minimum,
    forward_snr_max: metrics.forward.snr.maximum,
    reverse_rssi_avg: roundToDecimals(metrics.reverse.rssi.average, 1),
    reverse_rssi_min: metrics.reverse.rssi.minimum,
    reverse_rssi_max: metrics.reverse.rssi.maximum,
    reverse_snr_avg: roundToDecimals(metrics.reverse.snr.average, 2),
    reverse_snr_min: metrics.reverse.snr.minimum,
    reverse_snr_max: metrics.reverse.snr.maximum,
    rtt_avg: roundToDecimals(metrics.roundTrip.average, 0),
    rtt_min: metrics.roundTrip.minimum,
    rtt_max: metrics.roundTrip.maximum,
    toa_calc: metrics.timeOnAirMicroseconds,
    nominal_bitrate: roundToDecimals(metrics.nominalBitRate, 1),
    useful_share: roundToDecimals(metrics.usefulShare, 4),
    useful_bits: metrics.usefulBits,
    useful_bitrate: roundToDecimals(metrics.usefulBitRate, 1),
    status: snapshot.status,
  };
}

export function echoRowOf(exchange: EchoResult): EchoRow {
  const answered = exchange.outcome === "answered" ? exchange : null;
  return {
    n: exchange.number,
    host_time: exchange.hostTime,
    outcome: exchange.outcome,
    rtt: answered?.roundTripMicroseconds ?? null,
    forward_rssi: answered?.remoteRssi ?? null,
    forward_snr: answered?.remoteSnr ?? null,
    reverse_rssi: answered?.rssi ?? null,
    reverse_snr: answered?.snr ?? null,
  };
}

export function buildReceiverSummaryRows(
  snapshot: ReceiverModeSnapshot,
  nodes: readonly ParticipatingNode[],
): ReceiverSummaryRow[] {
  const radio = snapshot.previousRadio;
  return summarizeServedEchoes(snapshot.servedEchoes).map((summary) => ({
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
    rssi_avg: roundToDecimals(summary.rssi.average, 1),
    rssi_min: summary.rssi.minimum,
    rssi_max: summary.rssi.maximum,
    snr_avg: roundToDecimals(summary.snr.average, 2),
    snr_min: summary.snr.minimum,
    snr_max: summary.snr.maximum,
    first_host_time: summary.firstHostTime,
    last_host_time: summary.lastHostTime,
  }));
}

export function servedEchoRowOf(echo: ServedEcho): ServedEchoRow {
  return {
    n: echo.number,
    host_time: echo.hostTime,
    src: echo.source,
    size: echo.size,
    rssi: echo.rssi,
    snr: echo.snr,
  };
}

/** The export of the sender: its metrics, its echoes and the events of the node during the test. */
export function buildSenderExport(
  snapshot: CommunicationTestSnapshot,
  description: MeasurementDescription,
  nodes: readonly ParticipatingNode[],
  events: Iterable<ExportedEvent>,
): MeasurementExport {
  return measurementExportOf(SENDER_EXPORT_LAYOUT, {
    description,
    nodes,
    metadata: {
      node: snapshot.requester,
      destination: snapshot.responder,
      settings: snapshot.settings,
    },
    events,
    rows: [[buildSenderSummaryRow(snapshot, nodes)], snapshot.exchanges.map(echoRowOf)],
  });
}

/** The export of the receiver: what it answered while receiver mode was active. */
export function buildReceiverExport(
  snapshot: ReceiverModeSnapshot,
  description: MeasurementDescription,
  nodes: readonly ParticipatingNode[],
  events: Iterable<ExportedEvent>,
): MeasurementExport {
  const radio = snapshot.previousRadio;
  return measurementExportOf(RECEIVER_EXPORT_LAYOUT, {
    description,
    nodes,
    metadata: {
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
    },
    events,
    rows: [buildReceiverSummaryRows(snapshot, nodes), snapshot.servedEchoes.map(servedEchoRowOf)],
  });
}

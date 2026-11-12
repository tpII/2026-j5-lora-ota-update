/**
 * The export of the updates (docs/measurement-exports.md): summary.csv holds one row per receiver of
 * each update, with M1, M2 and M3; metadata.json holds the commands the panel sent, so M1 can be
 * computed again from the files.
 */
import type { BoardModel, NodeIdentifier } from "$lib/console/console-event.ts";
import type { NodeConsoleEvent } from "$lib/measurements/event-journal.ts";
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
} from "$lib/measurements/measurement-export.ts";
import type { UpdateCommand, UpdateCommandRecord } from "./update-commands.ts";
import type { UpdateMetrics } from "./update-metrics.ts";
import { roundToDecimals } from "$lib/utils/format.ts";

/** Columns of summary.csv of the updates, in order. */
export const UPDATE_SUMMARY_COLUMNS = [
  "version",
  "origin",
  "node",
  "node_model",
  "connected",
  "load_host_time",
  "activate_host_time",
  "convergence_ms",
  "distribution_ms",
  "activation_ms",
  "node_available_ms",
  "node_active_ms",
  "transmitted",
  "fragment_count",
  "minimum",
  "efficiency",
  "node_transmitted",
  "node_starts_after_load",
  "transfer_fragments",
  "transfer_reports",
  "transfer_complete",
  "first_report_count",
  "first_report_missing",
  "missing_percent",
  "repair_rounds",
  "observed_reports",
  "image_fragments",
  "image_duration_ms",
] as const;

export type UpdateSummaryColumn = (typeof UPDATE_SUMMARY_COLUMNS)[number];

export type UpdateSummaryRow = { readonly [Column in UpdateSummaryColumn]: CsvValue };

/** The board model of every node the events name: consoles, HELLO senders and neighbors. */
export function boardModelsOf(events: Iterable<NodeConsoleEvent>): Map<NodeIdentifier, BoardModel> {
  const models = new Map<NodeIdentifier, BoardModel>();
  for (const { node, event } of events) {
    if (event.ev === "boot" || event.ev === "status") {
      models.set(node, event.model);
    } else if (event.ev === "hello" && event.model !== null) {
      models.set(event.src, event.model);
    } else if (event.ev === "neighbor" && event.model !== null) {
      models.set(event.id, event.model);
    }
  }
  return models;
}

function flag(value: boolean): string {
  return value ? "true" : "false";
}

function elapsed(from: number, to: number | null): number | null {
  return to === null ? null : Math.max(0, to - from);
}

/** One row per receiver of the update: the network values repeat on every row. */
export function buildUpdateSummaryRows(
  metrics: UpdateMetrics,
  models: ReadonlyMap<NodeIdentifier, BoardModel>,
): UpdateSummaryRow[] {
  const { convergence, efficiency } = metrics;
  return metrics.receivers.map((receiver) => {
    const times = convergence.nodes.find((node) => node.id === receiver.id);
    const transmission = efficiency.nodes.find((node) => node.id === receiver.id);
    return {
      version: metrics.version,
      origin: metrics.origin,
      node: receiver.id,
      node_model: models.get(receiver.id) ?? null,
      connected: flag(receiver.connected),
      load_host_time: metrics.loadHostTime,
      activate_host_time: metrics.activateHostTime,
      convergence_ms: convergence.total.milliseconds,
      distribution_ms: convergence.distribution.milliseconds,
      activation_ms: convergence.activation?.milliseconds ?? null,
      node_available_ms: elapsed(metrics.loadHostTime, times?.availableHostTime ?? null),
      node_active_ms: elapsed(metrics.loadHostTime, times?.activeHostTime ?? null),
      transmitted: efficiency.transmitted,
      fragment_count: efficiency.fragmentCount,
      minimum: efficiency.minimum,
      efficiency: roundToDecimals(efficiency.ratio, 4),
      node_transmitted: transmission?.transmitted ?? null,
      node_starts_after_load:
        transmission === undefined ? null : flag(transmission.startsAfterLoad),
      transfer_fragments: efficiency.transferFrames.fragments,
      transfer_reports: efficiency.transferFrames.reports,
      transfer_complete: flag(efficiency.transferFrames.complete),
      first_report_count: receiver.firstReport?.fragmentCount ?? null,
      first_report_missing: receiver.firstReport?.missing.length ?? null,
      missing_percent: roundToDecimals(receiver.missingPercent, 2),
      repair_rounds: receiver.repairRounds,
      observed_reports: receiver.observedReports,
      image_fragments: receiver.image?.fragments ?? null,
      image_duration_ms: receiver.image?.durationMilliseconds ?? null,
    };
  });
}

/** An update as metadata.json describes it. */
export interface UpdateMetadataEntry {
  readonly version: number;
  readonly origin: NodeIdentifier | null;
  readonly load_host_time: number;
  readonly activate_host_time: number | null;
  /** Nodes of the connection graph the metrics used. */
  readonly nodes: readonly NodeIdentifier[];
}

/** A `load_image` or `activate` command the panel sent. */
export interface UpdateMetadataCommand {
  readonly node: NodeIdentifier | null;
  readonly host_time: number;
  readonly command: UpdateCommand["kind"];
  readonly version: number;
}

export const UPDATE_SUMMARY_TABLE: CsvTable<UpdateSummaryRow> = {
  fileName: SUMMARY_FILE_NAME,
  description:
    "una fila por receptor de cada actualización cargada desde que se descartó el registro",
  columns: UPDATE_SUMMARY_COLUMNS,
};

export const UPDATE_EXPORT_LAYOUT: ExportLayoutOf<[UpdateSummaryRow]> = {
  test: "update",
  role: null,
  metadata: "con las órdenes load_image y activate del panel",
  events: "todos los eventos del registro",
  tables: [UPDATE_SUMMARY_TABLE],
};

export interface UpdateExportInput {
  readonly metrics: readonly UpdateMetrics[];
  readonly commands: readonly UpdateCommandRecord[];
  readonly description: MeasurementDescription;
  /** Nodes whose consoles contributed events. */
  readonly nodes: readonly ParticipatingNode[];
  readonly events: Iterable<ExportedEvent>;
  readonly models: ReadonlyMap<NodeIdentifier, BoardModel>;
}

/**
 * The export of the updates: M1, M2 and M3 per receiver, and in metadata.json each update and the
 * commands the panel sent, so M1 can be computed again from the files.
 */
export function buildUpdateExport(input: UpdateExportInput): MeasurementExport {
  const updates: UpdateMetadataEntry[] = input.metrics.map((metrics) => ({
    version: metrics.version,
    origin: metrics.origin,
    load_host_time: metrics.loadHostTime,
    activate_host_time: metrics.activateHostTime,
    nodes: metrics.nodes,
  }));
  const commands: UpdateMetadataCommand[] = input.commands.map((record) => ({
    node: record.node,
    host_time: record.hostTime,
    command: record.command.kind,
    version: record.command.version,
  }));
  return measurementExportOf(UPDATE_EXPORT_LAYOUT, {
    description: input.description,
    nodes: input.nodes,
    metadata: { updates, commands },
    events: input.events,
    rows: [input.metrics.flatMap((metrics) => buildUpdateSummaryRows(metrics, input.models))],
  });
}

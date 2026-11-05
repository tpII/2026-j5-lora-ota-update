/**
 * Files of the export of the updates (measurements/README.md): a folder
 * `<YYYY-MM-DD>-update-<NN>/` with metadata.json, events.jsonl and summary.csv. summary.csv holds
 * one row per receiver of each update, with M1, M2 and M3; metadata.json holds the commands the
 * panel sent, so M1 can be computed again from the files.
 */
import type { BoardModel, NodeIdentifier } from "$lib/console/console-event.ts";
import type { NodeConsoleEvent } from "./event-journal.ts";
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
import type { UpdateCommandRecord, UpdateMetrics } from "./update-metrics.ts";

export const UPDATE_TEST = "update";

export type UpdateDescription = Omit<MeasurementDescription, "test">;

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

export type UpdateSummaryRow = {
  readonly [Column in UpdateSummaryColumn]: string | number | null;
};

/**
 * Versions a node accepted with `load_image`, in the order the panel first sent them: a rejected
 * load starts no update.
 */
export function loadedUpdateVersions(commands: readonly UpdateCommandRecord[]): number[] {
  const versions: number[] = [];
  for (const record of commands) {
    if (
      record.command.kind === "load_image" &&
      record.accepted === true &&
      !versions.includes(record.command.version)
    ) {
      versions.push(record.command.version);
    }
  }
  return versions;
}

/** The board model of every node the events name: consoles, HELLO senders and neighbors. */
export function boardModelsOf(events: Iterable<NodeConsoleEvent>): Map<NodeIdentifier, BoardModel> {
  const models = new Map<NodeIdentifier, BoardModel>();
  for (const { node, event } of events) {
    if (event.ev === "boot" || event.ev === "status") {
      models.set(node, event.model);
    } else if (event.ev === "hello") {
      models.set(event.src, event.model);
    } else if (event.ev === "neighbor") {
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

function rounded(value: number | null, decimals: number): number | null {
  return value === null ? null : Number(value.toFixed(decimals));
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
      efficiency: rounded(efficiency.ratio, 4),
      node_transmitted: transmission?.transmitted ?? null,
      node_starts_after_load:
        transmission === undefined ? null : flag(transmission.startsAfterLoad),
      transfer_fragments: efficiency.transferFrames.fragments,
      transfer_reports: efficiency.transferFrames.reports,
      transfer_complete: flag(efficiency.transferFrames.complete),
      first_report_count: receiver.firstReport?.fragmentCount ?? null,
      first_report_missing: receiver.firstReport?.missing.length ?? null,
      missing_percent: rounded(receiver.missingPercent, 2),
      repair_rounds: receiver.repairRounds,
      observed_reports: receiver.observedReports,
      image_fragments: receiver.image?.fragments ?? null,
      image_duration_ms: receiver.image?.durationMilliseconds ?? null,
    };
  });
}

export function buildUpdateSummaryCsv(rows: readonly UpdateSummaryRow[]): string {
  const lines = [UPDATE_SUMMARY_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(UPDATE_SUMMARY_COLUMNS.map((column) => formatCsvValue(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
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
  readonly command: "load_image" | "activate";
  readonly version: number;
}

export interface UpdateMetadata {
  readonly test: typeof UPDATE_TEST;
  readonly date: string;
  readonly place: string;
  readonly distance_m: number | null;
  readonly antennas: string;
  readonly operators: string;
  readonly notes: string;
  readonly nodes: readonly ParticipatingNode[];
  readonly panel_version: string;
  readonly updates: readonly UpdateMetadataEntry[];
  readonly commands: readonly UpdateMetadataCommand[];
}

export interface UpdateExport {
  readonly metrics: readonly UpdateMetrics[];
  readonly commands: readonly UpdateCommandRecord[];
  readonly description: UpdateDescription;
  /** Nodes whose consoles contributed events. */
  readonly nodes: readonly ParticipatingNode[];
  readonly events: Iterable<ExportedEvent>;
  readonly models: ReadonlyMap<NodeIdentifier, BoardModel>;
  readonly exportDate: Date;
  readonly panelVersion: string;
  readonly offsetMinutes?: number;
}

export function buildUpdateMetadata(input: UpdateExport): UpdateMetadata {
  const { description } = input;
  return {
    test: UPDATE_TEST,
    date: formatLocalTimestamp(input.exportDate, input.offsetMinutes),
    place: description.place.trim(),
    distance_m: description.distanceMeters,
    antennas: description.antennas.trim(),
    operators: description.operators.trim(),
    notes: description.notes.trim(),
    nodes: [...input.nodes].sort((first, second) => first.id.localeCompare(second.id)),
    panel_version: input.panelVersion,
    updates: input.metrics.map((metrics) => ({
      version: metrics.version,
      origin: metrics.origin,
      load_host_time: metrics.loadHostTime,
      activate_host_time: metrics.activateHostTime,
      nodes: metrics.nodes,
    })),
    commands: input.commands.map((record) => ({
      node: record.node,
      host_time: record.hostTime,
      command: record.command.kind,
      version: record.command.version,
    })),
  };
}

export function buildUpdateFiles(input: UpdateExport): MeasurementFile[] {
  const rows = input.metrics.flatMap((metrics) => buildUpdateSummaryRows(metrics, input.models));
  return [
    {
      name: METADATA_FILE_NAME,
      mediaType: "application/json",
      content: `${JSON.stringify(buildUpdateMetadata(input), null, 2)}\n`,
    },
    {
      name: EVENTS_FILE_NAME,
      mediaType: "application/x-ndjson",
      content: buildEventLines(input.events),
    },
    { name: SUMMARY_FILE_NAME, mediaType: "text/csv", content: buildUpdateSummaryCsv(rows) },
  ];
}

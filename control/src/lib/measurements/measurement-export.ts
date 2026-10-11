/**
 * Files of a measurement export, as defined in measurements/README.md: a folder
 * `<YYYY-MM-DD>-<test>-<NN>/` with metadata.json, events.jsonl and summary.csv.
 */
import type { BoardModel, NodeIdentifier } from "$lib/console/console-event.ts";
import { SUMMARY_COLUMNS, type TestRunSummaryRow } from "./test-run-ledger.ts";

/** Tests exported from the Export section, with the summary of the test-run ledger. */
export const MEASUREMENT_TESTS = ["power-sweep", "capacity-test"] as const;
export type MeasurementTest = (typeof MEASUREMENT_TESTS)[number];

/** Every test that names an export folder; the communication test exports from its own section. */
export type ExportedTest = MeasurementTest | "communication-test";

export const METADATA_FILE_NAME = "metadata.json";
export const EVENTS_FILE_NAME = "events.jsonl";
export const SUMMARY_FILE_NAME = "summary.csv";

/** What the operator fills in before exporting. */
export interface MeasurementDescription {
  readonly test: MeasurementTest;
  readonly place: string;
  readonly distanceMeters: number | null;
  readonly antennas: string;
  readonly operators: string;
  readonly notes: string;
}

export interface ParticipatingNode {
  readonly id: NodeIdentifier;
  readonly model: BoardModel | null;
}

/** Content of metadata.json, with the field names of measurements/README.md. */
export interface MeasurementMetadata {
  readonly test: MeasurementTest;
  readonly date: string;
  readonly place: string;
  readonly distance_m: number | null;
  readonly antennas: string;
  readonly operators: string;
  readonly notes: string;
  readonly nodes: readonly ParticipatingNode[];
  readonly panel_version: string;
}

/** An event as recorded by the panel, ready to become a line of events.jsonl. */
export interface ExportedEvent {
  /** Line exactly as the firmware wrote it. */
  readonly text: string;
  /** The decoded line: a console event or any other JSON object the node wrote. */
  readonly object: object;
  /** Node whose console emitted the event. */
  readonly node: NodeIdentifier | null;
  /** Milliseconds since 1970 on the host when the event arrived. */
  readonly hostTime: number;
}

export interface MeasurementFile {
  readonly name: string;
  readonly mediaType: string;
  readonly content: string;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Wall-clock fields of `date` at the given offset from UTC, in minutes east of Greenwich. */
function shiftedFields(date: Date, offsetMinutes: number): Date {
  return new Date(date.getTime() + offsetMinutes * 60_000);
}

function localOffsetOf(date: Date): number {
  return -date.getTimezoneOffset();
}

/** Date on the computer, as YYYY-MM-DD. */
export function formatLocalDate(date: Date, offsetMinutes = localOffsetOf(date)): string {
  const shifted = shiftedFields(date, offsetMinutes);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Date and time on the computer in ISO 8601 with its offset, for example 2026-10-07T14:03:05-03:00. */
export function formatLocalTimestamp(date: Date, offsetMinutes = localOffsetOf(date)): string {
  const shifted = shiftedFields(date, offsetMinutes);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return (
    `${formatLocalDate(date, offsetMinutes)}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:` +
    `${pad(shifted.getUTCSeconds())}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

export function formatFolderName(
  localDate: string,
  test: ExportedTest,
  sequenceNumber: number,
): string {
  return `${localDate}-${test}-${pad(sequenceNumber)}`;
}

/** Folder for a new export: the number after the highest one already used that day for that test. */
export function selectNextFolderName(
  existingNames: Iterable<string>,
  localDate: string,
  test: ExportedTest,
): string {
  const prefix = `${localDate}-${test}-`;
  let highest = 0;
  for (const name of existingNames) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const suffix = name.slice(prefix.length);
    if (/^\d{2,}$/.test(suffix)) {
      highest = Math.max(highest, Number(suffix));
    }
  }
  return formatFolderName(localDate, test, highest + 1);
}

export function buildMetadata(
  description: MeasurementDescription,
  nodes: readonly ParticipatingNode[],
  exportDate: Date,
  panelVersion: string,
  offsetMinutes = localOffsetOf(exportDate),
): MeasurementMetadata {
  return {
    test: description.test,
    date: formatLocalTimestamp(exportDate, offsetMinutes),
    place: description.place.trim(),
    distance_m: description.distanceMeters,
    antennas: description.antennas.trim(),
    operators: description.operators.trim(),
    notes: description.notes.trim(),
    nodes: [...nodes].sort((first, second) => first.id.localeCompare(second.id)),
    panel_version: panelVersion,
  };
}

/**
 * One line of events.jsonl: the event as the firmware wrote it, with `node` and `host_time`
 * appended. The original text is kept, so numbers keep the format of the firmware.
 */
export function buildEventLine(event: ExportedEvent): string {
  const suffix = `"node":${JSON.stringify(event.node)},"host_time":${event.hostTime}`;
  const text = event.text.trimEnd();
  const appendable =
    text.endsWith("}") &&
    Object.keys(event.object).length > 0 &&
    !("node" in event.object) &&
    !("host_time" in event.object);
  if (appendable) {
    return `${text.slice(0, -1)},${suffix}}`;
  }
  return JSON.stringify({ ...event.object, node: event.node, host_time: event.hostTime });
}

export function buildEventLines(events: Iterable<ExportedEvent>): string {
  let content = "";
  for (const event of events) {
    content += `${buildEventLine(event)}\n`;
  }
  return content;
}

export function formatCsvValue(value: string | number | null): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** summary.csv: comma separator, decimal point and one header row. */
export function buildSummaryCsv(rows: readonly TestRunSummaryRow[]): string {
  const lines = [SUMMARY_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(SUMMARY_COLUMNS.map((column) => formatCsvValue(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function buildMeasurementFiles(
  metadata: MeasurementMetadata,
  events: Iterable<ExportedEvent>,
  rows: readonly TestRunSummaryRow[],
): MeasurementFile[] {
  return [
    {
      name: METADATA_FILE_NAME,
      mediaType: "application/json",
      content: `${JSON.stringify(metadata, null, 2)}\n`,
    },
    { name: EVENTS_FILE_NAME, mediaType: "application/x-ndjson", content: buildEventLines(events) },
    { name: SUMMARY_FILE_NAME, mediaType: "text/csv", content: buildSummaryCsv(rows) },
  ];
}

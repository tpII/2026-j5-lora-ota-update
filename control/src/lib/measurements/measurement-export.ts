/**
 * The export pipeline of docs/measurement-exports.md. Every export of the panel is a folder
 * `<YYYY-MM-DD>-<test>-<NN>/` with metadata.json, events.jsonl and one or more CSV files. Each test
 * describes its export once, as an ExportLayout (the files, known before exporting, with its CSV
 * tables listed once) and a MeasurementExport (their content, with the rows of each table in the
 * order of the layout); buildExportFolder turns the second into the files.
 */
import type { BoardModel, NodeIdentifier } from "$lib/console/console-event.ts";
import { pad } from "$lib/utils/format.ts";

/** Every test that names an export folder, as metadata.json writes it in `test`. */
export type ExportedTest = "power-sweep" | "capacity-test" | "communication-test" | "update";

/** Tests exported from the record of the measurement section, with the test-run ledger. */
export type MeasurementTest = Extract<ExportedTest, "power-sweep" | "capacity-test">;

export const METADATA_FILE_NAME = "metadata.json";
export const EVENTS_FILE_NAME = "events.jsonl";
export const SUMMARY_FILE_NAME = "summary.csv";

/** The measurement sheet as the exports take it: what the operator fills in before exporting. */
export interface MeasurementDescription {
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

export type CsvValue = string | number | null;

export type CsvRecord = { readonly [column: string]: CsvValue };

export interface CsvFileLayout {
  readonly fileName: string;
  /** What each row is, in Spanish, as the panel lists it next to the export button. */
  readonly description: string;
  readonly columns: readonly string[];
}

/** A CSV file whose columns are the fields of its rows. */
export interface CsvTable<Row extends CsvRecord> extends CsvFileLayout {
  readonly columns: readonly (keyof Row & string)[];
}

/** The files of an export, known before exporting. */
export interface ExportLayout {
  readonly test: ExportedTest;
  /** Side of a two-sided test the export comes from; metadata.json writes it after `test`. */
  readonly role: "sender" | "receiver" | null;
  /** What metadata.json holds besides the sheet, in Spanish; null when nothing else. */
  readonly metadata: string | null;
  /** Which events events.jsonl holds, in Spanish. */
  readonly events: string;
  /** The CSV files, in the order the folder lists them. */
  readonly tables: readonly CsvFileLayout[];
}

/** A layout whose CSV tables hold rows of the types of `Rows`, one type per table in order. */
export type ExportLayoutOf<Rows extends readonly CsvRecord[]> = ExportLayout & {
  readonly tables: { readonly [Index in keyof Rows]: CsvTable<Rows[Index]> };
};

export interface MeasurementExport {
  readonly layout: ExportLayout;
  readonly description: MeasurementDescription;
  /** Nodes whose consoles contributed events. */
  readonly nodes: readonly ParticipatingNode[];
  /** Fields of metadata.json after the common ones, in order. */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly events: Iterable<ExportedEvent>;
  /** The rows of each table of the layout, in its order. */
  readonly rows: readonly (readonly CsvRecord[])[];
}

/** What an export holds besides its layout, with one list of rows per table of the layout. */
export type MeasurementContent<Rows extends readonly CsvRecord[]> = Omit<
  MeasurementExport,
  "layout" | "rows"
> & {
  readonly rows: { readonly [Index in keyof Rows]: readonly Rows[Index][] };
};

/** An export of `layout`, with rows of the types of its tables. */
export function measurementExportOf<const Rows extends readonly CsvRecord[]>(
  layout: ExportLayoutOf<Rows>,
  content: MeasurementContent<Rows>,
): MeasurementExport {
  return { ...content, layout, rows: content.rows };
}

export interface MeasurementFile {
  readonly name: string;
  readonly content: string;
}

/** What the writer puts on disk: the files, and the test that names their folder. */
export interface ExportFolder {
  readonly test: ExportedTest;
  readonly files: readonly MeasurementFile[];
}

export function exportFileNames(layout: ExportLayout): string[] {
  return [METADATA_FILE_NAME, EVENTS_FILE_NAME, ...layout.tables.map((table) => table.fileName)];
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

/**
 * Date and time on the computer in ISO 8601 with its offset, for example
 * 2026-10-07T14:03:05-03:00.
 */
export function formatLocalTimestamp(date: Date, offsetMinutes = localOffsetOf(date)): string {
  const shifted = shiftedFields(date, offsetMinutes);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return (
    `${formatLocalDate(date, offsetMinutes)}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:` +
    `${pad(shifted.getUTCSeconds())}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

const DATE_PLACEHOLDER = "<AAAA-MM-DD>";
const SEQUENCE_PLACEHOLDER = "<NN>";

function folderNameOf(localDate: string, test: ExportedTest, sequence: string): string {
  return `${localDate}-${test}-${sequence}`;
}

export function formatFolderName(
  localDate: string,
  test: ExportedTest,
  sequenceNumber: number,
): string {
  return folderNameOf(localDate, test, pad(sequenceNumber));
}

/** The folder name of the exports of `test`, with placeholders for the date and the number. */
export function folderNamePattern(test: ExportedTest): string {
  return folderNameOf(DATE_PLACEHOLDER, test, SEQUENCE_PLACEHOLDER);
}

/**
 * Folder for a new export: the number after the highest one already used that day for that test.
 */
export function selectNextFolderName(
  existingNames: Iterable<string>,
  localDate: string,
  test: ExportedTest,
): string {
  const prefix = folderNameOf(localDate, test, "");
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

/** Content of metadata.json: the fields of docs/measurement-exports.md, then those of the test. */
export function buildMetadata(
  measurement: MeasurementExport,
  exportDate: Date,
  panelVersion: string,
  offsetMinutes = localOffsetOf(exportDate),
): Record<string, unknown> {
  const { layout, description } = measurement;
  return {
    test: layout.test,
    ...(layout.role === null ? {} : { role: layout.role }),
    date: formatLocalTimestamp(exportDate, offsetMinutes),
    place: description.place.trim(),
    distance_m: description.distanceMeters,
    antennas: description.antennas.trim(),
    operators: description.operators.trim(),
    notes: description.notes.trim(),
    nodes: [...measurement.nodes].sort((first, second) => first.id.localeCompare(second.id)),
    panel_version: panelVersion,
    ...measurement.metadata,
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

export function formatCsvValue(value: CsvValue): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** A CSV file as docs/measurement-exports.md defines them: comma, decimal point and one header row. */
export function buildCsv(columns: readonly string[], rows: readonly CsvRecord[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => formatCsvValue(row[column] ?? null)).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** The files of an export, in the order of its layout, and the test that names its folder. */
export function buildExportFolder(
  measurement: MeasurementExport,
  exportDate: Date,
  panelVersion: string,
  offsetMinutes?: number,
): ExportFolder {
  const metadata = buildMetadata(measurement, exportDate, panelVersion, offsetMinutes);
  return {
    test: measurement.layout.test,
    files: [
      { name: METADATA_FILE_NAME, content: `${JSON.stringify(metadata, null, 2)}\n` },
      { name: EVENTS_FILE_NAME, content: buildEventLines(measurement.events) },
      ...measurement.layout.tables.map((table, index) => ({
        name: table.fileName,
        content: buildCsv(table.columns, measurement.rows[index] ?? []),
      })),
    ],
  };
}

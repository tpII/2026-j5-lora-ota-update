/**
 * The export of the power sweep and of the capacity test (docs/measurement-exports.md): the events of
 * the nodes the operator chose and one summary.csv row per run and receiver, from the test-run
 * ledger.
 */
import {
  SUMMARY_FILE_NAME,
  measurementExportOf,
  type CsvTable,
  type ExportLayoutOf,
  type ExportedEvent,
  type MeasurementDescription,
  type MeasurementExport,
  type MeasurementTest,
  type ParticipatingNode,
} from "./measurement-export.ts";
import { SUMMARY_COLUMNS, type TestRunSummaryRow } from "./test-run-ledger.ts";

export const RUN_SUMMARY_TABLE: CsvTable<TestRunSummaryRow> = {
  fileName: SUMMARY_FILE_NAME,
  description: "una fila por receptor de cada corrida",
  columns: SUMMARY_COLUMNS,
};

function runLayoutOf(test: MeasurementTest): ExportLayoutOf<[TestRunSummaryRow]> {
  return {
    test,
    role: null,
    metadata: null,
    events: "los eventos de los nodos marcados",
    tables: [RUN_SUMMARY_TABLE],
  };
}

export const RUN_EXPORT_LAYOUTS: {
  readonly [Test in MeasurementTest]: ExportLayoutOf<[TestRunSummaryRow]>;
} = {
  "power-sweep": runLayoutOf("power-sweep"),
  "capacity-test": runLayoutOf("capacity-test"),
};

export function buildRunExport(
  test: MeasurementTest,
  description: MeasurementDescription,
  nodes: readonly ParticipatingNode[],
  events: Iterable<ExportedEvent>,
  rows: readonly TestRunSummaryRow[],
): MeasurementExport {
  return measurementExportOf(RUN_EXPORT_LAYOUTS[test], {
    description,
    nodes,
    metadata: {},
    events,
    rows: [rows],
  });
}

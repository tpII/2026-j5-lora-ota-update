/**
 * Writes the files of a measurement export. With the File System Access API the operator picks the
 * measurements/ folder and the panel creates the next free subfolder in it; without the API the
 * browser downloads the three files.
 */
import {
  formatFolderName,
  selectNextFolderName,
  type MeasurementFile,
  type MeasurementTest,
} from "./measurement-export.ts";

export type ExportMethod = "directory" | "download";

export interface ExportOutcome {
  readonly method: ExportMethod;
  /** Folder created, or the one suggested for the downloaded files. */
  readonly folderName: string;
  /** Name of the folder the operator picked, when the method is "directory". */
  readonly parentName: string | null;
}

/** Remembers the folder picked last time across sessions. */
const DIRECTORY_PICKER_IDENTIFIER = "j5-measurements";

export function isDirectoryPickerAvailable(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/** True when the operator dismissed a picker, which is not an error. */
export function isPickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function writeMeasurementToDirectory(
  files: readonly MeasurementFile[],
  localDate: string,
  test: MeasurementTest,
): Promise<ExportOutcome> {
  if (!isDirectoryPickerAvailable()) {
    throw new Error("Este navegador no permite elegir carpetas.");
  }
  const parent = await window.showDirectoryPicker({
    id: DIRECTORY_PICKER_IDENTIFIER,
    mode: "readwrite",
  });
  const existingNames: string[] = [];
  for await (const name of parent.keys()) {
    existingNames.push(name);
  }
  const folderName = selectNextFolderName(existingNames, localDate, test);
  const folder = await parent.getDirectoryHandle(folderName, { create: true });
  for (const file of files) {
    const handle = await folder.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(file.content);
    } finally {
      await writable.close();
    }
  }
  return { method: "directory", folderName, parentName: parent.name };
}

export function downloadMeasurementFiles(
  files: readonly MeasurementFile[],
  localDate: string,
  test: MeasurementTest,
): ExportOutcome {
  for (const file of files) {
    const url = URL.createObjectURL(new Blob([file.content], { type: file.mediaType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Revoke later: the download starts asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return { method: "download", folderName: formatFolderName(localDate, test, 1), parentName: null };
}

<script lang="ts">
  import type { ExportedTest, MeasurementDescription } from "$lib/measurements/measurement-export.ts";
  import type { ExportOutcome } from "$lib/measurements/measurement-writer.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  /**
   * The export of one test with the measurement sheet of the panel: a summary of the sheet, the
   * button and the outcome. The sheet itself is edited in `MeasurementSheetForm`.
   */
  let {
    panel,
    test,
    files,
    fileCount,
    exportFiles,
    disabled = false,
    label = "Exportar las métricas",
  }: {
    panel: ControlPanel;
    /** Test that names the folder. */
    test: ExportedTest;
    /** The files of the folder and what each holds, as a Spanish list. */
    files: string;
    /** Number of files, in words, for the browsers that download them: "cuatro". */
    fileCount: string;
    exportFiles: (description: Omit<MeasurementDescription, "test">) => Promise<ExportOutcome | null>;
    disabled?: boolean;
    label?: string;
  } = $props();

  const sheet = $derived(panel.measurementSheet);
  let exporting = $state(false);
  let outcome = $state<ExportOutcome | null>(null);
  let failure = $state<string | null>(null);

  const summary = $derived(
    [
      sheet.place.trim(),
      sheet.distance === null || !sheet.distanceValid ? "" : `${sheet.distance} m`,
      sheet.antennas.trim(),
    ]
      .filter((part) => part !== "")
      .join(" · "),
  );

  async function submit(): Promise<void> {
    exporting = true;
    failure = null;
    outcome = null;
    try {
      outcome = await exportFiles(sheet.description());
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      exporting = false;
    }
  }
</script>

<div class="flex flex-col gap-2 border-t border-line pt-3">
  <p class="panel-hint">
    {#if panel.directoryPickerAvailable}
      Pide la carpeta measurements/ del repositorio y crea dentro &lt;AAAA-MM-DD&gt;-{test}-&lt;NN&gt;/ con {files}.
    {:else}
      Crea la carpeta measurements/&lt;AAAA-MM-DD&gt;-{test}-&lt;NN&gt;/ con {files}. Este navegador no permite
      elegir carpetas: descarga los {fileCount} archivos para moverlos a mano.
    {/if}
  </p>
  <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      class="panel-button-primary"
      disabled={exporting || disabled || sheet.problem !== null}
      onclick={() => void submit()}
    >
      {exporting ? "Exportando…" : label}
    </button>
    {#if sheet.problem !== null}
      <span class="text-sm text-warn">{sheet.problem}</span>
    {:else}
      <span class="font-mono text-xs text-muted">Ficha: {summary}</span>
    {/if}
  </div>
  {#if outcome !== null}
    <p class="text-sm text-ok">
      {outcome.method === "directory"
        ? `Se exportó en ${outcome.parentName ?? ""}/${outcome.folderName}/.`
        : `Se descargaron los archivos; van en measurements/${outcome.folderName}/, con el número siguiente si esa carpeta ya existe.`}
    </p>
  {/if}
  {#if failure !== null}
    <p class="panel-error-text">No se pudo exportar: {failure}</p>
  {/if}
</div>

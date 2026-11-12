<script lang="ts">
  import {
    EVENTS_FILE_NAME,
    METADATA_FILE_NAME,
    exportFileNames,
    folderNamePattern,
  } from "$lib/measurements/measurement-export.ts";
  import { formatCardinal, formatConjunction } from "$lib/utils/format.ts";
  import type { ControlPanel, PanelExportKind } from "$lib/state/control-panel.svelte.ts";

  /**
   * The export of one test with the measurement sheet of the panel: a summary of the sheet, the
   * files of the layout, the button and the outcome, which the panel keeps with the record. The
   * sheet itself is edited in `MeasurementSheetForm`.
   */
  let {
    panel,
    kind,
    disabled = false,
    label = "Exportar las métricas",
  }: {
    panel: ControlPanel;
    kind: PanelExportKind;
    disabled?: boolean;
    label?: string;
  } = $props();

  const sheet = $derived(panel.measurementSheet);
  const layout = $derived(panel.exports[kind].layout);
  const result = $derived(panel.exportResults.get(kind) ?? null);
  let exporting = $state(false);

  const folder = $derived(folderNamePattern(layout.test));
  const files = $derived(
    formatConjunction(
      [
        [METADATA_FILE_NAME, layout.metadata] as const,
        [EVENTS_FILE_NAME, layout.events] as const,
        ...layout.tables.map((table) => [table.fileName, table.description] as const),
      ].map(([name, content]) => (content === null ? name : `${name} (${content})`)),
    ),
  );
  const fileCount = $derived(formatCardinal(exportFileNames(layout).length));

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
    try {
      await panel.exports[kind].write(sheet.description());
    } finally {
      exporting = false;
    }
  }
</script>

<div class="flex flex-col gap-2 border-t border-line pt-3">
  <p class="panel-hint">
    {#if panel.directoryPickerAvailable}
      Pide una carpeta y crea dentro {folder}/ con {files}.
    {:else}
      Crea una carpeta {folder}/ con {files}. Este navegador no permite elegir carpetas: descarga los
      {fileCount} archivos para moverlos a mano.
    {/if}
  </p>
  <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      class="panel-button panel-button-primary"
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
  {#if result?.kind === "written"}
    <p class="text-sm text-ok">
      {result.outcome.method === "directory"
        ? `Se exportó en ${result.outcome.parentName ?? ""}/${result.outcome.folderName}/.`
        : `Se descargaron los archivos; van en una carpeta ${result.outcome.folderName}/, con el número siguiente si esa carpeta ya existe.`}
    </p>
  {:else if result?.kind === "failed"}
    <p class="panel-error-text">No se pudo exportar: {result.message}</p>
  {/if}
</div>

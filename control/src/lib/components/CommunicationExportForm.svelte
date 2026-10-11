<script lang="ts">
  import type { CommunicationTestDescription } from "$lib/measurements/communication-test-metrics.ts";
  import type { ExportOutcome } from "$lib/measurements/measurement-writer.ts";

  let {
    contents,
    directoryPickerAvailable,
    exportFiles,
  }: {
    /** What summary.csv and echoes.csv hold on this side of the test. */
    contents: string;
    directoryPickerAvailable: boolean;
    exportFiles: (description: CommunicationTestDescription) => Promise<ExportOutcome | null>;
  } = $props();

  let place = $state("");
  let distance = $state<number | null>(null);
  let antennas = $state("");
  let operators = $state("");
  let notes = $state("");
  let exporting = $state(false);
  let outcome = $state<ExportOutcome | null>(null);
  let failure = $state<string | null>(null);

  async function submit(): Promise<void> {
    exporting = true;
    failure = null;
    outcome = null;
    try {
      outcome = await exportFiles({
        place,
        distanceMeters: distance === null || !Number.isFinite(distance) ? null : distance,
        antennas,
        operators,
        notes,
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      exporting = false;
    }
  }
</script>

<form
  class="flex flex-col gap-3 rounded-md border border-slate-200 p-3"
  onsubmit={(event) => {
    event.preventDefault();
    void submit();
  }}
>
  <div>
    <h4 class="text-sm font-semibold">Exportar las métricas</h4>
    <p class="panel-hint">
      Crea la carpeta measurements/&lt;AAAA-MM-DD&gt;-communication-test-&lt;NN&gt;/ con metadata.json,
      events.jsonl (los eventos del nodo durante la prueba), {contents}.
      {#if !directoryPickerAvailable}
        Este navegador no permite elegir carpetas: descarga los cuatro archivos.
      {/if}
    </p>
  </div>
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    <label class="panel-label">
      Lugar
      <input class="panel-input" type="text" bind:value={place} />
    </label>
    <label class="panel-label">
      Distancia entre los nodos (m)
      <input class="panel-input" type="number" min="0" step="any" bind:value={distance} />
    </label>
    <label class="panel-label">
      Antenas
      <input class="panel-input" type="text" placeholder="antenas o cargas usadas" bind:value={antennas} />
    </label>
    <label class="panel-label">
      Operadores
      <input class="panel-input" type="text" bind:value={operators} />
    </label>
    <label class="panel-label sm:col-span-2">
      Notas
      <input class="panel-input" type="text" bind:value={notes} />
    </label>
  </div>
  <div class="flex flex-wrap items-center gap-3">
    <button type="submit" class="panel-button-primary" disabled={exporting}>
      {exporting ? "Exportando…" : "Exportar las métricas"}
    </button>
    {#if outcome !== null}
      <span class="text-sm text-emerald-700">
        {outcome.method === "directory"
          ? `Se creó ${outcome.parentName ?? ""}/${outcome.folderName}.`
          : `Se descargaron los archivos; van en la carpeta ${outcome.folderName}.`}
      </span>
    {/if}
    {#if failure !== null}
      <span class="panel-error-text">No se pudo exportar: {failure}</span>
    {/if}
  </div>
</form>

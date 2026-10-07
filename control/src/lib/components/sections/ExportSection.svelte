<script lang="ts">
  import { MEASUREMENT_TESTS, type MeasurementTest } from "$lib/measurements/measurement-export.ts";
  import type { ExportOutcome } from "$lib/measurements/measurement-writer.ts";
  import { formatNumber, formatShortClockTime } from "$lib/utils/format.ts";
  import { MEASUREMENT_TEST_LABELS } from "$lib/utils/labels.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  let test = $state<MeasurementTest>("capacity-test");
  let place = $state("");
  let distance = $state<number | null>(null);
  let antennas = $state("");
  let operators = $state("");
  let notes = $state("");
  /** Nodes the operator left out; every other participating node is exported. */
  let excludedNodes = $state<string[]>([]);
  let exporting = $state(false);
  let outcome = $state<ExportOutcome | null>(null);
  let failure = $state<string | null>(null);

  const selectedNodes = $derived(
    panel.participatingNodes.map((node) => node.id).filter((id) => !excludedNodes.includes(id)),
  );
  const distanceValid = $derived(distance === null || (Number.isFinite(distance) && distance >= 0));
  const canExport = $derived(!exporting && selectedNodes.length > 0 && distanceValid && place.trim() !== "");

  function toggleNode(id: string, included: boolean): void {
    excludedNodes = included ? excludedNodes.filter((excluded) => excluded !== id) : [...excludedNodes, id];
  }

  async function exportMeasurement(): Promise<void> {
    exporting = true;
    failure = null;
    outcome = null;
    try {
      outcome = await panel.exportMeasurement(
        {
          test,
          place,
          distanceMeters: distance === null || !Number.isFinite(distance) ? null : distance,
          antennas,
          operators,
          notes,
        },
        selectedNodes,
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      exporting = false;
    }
  }

  function clearRecord(): void {
    if (
      window.confirm(
        "¿Descartar los eventos y las corridas registrados? Lo que no se haya exportado se pierde.",
      )
    ) {
      panel.clearMeasurementRecord();
      outcome = null;
    }
  }
</script>

<div class="flex flex-col gap-3">
  <form
    class="panel-card flex flex-col gap-4"
    onsubmit={(event) => {
      event.preventDefault();
      void exportMeasurement();
    }}
  >
    <div>
      <h3 class="panel-section-title">Ficha de la medición</h3>
      <p class="panel-hint">
        La exportación queda en una carpeta measurements/&lt;AAAA-MM-DD&gt;-&lt;prueba&gt;-&lt;NN&gt;/ con
        metadata.json, events.jsonl y summary.csv, según measurements/README.md.
        {#if panel.directoryPickerAvailable}
          El panel pide la carpeta measurements/ del repositorio y crea dentro la subcarpeta con el número
          siguiente.
        {:else}
          Este navegador no permite elegir carpetas: descarga los tres archivos para moverlos a mano.
        {/if}
      </p>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <label class="panel-label">
        Prueba
        <select class="panel-input" bind:value={test}>
          {#each MEASUREMENT_TESTS as value (value)}
            <option {value}>{MEASUREMENT_TEST_LABELS[value]}</option>
          {/each}
        </select>
      </label>
      <label class="panel-label">
        Lugar
        <input class="panel-input" type="text" placeholder="por ejemplo: Laboratorio de la facultad" bind:value={place} />
      </label>
      <label class="panel-label">
        Distancia entre los nodos (m)
        <input
          class="panel-input {distanceValid ? '' : 'panel-input-invalid'}"
          type="number"
          min="0"
          step="any"
          placeholder="vacío si no corresponde"
          bind:value={distance}
        />
      </label>
      <label class="panel-label">
        Antenas
        <input
          class="panel-input"
          type="text"
          placeholder="antenas o cargas usadas"
          bind:value={antennas}
        />
      </label>
      <label class="panel-label">
        Operadores
        <input class="panel-input" type="text" placeholder="personas que midieron" bind:value={operators} />
      </label>
      <label class="panel-label sm:col-span-2">
        Notas
        <textarea class="panel-input min-h-20" bind:value={notes}></textarea>
      </label>
    </div>

    <div class="flex flex-col gap-2">
      <span class="text-xs font-medium text-slate-600">Nodos que participaron</span>
      {#if panel.participatingNodes.length === 0}
        <p class="text-sm text-slate-600">Todavía no hay eventos de nodos identificados.</p>
      {:else}
        <div class="flex flex-wrap gap-4">
          {#each panel.participatingNodes as node (node.id)}
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!excludedNodes.includes(node.id)}
                onchange={(event) => toggleNode(node.id, event.currentTarget.checked)}
              />
              <span class="font-mono">{node.id}</span>
              <span class="text-slate-500">({node.model ?? "modelo desconocido"})</span>
            </label>
          {/each}
        </div>
      {/if}
    </div>

    <p class="text-sm text-slate-700">
      Registro: {formatNumber(panel.journalSize)} eventos
      {#if panel.journalStartTime !== null}desde las {formatShortClockTime(panel.journalStartTime)}{/if} y
      {formatNumber(panel.summaryRows.length)}
      {panel.summaryRows.length === 1 ? "corrida resumida" : "corridas resumidas"}.
      {#if panel.journalRejectedCount > 0}
        <span class="text-red-700">
          El registro está lleno: se descartaron {formatNumber(panel.journalRejectedCount)} eventos.
        </span>
      {/if}
    </p>

    <div class="flex flex-wrap gap-2">
      <button type="submit" class="panel-button-primary" disabled={!canExport}>
        {exporting ? "Exportando…" : "Exportar"}
      </button>
      <button type="button" class="panel-button-danger" disabled={panel.journalSize === 0 && panel.summaryRows.length === 0} onclick={clearRecord}>
        Descartar el registro
      </button>
    </div>
    {#if place.trim() === ""}
      <p class="panel-hint">Falta indicar el lugar de la medición.</p>
    {/if}

    {#if outcome !== null}
      <p class="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        {#if outcome.method === "directory"}
          Se exportó en {outcome.parentName}/{outcome.folderName}/.
        {:else}
          Se descargaron metadata.json, events.jsonl y summary.csv. Corresponde moverlos a
          measurements/{outcome.folderName}/, con el número siguiente si esa carpeta ya existe.
        {/if}
      </p>
    {/if}
    {#if failure !== null}
      <p class="panel-error-text">No se pudo exportar: {failure}</p>
    {/if}
  </form>
</div>

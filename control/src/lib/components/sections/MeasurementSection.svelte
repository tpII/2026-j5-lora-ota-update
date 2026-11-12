<script lang="ts">
  import MeasurementExportAction from "$lib/components/MeasurementExportAction.svelte";
  import { RECEPTION_OUTCOME_LABELS } from "$lib/measurements/test-run-ledger.ts";
  import MeasurementSheetForm from "$lib/components/MeasurementSheetForm.svelte";
  import RegulatoryChannelNote from "$lib/components/RegulatoryChannelNote.svelte";
  import CapacityTestSection from "$lib/components/sections/CapacityTestSection.svelte";
  import CommunicationTestSection from "$lib/components/sections/CommunicationTestSection.svelte";
  import RunSection from "$lib/components/sections/RunSection.svelte";
  import TabPanels from "$lib/components/TabPanels.svelte";
  import Tabs from "$lib/components/Tabs.svelte";
  import {
    formatBitRate,
    formatDeliveryRatio,
    formatModulation,
    formatNumber,
    formatPower,
    formatRssi,
    formatShortClockTime,
    formatSnr,
  } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import { MEASUREMENT_SECTIONS, type MeasurementSectionTest } from "$lib/state/panel-sections.ts";
  import { describeSectionProgress } from "$lib/state/radio-test-activity.ts";

  /**
   * The measurements: the power sweep, the capacity test and the communication test, chosen with the
   * «Prueba» control, then the runs recorded, the measurement sheet and the record that is exported.
   */
  let { panel }: { panel: ControlPanel } = $props();

  const TEST_IDS = { tabIdPrefix: "measurement-tab-", panelIdPrefix: "measurement-panel-" } as const;
  const MAXIMUM_VISIBLE_RUNS = 30;
  const EXPORT_LABELS: {
    readonly [Test in Exclude<MeasurementSectionTest, "communication-test">]: string;
  } = {
    "power-sweep": "Exportar el barrido de potencia",
    "capacity-test": "Exportar la prueba de capacidad",
  };

  let selectedTest = $state<MeasurementSectionTest>(MEASUREMENT_SECTIONS[0].key);

  const sheet = $derived(panel.measurementSheet);
  const visibleRuns = $derived(panel.runs.slice(-MAXIMUM_VISIBLE_RUNS).toReversed());
  const recordEmpty = $derived(
    panel.journalSize === 0 &&
      panel.summaryRows.length === 0 &&
      panel.update.record.commands.length === 0,
  );

  /** For each test, where it runs, in Spanish; absent when it does not run. */
  const progressNotes = $derived(describeSectionProgress(panel.activities));

  function clearRecord(): void {
    if (
      window.confirm(
        "¿Descartar los eventos y las corridas registrados? Lo que no se haya exportado se pierde. También se reinician las métricas de la actualización, que se cuentan desde que se descartó el registro.",
      )
    ) {
      panel.clearMeasurementRecord();
    }
  }
</script>

<div class="flex flex-col gap-3">
  <RegulatoryChannelNote />

  <div class="flex flex-wrap items-center gap-3">
    <span id="measurement-test-caption" class="sr-only">Prueba</span>
    <Tabs
      tabs={MEASUREMENT_SECTIONS}
      bind:selected={selectedTest}
      {...TEST_IDS}
      labelledby="measurement-test-caption"
      variant="outline"
    >
      {#snippet badge(test)}
        {@const note = progressNotes.get(test)}
        {#if note !== undefined}
          <span class="panel-badge text-ok">{note}</span>
        {/if}
      {/snippet}
    </Tabs>
  </div>

  <TabPanels
    tabs={MEASUREMENT_SECTIONS}
    selected={selectedTest}
    {...TEST_IDS}
    panels={{
      "power-sweep": powerSweep,
      "capacity-test": capacityTest,
      "communication-test": communicationTest,
    }}
  />

  {#if selectedTest !== "communication-test"}
    <section class="panel-card flex flex-col gap-3" aria-labelledby="recorded-runs-title" data-testid="recorded-runs">
      <h3 id="recorded-runs-title" class="panel-section-title">Corridas registradas</h3>
      {#if visibleRuns.length === 0}
        <p class="text-sm text-muted">Todavía no hay corridas registradas.</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="panel-table">
            <thead>
              <tr>
                <th>Inicio</th>
                <th>Emisor</th>
                <th>Corrida</th>
                <th>Modulación</th>
                <th>Potencia</th>
                <th>Largo</th>
                <th>Transmitidos</th>
                <th>Receptor</th>
                <th>Recibidos</th>
                <th>PDR</th>
                <th>RSSI medio</th>
                <th>SNR media</th>
                <th>Goodput</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {#each visibleRuns as run (`${run.sender}:${run.run}:${run.startHostTime}`)}
                {@const rowCount = Math.max(1, run.receptions.length)}
                {#each run.receptions.length === 0 ? [null] : run.receptions as reception, index (reception?.receiver ?? "none")}
                  <tr>
                    {#if index === 0}
                      <td rowspan={rowCount} class="font-mono text-xs">
                        {run.startHostTime === null ? "—" : formatShortClockTime(run.startHostTime)}
                      </td>
                      <td rowspan={rowCount} class="font-mono font-semibold">{run.sender}</td>
                      <td rowspan={rowCount}>{run.run}</td>
                      <td rowspan={rowCount} class="whitespace-nowrap">
                        {run.settings === null ? "—" : formatModulation(run.settings)}
                      </td>
                      <td rowspan={rowCount} class="whitespace-nowrap">{formatPower(run.settings?.power)}</td>
                      <td rowspan={rowCount}>{run.size === null ? "—" : `${run.size} B`}</td>
                      <td rowspan={rowCount} class="whitespace-nowrap">
                        {formatNumber(run.completion?.sent ?? run.transmitted)} de {formatNumber(run.count)}
                        {#if run.completion?.aborted}<span class="text-warn">(detenida)</span>{/if}
                      </td>
                    {/if}
                    {#if reception === null}
                      <td colspan="7" class="text-faint">
                        {run.completion === null
                          ? "Transmitiendo…"
                          : "Ningún nodo conectado al panel escuchaba ese canal."}
                      </td>
                    {:else}
                      <td class="font-mono">{reception.receiver}</td>
                      <td>{formatNumber(reception.received)}</td>
                      <td class="whitespace-nowrap">{formatDeliveryRatio(reception.row?.pdr)}</td>
                      <td class="whitespace-nowrap">{formatRssi(reception.row?.rssi_avg)}</td>
                      <td class="whitespace-nowrap">{formatSnr(reception.row?.snr_avg)}</td>
                      <td class="whitespace-nowrap">{formatBitRate(reception.row?.goodput)}</td>
                      <td class="whitespace-nowrap" data-outcome={reception.outcome}>{RECEPTION_OUTCOME_LABELS[reception.outcome]}</td>
                    {/if}
                  </tr>
                {/each}
              {/each}
            </tbody>
          </table>
        </div>
        <p class="panel-hint">
          Goodput = recibidos × largo × 8 / duración de la corrida en el emisor. Un receptor que no oyó ningún
          paquete no informa la corrida: el panel la cierra sin paquetes cuando vence su plazo.
        </p>
      {/if}
    </section>
  {/if}

  <MeasurementSheetForm sheet={panel.measurementSheet} />

  <section class="panel-card flex flex-col gap-3" aria-labelledby="measurement-record-title">
    <h3 id="measurement-record-title" class="panel-section-title">Registro</h3>

    <p class="text-sm text-muted">
      {formatNumber(panel.journalSize)} {panel.journalSize === 1 ? "evento" : "eventos"} de los nodos conectados
      {#if panel.journalStartTime !== null}desde las {formatShortClockTime(panel.journalStartTime)}{/if} y
      {formatNumber(panel.summaryRows.length)}
      {panel.summaryRows.length === 1 ? "corrida resumida" : "corridas resumidas"}.
      {#if panel.journalRejectedCount > 0}
        <span class="text-danger">
          El registro está lleno: se {panel.journalRejectedCount === 1 ? "descartó" : "descartaron"} {formatNumber(panel.journalRejectedCount)} {panel.journalRejectedCount === 1 ? "evento" : "eventos"}.
        </span>
      {/if}
    </p>

    {#if selectedTest === "communication-test"}
      <p class="panel-hint">
        Cada modo de la prueba de comunicación se exporta desde sus resultados, arriba: el emisor cuando la
        prueba termina y el receptor cuando se lo desactiva.
      </p>
    {:else}
      {@const test = selectedTest}
      <div class="flex flex-col gap-2">
        <span class="panel-caption">Nodos que participaron</span>
        {#if panel.participatingNodes.length === 0}
          <p class="text-sm text-muted">Todavía no hay eventos de nodos identificados.</p>
        {:else}
          <div class="flex flex-wrap gap-4">
            {#each panel.participatingNodes as node (node.id)}
              <label class="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!sheet.excludedNodes.includes(node.id)}
                  onchange={(event) => sheet.setNodeIncluded(node.id, event.currentTarget.checked)}
                />
                <span class="font-mono">{node.id}</span>
                <span class="text-faint">({node.model ?? "placa desconocida"})</span>
              </label>
            {/each}
          </div>
          {#if panel.exportedNodes.length === 0}
            <p class="panel-hint">Hay que marcar al menos un nodo para exportar.</p>
          {/if}
        {/if}
      </div>

      <MeasurementExportAction
        {panel}
        kind={test}
        label={EXPORT_LABELS[test]}
        disabled={panel.exportedNodes.length === 0}
      />
    {/if}

    <div class="flex flex-wrap gap-2">
      <button type="button" class="panel-button panel-button-danger" disabled={recordEmpty} onclick={clearRecord}>
        Descartar el registro
      </button>
    </div>
  </section>
</div>

{#snippet powerSweep()}
  <RunSection {panel} />
{/snippet}

{#snippet capacityTest()}
  <CapacityTestSection {panel} />
{/snippet}

{#snippet communicationTest()}
  <CommunicationTestSection {panel} />
{/snippet}

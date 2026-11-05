<script lang="ts">
  import MeasurementExportAction from "$lib/components/MeasurementExportAction.svelte";
  import MeasurementSheetForm from "$lib/components/MeasurementSheetForm.svelte";
  import RegulatoryChannelNote from "$lib/components/RegulatoryChannelNote.svelte";
  import CapacityTestSection from "$lib/components/sections/CapacityTestSection.svelte";
  import CommunicationTestSection from "$lib/components/sections/CommunicationTestSection.svelte";
  import RunSection from "$lib/components/sections/RunSection.svelte";
  import type { ExportedTest, MeasurementDescription } from "$lib/measurements/measurement-export.ts";
  import type { ExportOutcome } from "$lib/measurements/measurement-writer.ts";
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
  import { MEASUREMENT_SECTION_TEST_LABELS, RECEPTION_OUTCOME_LABELS } from "$lib/utils/labels.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  /**
   * The measurements: the power sweep, the capacity test and the communication test, chosen with the
   * «Prueba» control, then the runs recorded, the measurement sheet and the record that is exported.
   */
  let { panel }: { panel: ControlPanel } = $props();

  type SectionTest = Exclude<ExportedTest, "update">;

  const TESTS: readonly SectionTest[] = ["power-sweep", "capacity-test", "communication-test"];
  const MAXIMUM_VISIBLE_RUNS = 30;
  const EXPORT_LABELS: { readonly [Test in Exclude<SectionTest, "communication-test">]: string } = {
    "power-sweep": "Exportar el barrido de potencia",
    "capacity-test": "Exportar la prueba de capacidad",
  };

  let selectedTest = $state<SectionTest>("power-sweep");
  /** Grows at each discard of the record, so that the export forgets its last outcome. */
  let recordGeneration = $state(0);

  const sheet = $derived(panel.measurementSheet);
  const exportedNodes = $derived(
    panel.participatingNodes.map((node) => node.id).filter((id) => !sheet.excludedNodes.includes(id)),
  );
  const visibleRuns = $derived(panel.runs.slice(-MAXIMUM_VISIBLE_RUNS).toReversed());
  const recordEmpty = $derived(
    panel.journalSize === 0 && panel.summaryRows.length === 0 && panel.updateCommands.length === 0,
  );

  /** For each test, the node it runs on, in Spanish, or null when it does not run. */
  const progressNotes = $derived.by((): { readonly [Test in SectionTest]: string | null } => {
    const campaignSender = panel.isCampaignActive ? (panel.campaign?.sender ?? null) : null;
    const manualSenders = panel.connections
      .filter(
        (connection) =>
          connection.status === "open" &&
          connection.state.identifier !== null &&
          connection.state.identifier !== campaignSender &&
          connection.state.senderRun !== null &&
          connection.state.senderRun.completion === null,
      )
      .map((connection) => connection.state.identifier);
    const communicationTest = panel.communicationTest;
    const receiverMode = panel.receiverMode;
    return {
      "power-sweep": manualSenders.length === 0 ? null : `en curso en ${manualSenders.join(", ")}`,
      "capacity-test": campaignSender === null ? null : `en curso en ${campaignSender}`,
      "communication-test":
        panel.isCommunicationTestActive && communicationTest !== null
          ? `en curso en ${communicationTest.requester}`
          : panel.isReceiverModeActive && receiverMode !== null
            ? `modo receptor en ${receiverMode.node}`
            : null,
    };
  });

  function selectAdjacentTest(event: KeyboardEvent): void {
    const index = TESTS.indexOf(selectedTest);
    let next: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (index + 1) % TESTS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index - 1 + TESTS.length) % TESTS.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = TESTS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const test = TESTS[next];
    if (test !== undefined) {
      selectedTest = test;
      document.getElementById(`measurement-tab-${test}`)?.focus();
    }
  }

  function exportSelectedMeasurement(
    description: Omit<MeasurementDescription, "test">,
  ): Promise<ExportOutcome | null> {
    const test = selectedTest;
    if (test === "communication-test") {
      return Promise.resolve(null);
    }
    return panel.exportMeasurement({ test, ...description }, exportedNodes);
  }

  function clearRecord(): void {
    if (
      window.confirm(
        "¿Descartar los eventos y las corridas registrados? Lo que no se haya exportado se pierde. También se reinician las métricas de la actualización, que se cuentan desde que se descartó el registro.",
      )
    ) {
      panel.clearMeasurementRecord();
      recordGeneration += 1;
    }
  }
</script>

<div class="flex flex-col gap-3">
  <RegulatoryChannelNote />

  <div class="flex flex-wrap items-center gap-3">
    <span id="measurement-test-caption" class="panel-caption sr-only">Prueba</span>
    <div
      class="flex flex-wrap gap-1"
      role="tablist"
      aria-labelledby="measurement-test-caption"
      tabindex="-1"
      onkeydown={selectAdjacentTest}
    >
      {#each TESTS as test (test)}
        {@const note = progressNotes[test]}
        <button
          id="measurement-tab-{test}"
          type="button"
          role="tab"
          aria-selected={selectedTest === test}
          aria-controls="measurement-panel-{test}"
          tabindex={selectedTest === test ? 0 : -1}
          class="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm {selectedTest === test
            ? 'border-neon bg-neon/5 text-neon'
            : 'border-line-strong text-muted hover:border-neon/70 hover:text-ink'}"
          onclick={() => (selectedTest = test)}
        >
          {MEASUREMENT_SECTION_TEST_LABELS[test]}
          {#if note !== null}
            <span class="panel-badge text-ok">{note}</span>
          {/if}
        </button>
      {/each}
    </div>
  </div>

  <div
    id="measurement-panel-power-sweep"
    role="tabpanel"
    aria-labelledby="measurement-tab-power-sweep"
    hidden={selectedTest !== "power-sweep"}
  >
    <RunSection {panel} />
  </div>
  <div
    id="measurement-panel-capacity-test"
    role="tabpanel"
    aria-labelledby="measurement-tab-capacity-test"
    hidden={selectedTest !== "capacity-test"}
  >
    <CapacityTestSection {panel} />
  </div>
  <div
    id="measurement-panel-communication-test"
    role="tabpanel"
    aria-labelledby="measurement-tab-communication-test"
    hidden={selectedTest !== "communication-test"}
  >
    <CommunicationTestSection {panel} />
  </div>

  {#if selectedTest !== "communication-test"}
    <section class="panel-card flex flex-col gap-3" aria-labelledby="recorded-runs-title">
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
                      <td class="whitespace-nowrap">{RECEPTION_OUTCOME_LABELS[reception.outcome]}</td>
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

  <MeasurementSheetForm {panel} />

  <section class="panel-card flex flex-col gap-3" aria-labelledby="measurement-record-title">
    <h3 id="measurement-record-title" class="panel-section-title">Registro</h3>

    <p class="text-sm text-muted">
      {formatNumber(panel.journalSize)} eventos de los nodos conectados
      {#if panel.journalStartTime !== null}desde las {formatShortClockTime(panel.journalStartTime)}{/if} y
      {formatNumber(panel.summaryRows.length)}
      {panel.summaryRows.length === 1 ? "corrida resumida" : "corridas resumidas"}.
      {#if panel.journalRejectedCount > 0}
        <span class="text-danger">
          El registro está lleno: se descartaron {formatNumber(panel.journalRejectedCount)} eventos.
        </span>
      {/if}
    </p>

    {#if selectedTest === "communication-test"}
      <p class="panel-hint">
        Cada modo de la prueba de comunicación se exporta desde sus resultados, arriba: el emisor cuando la
        prueba termina y el receptor cuando se lo desactiva.
      </p>
    {:else}
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
          {#if exportedNodes.length === 0}
            <p class="panel-hint">Hay que marcar al menos un nodo para exportar.</p>
          {/if}
        {/if}
      </div>

      {#key `${selectedTest}:${recordGeneration}`}
        <MeasurementExportAction
          {panel}
          test={selectedTest}
          files="metadata.json, events.jsonl (los eventos de los nodos marcados) y summary.csv (una fila por receptor de cada corrida)"
          fileCount="tres"
          label={EXPORT_LABELS[selectedTest]}
          disabled={exportedNodes.length === 0}
          exportFiles={exportSelectedMeasurement}
        />
      {/key}
    {/if}

    <div class="flex flex-wrap gap-2">
      <button type="button" class="panel-button-danger" disabled={recordEmpty} onclick={clearRecord}>
        Descartar el registro
      </button>
    </div>
  </section>
</div>

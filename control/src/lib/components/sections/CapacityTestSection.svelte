<script lang="ts">
  import {
    DEFAULT_CAPACITY_TEST_CONFIGURATION,
    SERIES_LABELS,
    buildCapacityTestPlan,
    estimatePlanDurationMilliseconds,
    estimatePointDurationMilliseconds,
    usesBenchBandwidths,
    validateCapacityTestConfiguration,
  } from "$lib/measurements/capacity-test-plan.ts";
  import {
    capacityTestConfigurationOf,
    capacityTestFormOf,
    type CapacityTestForm,
  } from "$lib/measurements/capacity-test-form.ts";
  import {
    BANDWIDTHS_KILOHERTZ,
    CODING_RATE_DENOMINATORS,
    FREQUENCY_DECIMALS,
    MAXIMUM_FREQUENCY_MEGAHERTZ,
    MAXIMUM_PREAMBLE_LENGTH,
    MAXIMUM_RUN_COUNT,
    MAXIMUM_SYNC_WORD,
    MAXIMUM_TEST_SIZE,
    MINIMUM_FREQUENCY_MEGAHERTZ,
    MINIMUM_PREAMBLE_LENGTH,
    MINIMUM_RUN_COUNT,
    MINIMUM_SYNC_WORD,
    MINIMUM_TEST_SIZE,
    ON_AIR_BANDWIDTH_KILOHERTZ,
    SPREADING_FACTORS,
  } from "$lib/protocol/protocol-contract.ts";
  import {
    CAMPAIGN_STATUS_LABELS,
    POINT_STATUS_LABELS,
  } from "$lib/measurements/capacity-test-campaign.ts";
  import { BENCH_BANDWIDTHS_KILOHERTZ } from "$lib/radio/radio-settings.ts";
  import { findSummaryRow, type TestRunSummaryRow } from "$lib/measurements/test-run-ledger.ts";
  import TargetNodeLine from "$lib/components/TargetNodeLine.svelte";
  import TestProgress from "$lib/components/TestProgress.svelte";
  import {
    formatBitRate,
    formatCodingRate,
    formatDisjunction,
    formatDeliveryRatio,
    formatDuration,
    formatModulation,
    formatNumber,
    formatRssi,
    formatSnr,
  } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  let receiverKey = $state("");
  let form = $state<CapacityTestForm>(capacityTestFormOf(DEFAULT_CAPACITY_TEST_CONFIGURATION));

  const candidates = $derived(panel.nodes.identified);
  const campaign = $derived(panel.campaign.snapshot);
  const campaignActive = $derived(panel.campaign.isActive);
  /**
   * The sender is the node chosen above. While a test runs, the form shows its own sender, which
   * choosing another node does not move, and keeps its receiver.
   */
  const target = $derived(panel.testTarget("capacity-test"));
  const sender = $derived(target.connection);
  const senderKey = $derived(sender?.key ?? "");
  const receiverCandidates = $derived(candidates.filter((connection) => connection.key !== senderKey));

  $effect(() => {
    if (campaignActive) {
      return;
    }
    if (!receiverCandidates.some((connection) => connection.key === receiverKey)) {
      receiverKey = receiverCandidates[0]?.key ?? "";
    }
  });

  const configuration = $derived(capacityTestConfigurationOf(form));
  const problems = $derived(validateCapacityTestConfiguration(configuration));
  const plan = $derived(problems.length === 0 ? buildCapacityTestPlan(configuration) : []);
  const planDuration = $derived(estimatePlanDurationMilliseconds(plan));
  const benchBandwidthsInUse = $derived(usesBenchBandwidths(configuration));
  const refusal = $derived(panel.refusal("capacity-test", senderKey, receiverKey));

  function startCampaign(): void {
    if (problems.length === 0 && refusal === null) {
      panel.startCampaign(configuration, senderKey, receiverKey);
    }
  }

  function summaryRowOf(run: number | null): TestRunSummaryRow | null {
    if (campaign === null || run === null) {
      return null;
    }
    return findSummaryRow(panel.runs, campaign.sender, run, campaign.receiver);
  }

</script>

<div class="flex flex-col gap-3">
  <form
    class="panel-card flex flex-col gap-4"
    onsubmit={(event) => {
      event.preventDefault();
      startCampaign();
    }}
  >
    <div>
      <h3 class="panel-section-title">Configuración de la prueba</h3>
      <p class="panel-hint">
        En cada punto el panel envía el mismo comando radio a los dos nodos, espera a que ambos confirmen los
        parámetros, hace que el emisor transmita la corrida con los paquetes seguidos (intervalo 0) y espera el
        informe del receptor. Un punto que falla queda marcado y la prueba sigue con el siguiente. La potencia
        de transmisión y el LNA quedan como estén: se ajustan en la radio del nodo elegido, en la pestaña Red.
      </p>
    </div>
    <TargetNodeLine {target} role="Emisor" />

    <fieldset class="flex flex-col gap-4" disabled={campaignActive}>
      <div class="flex flex-wrap items-end gap-3">
        <label class="panel-label">
          Receptor
          <select class="panel-input" bind:value={receiverKey} disabled={receiverCandidates.length === 0}>
            {#each receiverCandidates as connection (connection.key)}
              <option value={connection.key}>{connection.state.identifier} ({connection.state.model ?? "placa desconocida"})</option>
            {/each}
          </select>
        </label>
        {#if candidates.length < 2}
          <p class="panel-error-text">La prueba necesita dos nodos conectados e identificados.</p>
        {/if}
      </div>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label class="panel-label">
          Frecuencia (MHz)
          <input
            class="panel-input"
            type="number"
            min={MINIMUM_FREQUENCY_MEGAHERTZ}
            max={MAXIMUM_FREQUENCY_MEGAHERTZ}
            step={10 ** -FREQUENCY_DECIMALS}
            bind:value={form.freq}
          />
        </label>
        <label class="panel-label">
          Preámbulo (símbolos)
          <input
            class="panel-input"
            type="number"
            min={MINIMUM_PREAMBLE_LENGTH}
            max={MAXIMUM_PREAMBLE_LENGTH}
            step="1"
            bind:value={form.preamble}
          />
        </label>
        <label class="panel-label">
          Palabra de sincronismo
          <input
            class="panel-input"
            type="number"
            min={MINIMUM_SYNC_WORD}
            max={MAXIMUM_SYNC_WORD}
            step="1"
            bind:value={form.sync}
          />
        </label>
        <label class="panel-label">
          Tasa de código
          <select class="panel-input" bind:value={form.codingRate}>
            {#each CODING_RATE_DENOMINATORS as value (value)}
              <option {value}>{formatCodingRate(value)}</option>
            {/each}
          </select>
        </label>
        <label class="panel-label">
          Largo del cuerpo (bytes)
          <input
            class="panel-input"
            type="number"
            min={MINIMUM_TEST_SIZE}
            max={MAXIMUM_TEST_SIZE}
            step="1"
            bind:value={form.payloadSize}
          />
        </label>
        <label class="panel-label">
          Paquetes por punto
          <input
            class="panel-input"
            type="number"
            min={MINIMUM_RUN_COUNT}
            max={MAXIMUM_RUN_COUNT}
            step="1"
            bind:value={form.packetCount}
          />
        </label>
      </div>

      <div class="flex flex-wrap items-end gap-6">
        <div class="flex flex-col gap-1">
          <span class="panel-caption">Anchos de banda</span>
          <div class="flex gap-3">
            {#each BANDWIDTHS_KILOHERTZ as bandwidth (bandwidth)}
              <label class="flex items-center gap-1 text-sm">
                <input type="checkbox" value={bandwidth} bind:group={form.bandwidths} />
                {bandwidth} kHz
              </label>
            {/each}
          </div>
        </div>
        <label class="panel-label">
          Desde
          <select class="panel-input" bind:value={form.firstSpreadingFactor}>
            {#each SPREADING_FACTORS as value (value)}
              <option {value}>SF{value}</option>
            {/each}
          </select>
        </label>
        <label class="panel-label">
          Hasta
          <select class="panel-input" bind:value={form.lastSpreadingFactor}>
            {#each SPREADING_FACTORS as value (value)}
              <option {value}>SF{value}</option>
            {/each}
          </select>
        </label>
      </div>

      <div class="flex flex-col gap-2">
        <label class="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" bind:checked={form.payloadSweepEnabled} />
          Agregar un barrido de largos del cuerpo en dos modulaciones
        </label>
        {#if form.payloadSweepEnabled}
          <div class="flex flex-wrap items-end gap-3 pl-6">
            <label class="panel-label">
              Largos (bytes, separados por coma)
              <input class="panel-input w-56" type="text" bind:value={form.payloadSweepSizes} />
            </label>
            {#each form.payloadSweepModulations as modulation, index (index)}
              <div class="flex items-end gap-2">
                <label class="panel-label">
                  Modulación {index + 1}
                  <select class="panel-input" bind:value={modulation.sf}>
                    {#each SPREADING_FACTORS as value (value)}
                      <option {value}>SF{value}</option>
                    {/each}
                  </select>
                </label>
                <select class="panel-input" aria-label="Ancho de banda de la modulación {index + 1}" bind:value={modulation.bw}>
                  {#each BANDWIDTHS_KILOHERTZ as value (value)}
                    <option {value}>{value} kHz</option>
                  {/each}
                </select>
                <select class="panel-input" aria-label="Tasa de código de la modulación {index + 1}" bind:value={modulation.cr}>
                  {#each CODING_RATE_DENOMINATORS as value (value)}
                    <option {value}>{formatCodingRate(value)}</option>
                  {/each}
                </select>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="flex flex-col gap-2">
        <label class="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" bind:checked={form.codingRateSweepEnabled} />
          Agregar un barrido de tasas de código, de 4/5 a 4/8, en una modulación
        </label>
        {#if form.codingRateSweepEnabled}
          <div class="flex flex-wrap items-end gap-2 pl-6">
            <label class="panel-label">
              Factor de dispersión
              <select class="panel-input" bind:value={form.codingRateSweepModulation.sf}>
                {#each SPREADING_FACTORS as value (value)}
                  <option {value}>SF{value}</option>
                {/each}
              </select>
            </label>
            <label class="panel-label">
              Ancho de banda
              <select class="panel-input" bind:value={form.codingRateSweepModulation.bw}>
                {#each BANDWIDTHS_KILOHERTZ as value (value)}
                  <option {value}>{value} kHz</option>
                {/each}
              </select>
            </label>
          </div>
        {/if}
      </div>
    </fieldset>

    {#if benchBandwidthsInUse}
      <p class="panel-note">
        El plan usa canales de {formatDisjunction(BENCH_BANDWIDTHS_KILOHERTZ.map(String))} kHz, que según la nota del comienzo
        quedan para el banco. Sin atenuadores, la prueba se hace solo con {ON_AIR_BANDWIDTH_KILOHERTZ} kHz.
      </p>
    {/if}
    {#if refusal !== null && refusal.cause === "activity" && !campaignActive}
      <p class="panel-note">{refusal.message}</p>
    {/if}
    {#if problems.length > 0}
      <ul class="flex flex-col gap-1">
        {#each problems as problem (problem)}
          <li class="panel-error-text">{problem}</li>
        {/each}
      </ul>
    {:else}
      {#if campaign === null && plan.length > 0}
        <div class="overflow-x-auto">
          <table class="panel-table">
            <thead>
              <tr>
                <th>N.º</th>
                {#if form.payloadSweepEnabled || form.codingRateSweepEnabled}<th>Serie</th>{/if}
                <th>Modulación</th>
                <th>Largo</th>
                <th>Paquetes</th>
                <th>Duración estimada</th>
              </tr>
            </thead>
            <tbody>
              {#each plan as point (point.index)}
                <tr>
                  <td>{point.index + 1}</td>
                  {#if form.payloadSweepEnabled || form.codingRateSweepEnabled}<td>{SERIES_LABELS[point.series]}</td>{/if}
                  <td class="whitespace-nowrap">{formatModulation(point)}</td>
                  <td>{point.size} B</td>
                  <td>{formatNumber(point.count)}</td>
                  <td>{formatDuration(estimatePointDurationMilliseconds(point))}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <p class="text-sm text-muted">
        Plan: {plan.length} {plan.length === 1 ? "punto" : "puntos"} de {formatNumber(form.packetCount)} {form.packetCount === 1 ? "paquete" : "paquetes"}, con una
        duración estimada de {formatDuration(planDuration)}.
      </p>
    {/if}

    <div class="flex flex-wrap gap-2">
      {#if !campaignActive}
        <button
          type="submit"
          class="panel-button panel-button-primary"
          disabled={problems.length > 0 || plan.length === 0 || refusal !== null}
        >
          Iniciar la prueba
        </button>
      {:else}
        {#if campaign?.status === "running"}
          <button type="button" class="panel-button" onclick={() => panel.pauseCampaign()}>Pausar</button>
        {:else if campaign?.status === "paused" || campaign?.status === "pausing"}
          <button type="button" class="panel-button" onclick={() => panel.resumeCampaign()}>Reanudar</button>
        {/if}
        <button
          type="button"
          class="panel-button panel-button-danger"
          disabled={campaign?.status === "stopping"}
          onclick={() => panel.stopCampaign()}
        >
          Detener
        </button>
      {/if}
      {#if campaign !== null && !campaignActive}
        <button type="button" class="panel-button" onclick={() => panel.discardCampaign()}>
          Quitar los resultados de la vista
        </button>
      {/if}
    </div>
    <p class="panel-hint">
      Para que la exportación contenga solo esta prueba, conviene descartar el registro, al pie de esta
      pestaña, antes de empezar.
    </p>
  </form>

  {#if campaign !== null}
    <div class="panel-card flex flex-col gap-3">
      <TestProgress status={CAMPAIGN_STATUS_LABELS[campaign.status]} progress={campaign.progress}>
        {#snippet title()}
          Prueba de <span class="font-mono">{campaign.sender}</span> a
          <span class="font-mono">{campaign.receiver}</span>
        {/snippet}
        {campaign.finishedCount} de {campaign.results.length} {campaign.results.length === 1 ? "punto terminado" : "puntos terminados"}
        {#if campaign.currentIndex !== null}· en curso el punto {campaign.currentIndex + 1}{/if}
        {#if campaign.startHostTime !== null}
          · transcurrido {formatDuration((campaign.endHostTime ?? panel.now) - campaign.startHostTime)}
        {/if}
        {#if campaignActive}· tiempo restante estimado {formatDuration(campaign.estimatedRemainingMilliseconds)}{/if}
      </TestProgress>
      <div class="overflow-x-auto">
        <table class="panel-table">
          <thead>
            <tr>
              <th>N.º</th>
              <th>Modulación</th>
              <th>Largo</th>
              <th>Estado</th>
              <th>Corrida</th>
              <th>Recibidos</th>
              <th>PDR</th>
              <th>Goodput</th>
              <th>RSSI medio</th>
              <th>SNR media</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {#each campaign.results as result (result.point.index)}
              {@const row = summaryRowOf(result.run)}
              <tr class={result.point.index === campaign.currentIndex ? "bg-neon/5" : ""}>
                <td>{result.point.index + 1}</td>
                <td class="whitespace-nowrap">{formatModulation(result.point)}</td>
                <td>{result.point.size} B</td>
                <td class="whitespace-nowrap {result.status === 'failed' ? 'text-danger' : ''}">
                  {POINT_STATUS_LABELS[result.status]}
                </td>
                <td>{result.run ?? "—"}</td>
                <td>
                  {result.received === null ? "—" : `${formatNumber(result.received)} de ${formatNumber(result.point.count)}`}
                </td>
                <td class="whitespace-nowrap">{formatDeliveryRatio(row?.pdr)}</td>
                <td class="whitespace-nowrap">{formatBitRate(row?.goodput)}</td>
                <td class="whitespace-nowrap">{formatRssi(row?.rssi_avg)}</td>
                <td class="whitespace-nowrap">{formatSnr(row?.snr_avg)}</td>
                <td class="text-xs text-muted">{result.failure ?? ""}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

<script lang="ts">
  import {
    DEFAULT_CAPACITY_TEST_CONFIGURATION,
    buildCapacityTestPlan,
    estimatePlanDurationMilliseconds,
    estimatePointDurationMilliseconds,
    validateCapacityTestConfiguration,
    type CapacityTestConfiguration,
    type Modulation,
  } from "$lib/measurements/capacity-test-plan.ts";
  import {
    BANDWIDTHS_KILOHERTZ,
    CODING_RATE_DENOMINATORS,
    ON_AIR_BANDWIDTH_KILOHERTZ,
    SPREADING_FACTORS,
    formatCodingRate,
    isBandwidth,
    type BandwidthKilohertz,
  } from "$lib/radio/radio-settings.ts";
  import type { TestRunSummaryRow } from "$lib/measurements/test-run-ledger.ts";
  import {
    formatBitRate,
    formatDeliveryRatio,
    formatDuration,
    formatModulation,
    formatNumber,
    formatRssi,
    formatSnr,
  } from "$lib/utils/format.ts";
  import { CAMPAIGN_STATUS_LABELS, POINT_STATUS_LABELS, SERIES_LABELS } from "$lib/utils/labels.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  const defaults = DEFAULT_CAPACITY_TEST_CONFIGURATION;

  let senderKey = $state("");
  let receiverKey = $state("");
  let frequency = $state<number>(defaults.freq);
  let preamble = $state<number>(defaults.preamble);
  let syncWord = $state<number>(defaults.sync);
  let selectedBandwidths = $state<number[]>([...defaults.bandwidths]);
  let minimumSpreadingFactor = $state<number>(SPREADING_FACTORS[0]);
  let maximumSpreadingFactor = $state<number>(SPREADING_FACTORS[SPREADING_FACTORS.length - 1] ?? 12);
  let codingRate = $state<number>(defaults.codingRate);
  let payloadSize = $state<number>(defaults.payloadSize);
  let packetCount = $state<number>(defaults.packetCount);
  let payloadSweepEnabled = $state(defaults.payloadSweep.enabled);
  let payloadSweepSizes = $state(defaults.payloadSweep.sizes.join(", "));
  let payloadSweepModulations = $state(defaults.payloadSweep.modulations.map((modulation) => ({ ...modulation })));
  let codingRateSweepEnabled = $state(defaults.codingRateSweep.enabled);
  let codingRateSweepModulation = $state({ ...defaults.codingRateSweep.modulation });

  const candidates = $derived(panel.identifiedConnections);
  const campaign = $derived(panel.campaign);
  const campaignActive = $derived(panel.isCampaignActive);

  $effect(() => {
    if (!candidates.some((connection) => connection.key === senderKey)) {
      senderKey = candidates[0]?.key ?? "";
    }
    if (!candidates.some((connection) => connection.key === receiverKey) || receiverKey === senderKey) {
      receiverKey = candidates.find((connection) => connection.key !== senderKey)?.key ?? "";
    }
  });

  function parseSizes(text: string): number[] {
    return text
      .split(/[\s,;]+/)
      .filter((part) => part !== "")
      .map(Number);
  }

  function toModulation(modulation: { sf: number; bw: number; cr: number }): Modulation {
    const bandwidth: BandwidthKilohertz = isBandwidth(modulation.bw) ? modulation.bw : ON_AIR_BANDWIDTH_KILOHERTZ;
    return { sf: modulation.sf, bw: bandwidth, cr: modulation.cr };
  }

  const configuration = $derived<CapacityTestConfiguration>({
    freq: frequency,
    preamble,
    sync: syncWord,
    bandwidths: BANDWIDTHS_KILOHERTZ.filter((bandwidth) => selectedBandwidths.includes(bandwidth)),
    spreadingFactors: SPREADING_FACTORS.filter(
      (value) => value >= minimumSpreadingFactor && value <= maximumSpreadingFactor,
    ),
    codingRate,
    payloadSize,
    packetCount,
    payloadSweep: {
      enabled: payloadSweepEnabled,
      sizes: parseSizes(payloadSweepSizes),
      modulations: payloadSweepModulations.map(toModulation),
    },
    codingRateSweep: {
      enabled: codingRateSweepEnabled,
      codingRates: [...CODING_RATE_DENOMINATORS],
      modulation: toModulation(codingRateSweepModulation),
    },
  });

  const problems = $derived.by(() => {
    const list = validateCapacityTestConfiguration(configuration);
    if (minimumSpreadingFactor > maximumSpreadingFactor) {
      list.unshift("El factor de dispersión inicial no puede superar al final.");
    }
    return list;
  });
  const plan = $derived(problems.length === 0 ? buildCapacityTestPlan(configuration) : []);
  const planDuration = $derived(estimatePlanDurationMilliseconds(plan));
  const usesBenchBandwidths = $derived(
    configuration.bandwidths.some((bandwidth) => bandwidth !== ON_AIR_BANDWIDTH_KILOHERTZ) ||
      (payloadSweepEnabled &&
        configuration.payloadSweep.modulations.some((modulation) => modulation.bw !== ON_AIR_BANDWIDTH_KILOHERTZ)) ||
      (codingRateSweepEnabled && configuration.codingRateSweep.modulation.bw !== ON_AIR_BANDWIDTH_KILOHERTZ),
  );
  const nodesReady = $derived(
    senderKey !== "" && receiverKey !== "" && senderKey !== receiverKey,
  );

  function startCampaign(): void {
    if (problems.length === 0 && nodesReady) {
      panel.startCampaign(configuration, senderKey, receiverKey);
    }
  }

  function summaryRowOf(run: number | null): TestRunSummaryRow | null {
    if (campaign === null || run === null) {
      return null;
    }
    return (
      panel.summaryRows.findLast(
        (row) => row.sender === campaign.sender && row.receiver === campaign.receiver && row.run === run,
      ) ?? null
    );
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
        En cada punto el panel envía el mismo comando radio a los dos nodos, espera que ambos confirmen los
        parámetros, hace que el emisor transmita la corrida con los paquetes seguidos (intervalo 0) y espera el
        informe del receptor. Un punto que falla queda marcado y la prueba sigue con el siguiente. La potencia
        de transmisión y el LNA quedan como estén: se ajustan en la sección Radio.
      </p>
    </div>

    <fieldset class="flex flex-col gap-4" disabled={campaignActive}>
      <div class="flex flex-wrap items-end gap-3">
        <label class="panel-label">
          Emisor
          <select class="panel-input" bind:value={senderKey}>
            {#each candidates as connection (connection.key)}
              <option value={connection.key}>{connection.state.identifier} ({connection.state.model})</option>
            {/each}
          </select>
        </label>
        <label class="panel-label">
          Receptor
          <select class="panel-input" bind:value={receiverKey}>
            {#each candidates.filter((connection) => connection.key !== senderKey) as connection (connection.key)}
              <option value={connection.key}>{connection.state.identifier} ({connection.state.model})</option>
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
          <input class="panel-input" type="number" min="915" max="928" step="0.001" bind:value={frequency} />
        </label>
        <label class="panel-label">
          Preámbulo (símbolos)
          <input class="panel-input" type="number" min="6" max="65535" step="1" bind:value={preamble} />
        </label>
        <label class="panel-label">
          Palabra de sincronismo
          <input class="panel-input" type="number" min="0" max="255" step="1" bind:value={syncWord} />
        </label>
        <label class="panel-label">
          Tasa de código
          <select class="panel-input" bind:value={codingRate}>
            {#each CODING_RATE_DENOMINATORS as value (value)}
              <option {value}>{formatCodingRate(value)}</option>
            {/each}
          </select>
        </label>
        <label class="panel-label">
          Largo del cuerpo (bytes)
          <input class="panel-input" type="number" min="8" max="239" step="1" bind:value={payloadSize} />
        </label>
        <label class="panel-label">
          Paquetes por punto
          <input class="panel-input" type="number" min="1" max="65535" step="1" bind:value={packetCount} />
        </label>
      </div>

      <div class="flex flex-wrap items-end gap-6">
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium text-slate-600">Anchos de banda</span>
          <div class="flex gap-3">
            {#each BANDWIDTHS_KILOHERTZ as bandwidth (bandwidth)}
              <label class="flex items-center gap-1 text-sm">
                <input type="checkbox" value={bandwidth} bind:group={selectedBandwidths} />
                {bandwidth} kHz
              </label>
            {/each}
          </div>
        </div>
        <label class="panel-label">
          Desde
          <select class="panel-input" bind:value={minimumSpreadingFactor}>
            {#each SPREADING_FACTORS as value (value)}
              <option {value}>SF{value}</option>
            {/each}
          </select>
        </label>
        <label class="panel-label">
          Hasta
          <select class="panel-input" bind:value={maximumSpreadingFactor}>
            {#each SPREADING_FACTORS as value (value)}
              <option {value}>SF{value}</option>
            {/each}
          </select>
        </label>
      </div>

      <div class="flex flex-col gap-2 rounded-md border border-slate-200 p-3">
        <label class="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" bind:checked={payloadSweepEnabled} />
          Agregar un barrido de largos del cuerpo en dos modulaciones
        </label>
        {#if payloadSweepEnabled}
          <div class="flex flex-wrap items-end gap-3">
            <label class="panel-label">
              Largos (bytes, separados por coma)
              <input class="panel-input w-56" type="text" bind:value={payloadSweepSizes} />
            </label>
            {#each payloadSweepModulations as modulation, index (index)}
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

      <div class="flex flex-col gap-2 rounded-md border border-slate-200 p-3">
        <label class="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" bind:checked={codingRateSweepEnabled} />
          Agregar un barrido de tasas de código, de 4/5 a 4/8, en una modulación
        </label>
        {#if codingRateSweepEnabled}
          <div class="flex flex-wrap items-end gap-2">
            <label class="panel-label">
              Factor de dispersión
              <select class="panel-input" bind:value={codingRateSweepModulation.sf}>
                {#each SPREADING_FACTORS as value (value)}
                  <option {value}>SF{value}</option>
                {/each}
              </select>
            </label>
            <label class="panel-label">
              Ancho de banda
              <select class="panel-input" bind:value={codingRateSweepModulation.bw}>
                {#each BANDWIDTHS_KILOHERTZ as value (value)}
                  <option {value}>{value} kHz</option>
                {/each}
              </select>
            </label>
          </div>
        {/if}
      </div>
    </fieldset>

    {#if usesBenchBandwidths}
      <p class="panel-note">
        Los canales de 125 y 250 kHz son solo para el banco, con cable coaxial y atenuadores o cargas de 50 Ω
        (ADR 0004). Sin atenuadores, la prueba se hace solo con 500 kHz.
      </p>
    {/if}
    {#if problems.length > 0}
      <ul class="flex flex-col gap-1">
        {#each problems as problem (problem)}
          <li class="panel-error-text">{problem}</li>
        {/each}
      </ul>
    {:else}
      <p class="text-sm text-slate-700">
        Plan: {plan.length} {plan.length === 1 ? "punto" : "puntos"} de {formatNumber(packetCount)} paquetes, con una
        duración estimada de {formatDuration(planDuration)}.
      </p>
    {/if}

    <div class="flex flex-wrap gap-2">
      {#if !campaignActive}
        <button
          type="submit"
          class="panel-button-primary"
          disabled={problems.length > 0 || plan.length === 0 || !nodesReady}
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
          class="panel-button-danger"
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
      Para que la exportación contenga solo esta prueba, conviene descartar el registro en la sección Exportar
      antes de empezar.
    </p>
  </form>

  {#if campaign === null && plan.length > 0}
    <div class="panel-card overflow-x-auto">
      <h3 class="panel-section-title mb-2">Puntos del plan</h3>
      <table class="panel-table">
        <thead>
          <tr>
            <th>N.º</th>
            <th>Serie</th>
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
              <td>{SERIES_LABELS[point.series]}</td>
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

  {#if campaign !== null}
    <div class="panel-card flex flex-col gap-3">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="panel-section-title">
          Prueba de <span class="font-mono">{campaign.sender}</span> a
          <span class="font-mono">{campaign.receiver}</span>
        </h3>
        <span class="text-sm text-slate-600">{CAMPAIGN_STATUS_LABELS[campaign.status]}</span>
      </div>
      <div
        class="h-2 w-full overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-label="Avance de la prueba"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(campaign.progress * 100)}
      >
        <div class="h-full bg-sky-600 transition-all" style="width: {campaign.progress * 100}%"></div>
      </div>
      <p class="text-sm text-slate-700">
        {campaign.finishedCount} de {campaign.results.length} puntos terminados
        {#if campaign.currentIndex !== null}· en curso el punto {campaign.currentIndex + 1}{/if}
        {#if campaign.startHostTime !== null}
          · transcurrido {formatDuration((campaign.endHostTime ?? panel.now) - campaign.startHostTime)}
        {/if}
        {#if campaignActive}· tiempo restante estimado {formatDuration(campaign.estimatedRemainingMilliseconds)}{/if}
      </p>
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
              <tr class={result.point.index === campaign.currentIndex ? "bg-sky-50" : ""}>
                <td>{result.point.index + 1}</td>
                <td class="whitespace-nowrap">{formatModulation(result.point)}</td>
                <td>{result.point.size} B</td>
                <td class="whitespace-nowrap {result.status === 'failed' ? 'text-red-700' : ''}">
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
                <td class="text-xs text-slate-600">{result.failure ?? ""}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="panel-hint">
        Los resultados quedan también en la sección Corridas y en el resumen que se exporta.
      </p>
    </div>
  {/if}
</div>

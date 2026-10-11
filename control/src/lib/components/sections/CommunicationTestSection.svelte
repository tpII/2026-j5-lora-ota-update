<script lang="ts">
  import CommunicationExportForm from "$lib/components/CommunicationExportForm.svelte";
  import { buildEchoCommand } from "$lib/console/console-command.ts";
  import {
    COMMUNICATION_TEST_PAYLOAD_SIZE,
    DEFAULT_COMMUNICATION_TEST_CONFIGURATION,
    MAXIMUM_COMMUNICATION_TEST_COUNT,
    echoTimeOnAirMicroseconds,
    estimateCommunicationTestMilliseconds,
    presenceHoldSecondsFor,
    validateCommunicationTestConfiguration,
    type CommunicationTestConfiguration,
  } from "$lib/measurements/communication-test.ts";
  import {
    computeCommunicationTestMetrics,
    nominalBitRateOf,
    summarizeServedEchoes,
    type SampleSummary,
  } from "$lib/measurements/communication-test-metrics.ts";
  import {
    BANDWIDTHS_KILOHERTZ,
    CODING_RATE_DENOMINATORS,
    ON_AIR_BANDWIDTH_KILOHERTZ,
    SPREADING_FACTORS,
    formatCodingRate,
    isBandwidth,
  } from "$lib/radio/radio-settings.ts";
  import { computeFrameLength } from "$lib/radio/time-on-air.ts";
  import {
    formatBitRate,
    formatClockTime,
    formatDeliveryRatio,
    formatDuration,
    formatMicrosecondsAsMilliseconds,
    formatModulation,
    formatNumber,
    formatRssi,
    formatSnr,
  } from "$lib/utils/format.ts";
  import { COMMUNICATION_TEST_STATUS_LABELS, RECEIVER_MODE_STATUS_LABELS } from "$lib/utils/labels.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  type Role = "sender" | "receiver";

  /** Rows drawn in the tables, newest first. */
  const MAXIMUM_VISIBLE_ROWS = 100;

  const defaults = DEFAULT_COMMUNICATION_TEST_CONFIGURATION;

  let role = $state<Role>("sender");
  let nodeKey = $state("");
  let destination = $state("");
  let spreadingFactor = $state<number>(defaults.sf);
  let bandwidth = $state<number>(defaults.bw);
  let codingRate = $state<number>(defaults.cr);
  let count = $state<number>(defaults.count);
  /** Node whose modulation was last copied into the form. */
  let prefilledKey = "";

  const candidates = $derived(panel.identifiedConnections);
  const node = $derived(candidates.find((connection) => connection.key === nodeKey));
  const neighborIdentifiers = $derived(node?.state.neighbors.map((neighbor) => neighbor.id) ?? []);
  const test = $derived(panel.communicationTest);
  const receiver = $derived(panel.receiverMode);
  const testActive = $derived(panel.isCommunicationTestActive);
  const receiverActive = $derived(panel.isReceiverModeActive);
  const busy = $derived(testActive || receiverActive);
  const otherTestActive = $derived(panel.isCampaignActive || panel.isEchoSeriesActive);

  $effect(() => {
    if (node === undefined && !busy) {
      nodeKey = candidates[0]?.key ?? "";
    }
  });

  // Start from the modulation the node uses, once per node chosen.
  $effect(() => {
    const radio = node?.state.radio ?? null;
    if (node !== undefined && radio !== null && prefilledKey !== node.key && !busy) {
      prefilledKey = node.key;
      spreadingFactor = radio.sf;
      bandwidth = radio.bw;
      codingRate = radio.cr;
    }
  });

  $effect(() => {
    if (destination === "" && neighborIdentifiers.length > 0) {
      destination = neighborIdentifiers[0] ?? "";
    }
  });

  const configuration = $derived<CommunicationTestConfiguration>({
    sf: spreadingFactor,
    bw: isBandwidth(bandwidth) ? bandwidth : ON_AIR_BANDWIDTH_KILOHERTZ,
    cr: codingRate,
    count,
  });
  const modulation = $derived({ sf: configuration.sf, bw: configuration.bw, cr: configuration.cr });
  const preamble = $derived(node?.state.radio?.preamble ?? 8);
  const destinationProblem = $derived.by(() => {
    const command = buildEchoCommand(destination);
    if (!command.valid) {
      return command.problems[0]?.message ?? null;
    }
    return destination.trim().toUpperCase() === node?.state.identifier
      ? "El destino tiene que ser otro nodo."
      : null;
  });
  const problems = $derived(
    role === "sender"
      ? [
          ...validateCommunicationTestConfiguration(configuration, preamble),
          ...(destinationProblem === null ? [] : [destinationProblem]),
        ]
      : [],
  );
  const frameLength = computeFrameLength(COMMUNICATION_TEST_PAYLOAD_SIZE);
  const timeOnAir = $derived(echoTimeOnAirMicroseconds(configuration, preamble));
  const nodeReady = $derived(node !== undefined && node.state.radio !== null && !otherTestActive);

  const metrics = $derived(test === null ? null : computeCommunicationTestMetrics(test));
  const progress = $derived(
    test === null || test.settings.count === 0 ? 0 : test.exchanges.length / test.settings.count,
  );
  const servedSummaries = $derived(receiver === null ? [] : summarizeServedEchoes(receiver.servedEchoes));

  function startTest(): void {
    if (nodeReady && problems.length === 0) {
      panel.startCommunicationTest(configuration, nodeKey, destination.trim().toUpperCase());
    }
  }

  function activateReceiver(): void {
    if (nodeReady) {
      panel.activateReceiverMode(nodeKey, modulation);
    }
  }

  function formatRange(summary: SampleSummary, format: (value: number | null) => string): string {
    if (summary.minimum === null || summary.maximum === null) {
      return "—";
    }
    return `${format(summary.minimum)} a ${format(summary.maximum)}`;
  }
</script>

<div class="flex flex-col gap-3">
  <form
    class="panel-card flex flex-col gap-4"
    onsubmit={(event) => {
      event.preventDefault();
      if (role === "sender") {
        startTest();
      } else {
        activateReceiver();
      }
    }}
  >
    <div class="flex flex-col gap-2">
      <h3 class="panel-section-title">Prueba de comunicación</h3>
      <p class="panel-hint">
        Mide el enlace entre dos nodos vecinos con una modulación elegida, con un operador en cada nodo y cada uno
        conectado al suyo. Los dos operadores acuerdan el SF, el ancho de banda y la tasa de código. Primero se activa
        el modo receptor en un nodo y después se inicia la prueba en el otro, en modo emisor. El emisor pide ecos de
        {COMMUNICATION_TEST_PAYLOAD_SIZE} bytes (el largo mínimo) uno tras otro y el receptor los responde. En los dos
        modos el nodo suspende sus HELLO mientras dura la prueba y al final vuelve a la modulación anterior: el emisor
        al terminar, detenerse o fallar, y el receptor al desactivarlo.
      </p>
      <div class="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        <p class="font-medium">Qué se mide</p>
        <ul class="mt-1 list-disc pl-5">
          <li>
            RSSI y SNR de ida (el pedido, medido en el receptor y devuelto en la respuesta) y de vuelta (la respuesta,
            medida en el emisor).
          </li>
          <li>Ecos respondidos y perdidos, y la proporción de entrega (PDR).</li>
          <li>Tiempo de ida y vuelta (RTT), desde que empieza a transmitirse el pedido hasta que llega la respuesta.</li>
          <li>
            Bits útiles: los del cuerpo de cada eco, que cruza el enlace dos veces. Se informan el total entregado,
            la proporción de cada trama que es cuerpo y la tasa de bits útiles (bits útiles sobre la suma de los RTT).
          </li>
          <li>En el receptor: los ecos respondidos y la RSSI y la SNR con que llegó cada pedido.</li>
        </ul>
      </div>
    </div>

    <fieldset class="flex flex-col gap-4" disabled={busy}>
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium text-slate-600">Modo</span>
          <div class="flex gap-1" role="radiogroup" aria-label="Modo">
            {#each [{ value: "sender", label: "Emisor" }, { value: "receiver", label: "Receptor" }] as option (option.value)}
              <label
                class="cursor-pointer rounded-md border px-3 py-1.5 text-sm {role === option.value
                  ? 'border-sky-600 bg-sky-50 text-sky-800'
                  : 'border-slate-300 text-slate-700'}"
              >
                <input class="sr-only" type="radio" name="role" value={option.value} bind:group={role} />
                {option.label}
              </label>
            {/each}
          </div>
        </div>
        <label class="panel-label">
          Nodo conectado
          <select class="panel-input" bind:value={nodeKey}>
            {#each candidates as connection (connection.key)}
              <option value={connection.key}>{connection.state.identifier} ({connection.state.model})</option>
            {/each}
          </select>
        </label>
        {#if role === "sender"}
          <label class="panel-label">
            Vecino (receptor)
            <input
              class="panel-input w-28 font-mono uppercase {destinationProblem !== null && destination !== ''
                ? 'panel-input-invalid'
                : ''}"
              type="text"
              maxlength="4"
              list="communication-destinations"
              autocomplete="off"
              spellcheck="false"
              bind:value={destination}
            />
            <datalist id="communication-destinations">
              {#each neighborIdentifiers as identifier (identifier)}
                <option value={identifier}></option>
              {/each}
            </datalist>
          </label>
        {/if}
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <label class="panel-label">
          Factor de dispersión
          <select class="panel-input" bind:value={spreadingFactor}>
            {#each SPREADING_FACTORS as value (value)}
              <option {value}>SF{value}</option>
            {/each}
          </select>
        </label>
        <label class="panel-label">
          Ancho de banda
          <select class="panel-input" bind:value={bandwidth}>
            {#each BANDWIDTHS_KILOHERTZ as value (value)}
              <option {value}>{value} kHz</option>
            {/each}
          </select>
        </label>
        <label class="panel-label">
          Tasa de código
          <select class="panel-input" bind:value={codingRate}>
            {#each CODING_RATE_DENOMINATORS as value (value)}
              <option {value}>{formatCodingRate(value)}</option>
            {/each}
          </select>
        </label>
        {#if role === "sender"}
          <label class="panel-label">
            Cantidad de ecos
            <input
              class="panel-input w-24"
              type="number"
              min="1"
              max={MAXIMUM_COMMUNICATION_TEST_COUNT}
              step="1"
              bind:value={count}
            />
          </label>
        {/if}
      </div>
    </fieldset>

    {#if candidates.length === 0}
      <p class="panel-error-text">Hay que conectar un nodo por USB o por WiFi.</p>
    {/if}
    {#if bandwidth !== ON_AIR_BANDWIDTH_KILOHERTZ}
      <p class="panel-note">
        Los canales de 125 y 250 kHz son solo para el banco, con cable coaxial y atenuadores o cargas de 50 Ω
        (ADR 0004).
      </p>
    {/if}
    {#if otherTestActive}
      <p class="panel-note">Hay una prueba de capacidad o una serie de ecos en curso: hay que esperar a que termine.</p>
    {/if}
    {#if role === "sender" && receiverActive}
      <p class="panel-note">El modo receptor está activo en este panel: hay que desactivarlo antes de emitir.</p>
    {/if}
    {#if role === "receiver" && testActive}
      <p class="panel-note">Hay una prueba en curso como emisor: el modo receptor espera a que termine.</p>
    {/if}

    {#if role === "sender"}
      {#if problems.length > 0}
        <ul class="flex flex-col gap-1">
          {#each problems as problem (problem)}
            <li class="panel-error-text">{problem}</li>
          {/each}
        </ul>
      {:else}
        <p class="text-sm text-slate-700">
          Cada eco viaja en tramas de {frameLength} bytes ({COMMUNICATION_TEST_PAYLOAD_SIZE} de cuerpo), de
          {formatMicrosecondsAsMilliseconds(timeOnAir, 2)} de aire según la fórmula de Semtech. Tasa nominal de la
          modulación: {formatBitRate(nominalBitRateOf(configuration))}. Duración estimada si todos los ecos se
          responden: {formatDuration(estimateCommunicationTestMilliseconds(configuration, preamble))}. El receptor
          tiene que estar activo con los mismos parámetros antes de iniciar; si no, todos los ecos se pierden.
        </p>
      {/if}
      <div class="flex flex-wrap gap-2">
        {#if !testActive}
          <button
            type="submit"
            class="panel-button-primary"
            disabled={!nodeReady || problems.length > 0 || receiverActive}
          >
            Iniciar la prueba
          </button>
        {:else}
          <button
            type="button"
            class="panel-button-danger"
            disabled={test?.status === "restoring"}
            onclick={() => panel.stopCommunicationTest()}
          >
            Detener
          </button>
        {/if}
        {#if test !== null && !testActive}
          <button type="button" class="panel-button" onclick={() => panel.discardCommunicationTest()}>
            Quitar los resultados de la vista
          </button>
        {/if}
      </div>
      <p class="panel-hint">
        Los HELLO del emisor quedan suspendidos como máximo
        {formatDuration(presenceHoldSecondsFor(configuration, preamble) * 1000)}: si el panel pierde la conexión,
        vuelven solos al vencer ese plazo, pero la modulación de prueba queda hasta cambiarla desde Radio o reiniciar
        el nodo.
      </p>
    {:else}
      <p class="text-sm text-slate-700">
        Mientras el modo receptor está activo, el nodo responde los ecos de cualquier vecino con {formatModulation(
          modulation,
        )}. Hay que desactivarlo al terminar la prueba para que vuelva a la modulación anterior y a enviar HELLO.
      </p>
      <div class="flex flex-wrap gap-2">
        {#if !receiverActive}
          <button type="submit" class="panel-button-primary" disabled={!nodeReady || testActive}>
            Activar el modo receptor
          </button>
          {#if receiver !== null}
            <button type="button" class="panel-button" onclick={() => panel.discardReceiverMode()}>
              Quitar los resultados de la vista
            </button>
          {/if}
        {:else}
          <button
            type="button"
            class="panel-button-danger"
            disabled={receiver?.status !== "active"}
            onclick={() => panel.deactivateReceiverMode()}
          >
            Desactivar el modo receptor
          </button>
        {/if}
      </div>
      <p class="panel-hint">
        La suspensión de los HELLO se renueva cada 30 minutos mientras el panel siga conectado. Si se pierde la
        conexión, los HELLO vuelven solos dentro de la hora, pero la modulación de prueba queda hasta cambiarla desde
        Radio o reiniciar el nodo.
      </p>
    {/if}
  </form>

  {#if role === "sender" && test !== null && metrics !== null}
    <div class="panel-card flex flex-col gap-3">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="panel-section-title">
          Ecos de <span class="font-mono">{test.requester}</span> a <span class="font-mono">{test.responder}</span>
          · {formatModulation(test.settings)}
        </h3>
        <span class="text-sm {test.status === 'failed' ? 'text-red-700' : 'text-slate-600'}">
          {COMMUNICATION_TEST_STATUS_LABELS[test.status]}
        </span>
      </div>
      <div
        class="h-2 w-full overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-label="Avance de la prueba"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(progress * 100)}
      >
        <div class="h-full bg-sky-600 transition-all" style="width: {progress * 100}%"></div>
      </div>
      <p class="text-sm text-slate-700">
        {formatNumber(metrics.requested)} de {formatNumber(test.settings.count)} ecos
        {#if test.startHostTime !== null}
          · transcurrido {formatDuration((test.endHostTime ?? panel.now) - test.startHostTime)}
        {/if}
      </p>
      {#if test.failure !== null}
        <p class="panel-error-text">{test.failure}</p>
      {/if}
      {#if test.restored === true}
        <p class="text-sm text-emerald-700">El nodo volvió a su modulación anterior y reanudó los HELLO.</p>
      {:else if test.restored === false}
        <div class="panel-error-text">
          No se pudo dejar el nodo como estaba:
          <ul class="list-disc pl-5">
            {#each test.restorationProblems as problem (problem)}
              <li>{problem}</li>
            {/each}
          </ul>
        </div>
      {/if}

      <dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
        <div class="rounded-md border border-slate-200 p-3">
          <dt class="text-xs text-slate-500">Entrega (PDR)</dt>
          <dd class="text-lg font-semibold">{formatDeliveryRatio(metrics.deliveryRatio)}</dd>
          <dd class="text-xs text-slate-600">
            {formatNumber(metrics.answered)} respondidos · {formatNumber(metrics.lost)} perdidos
          </dd>
        </div>
        <div class="rounded-md border border-slate-200 p-3">
          <dt class="text-xs text-slate-500">RSSI de ida (en el receptor)</dt>
          <dd class="text-lg font-semibold">{formatRssi(metrics.forward.rssi.average)}</dd>
          <dd class="text-xs text-slate-600">{formatRange(metrics.forward.rssi, formatRssi)}</dd>
        </div>
        <div class="rounded-md border border-slate-200 p-3">
          <dt class="text-xs text-slate-500">SNR de ida (en el receptor)</dt>
          <dd class="text-lg font-semibold">{formatSnr(metrics.forward.snr.average)}</dd>
          <dd class="text-xs text-slate-600">{formatRange(metrics.forward.snr, formatSnr)}</dd>
        </div>
        <div class="rounded-md border border-slate-200 p-3">
          <dt class="text-xs text-slate-500">RTT medio</dt>
          <dd class="text-lg font-semibold">{formatMicrosecondsAsMilliseconds(metrics.roundTrip.average, 2)}</dd>
          <dd class="text-xs text-slate-600">
            {formatRange(metrics.roundTrip, (value) => formatMicrosecondsAsMilliseconds(value, 2))}
          </dd>
        </div>
        <div class="rounded-md border border-slate-200 p-3">
          <dt class="text-xs text-slate-500">RSSI de vuelta (en el emisor)</dt>
          <dd class="text-lg font-semibold">{formatRssi(metrics.reverse.rssi.average)}</dd>
          <dd class="text-xs text-slate-600">{formatRange(metrics.reverse.rssi, formatRssi)}</dd>
        </div>
        <div class="rounded-md border border-slate-200 p-3">
          <dt class="text-xs text-slate-500">SNR de vuelta (en el emisor)</dt>
          <dd class="text-lg font-semibold">{formatSnr(metrics.reverse.snr.average)}</dd>
          <dd class="text-xs text-slate-600">{formatRange(metrics.reverse.snr, formatSnr)}</dd>
        </div>
        <div class="rounded-md border border-slate-200 p-3">
          <dt class="text-xs text-slate-500">Bits útiles entregados</dt>
          <dd class="text-lg font-semibold">{formatNumber(metrics.usefulBits)} bit</dd>
          <dd class="text-xs text-slate-600">
            {formatNumber(metrics.usefulShare * 100, 1)} % de cada trama de {metrics.frameLength} bytes
          </dd>
        </div>
        <div class="rounded-md border border-slate-200 p-3">
          <dt class="text-xs text-slate-500">Tasa de bits útiles</dt>
          <dd class="text-lg font-semibold">{formatBitRate(metrics.usefulBitRate)}</dd>
          <dd class="text-xs text-slate-600">nominal de la modulación: {formatBitRate(metrics.nominalBitRate)}</dd>
        </div>
      </dl>

      {#if !testActive && test.startHostTime !== null}
        <CommunicationExportForm
          contents="summary.csv (las métricas) y echoes.csv (un renglón por eco)"
          directoryPickerAvailable={panel.directoryPickerAvailable}
          exportFiles={(description) => panel.exportCommunicationTest(description)}
        />
      {/if}

      {#if test.exchanges.length > 0}
        <div class="overflow-x-auto">
          <table class="panel-table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>N.º</th>
                <th>Resultado</th>
                <th>RTT</th>
                <th>Ida (RSSI, SNR)</th>
                <th>Vuelta (RSSI, SNR)</th>
              </tr>
            </thead>
            <tbody>
              {#each test.exchanges.slice(-MAXIMUM_VISIBLE_ROWS).toReversed() as exchange (`${exchange.hostTime}:${exchange.number}`)}
                <tr>
                  <td class="font-mono text-xs">{formatClockTime(exchange.hostTime)}</td>
                  <td>{exchange.number}</td>
                  {#if exchange.outcome === "answered"}
                    <td class="text-emerald-700">Respondido</td>
                    <td class="whitespace-nowrap">{formatMicrosecondsAsMilliseconds(exchange.roundTripMicroseconds, 2)}</td>
                    <td class="whitespace-nowrap">{formatRssi(exchange.forwardRssi)}, {formatSnr(exchange.forwardSnr)}</td>
                    <td class="whitespace-nowrap">{formatRssi(exchange.reverseRssi)}, {formatSnr(exchange.reverseSnr)}</td>
                  {:else}
                    <td class="text-red-700">Perdido</td>
                    <td colspan="3" class="text-slate-500">sin respuesta</td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}

  {#if role === "receiver" && receiver !== null}
    <div class="panel-card flex flex-col gap-3">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="panel-section-title">
          Modo receptor en <span class="font-mono">{receiver.node}</span> · {formatModulation(receiver.modulation)}
        </h3>
        <span class="text-sm {receiver.status === 'failed' ? 'text-red-700' : 'text-slate-600'}">
          {RECEIVER_MODE_STATUS_LABELS[receiver.status]}
        </span>
      </div>
      <p class="text-sm text-slate-700">
        {formatNumber(receiver.servedEchoes.length)}
        {receiver.servedEchoes.length === 1 ? "eco respondido" : "ecos respondidos"} ·
        {receiver.deactivationHostTime === null ? "activo desde hace" : "estuvo activo"}
        {formatDuration((receiver.deactivationHostTime ?? panel.now) - receiver.activationHostTime)}
      </p>
      {#if receiver.failure !== null}
        <p class="panel-error-text">{receiver.failure}</p>
      {/if}
      {#if receiver.restored === true}
        <p class="text-sm text-emerald-700">El nodo volvió a su modulación anterior y reanudó los HELLO.</p>
      {:else if receiver.restored === false}
        <div class="panel-error-text">
          No se pudo dejar el nodo como estaba:
          <ul class="list-disc pl-5">
            {#each receiver.restorationProblems as problem (problem)}
              <li>{problem}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if servedSummaries.length > 0}
        <div class="overflow-x-auto">
          <table class="panel-table">
            <thead>
              <tr>
                <th>Emisor</th>
                <th>Ecos respondidos</th>
                <th>RSSI media</th>
                <th>RSSI mínima a máxima</th>
                <th>SNR media</th>
                <th>SNR mínima a máxima</th>
              </tr>
            </thead>
            <tbody>
              {#each servedSummaries as summary (summary.source)}
                <tr>
                  <td class="font-mono font-semibold">{summary.source}</td>
                  <td>{formatNumber(summary.served)}</td>
                  <td class="whitespace-nowrap">{formatRssi(summary.rssi.average)}</td>
                  <td class="whitespace-nowrap">{formatRange(summary.rssi, formatRssi)}</td>
                  <td class="whitespace-nowrap">{formatSnr(summary.snr.average)}</td>
                  <td class="whitespace-nowrap">{formatRange(summary.snr, formatSnr)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      {#if !receiverActive && receiver.deactivationHostTime !== null}
        <CommunicationExportForm
          contents="summary.csv (una fila por emisor) y echoes.csv (un renglón por eco respondido)"
          directoryPickerAvailable={panel.directoryPickerAvailable}
          exportFiles={(description) => panel.exportReceiverMode(description)}
        />
      {/if}

      {#if receiver.servedEchoes.length > 0}
        <div class="overflow-x-auto">
          <table class="panel-table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Emisor</th>
                <th>N.º</th>
                <th>RSSI</th>
                <th>SNR</th>
              </tr>
            </thead>
            <tbody>
              {#each receiver.servedEchoes.slice(-MAXIMUM_VISIBLE_ROWS).toReversed() as echo (`${echo.hostTime}:${echo.source}:${echo.number}`)}
                <tr>
                  <td class="font-mono text-xs">{formatClockTime(echo.hostTime)}</td>
                  <td class="font-mono">{echo.source}</td>
                  <td>{echo.number}</td>
                  <td class="whitespace-nowrap">{formatRssi(echo.rssi)}</td>
                  <td class="whitespace-nowrap">{formatSnr(echo.snr)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>

<script lang="ts">
  import {
    DEFAULT_ECHO_SIZE,
    MAXIMUM_PAYLOAD_SIZE,
    MINIMUM_ECHO_SIZE,
    buildEchoCommand,
    type CommandProblem,
  } from "$lib/console/console-command.ts";
  import { summarizeEchoResults } from "$lib/measurements/echo-statistics.ts";
  import { timeOnAirFor } from "$lib/radio/radio-settings.ts";
  import { computeFrameLength } from "$lib/radio/time-on-air.ts";
  import {
    formatClockTime,
    formatMicrosecondsAsMilliseconds,
    formatNumber,
    formatRssi,
    formatSnr,
  } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  /** Echo results drawn per node, newest first. */
  const MAXIMUM_VISIBLE_RESULTS = 50;

  let requesterKey = $state("");
  let destination = $state("");
  let size = $state<number>(DEFAULT_ECHO_SIZE);
  let count = $state<number>(1);
  let problems = $state<readonly CommandProblem[]>([]);

  const candidates = $derived(panel.identifiedConnections);
  const requester = $derived(candidates.find((connection) => connection.key === requesterKey));
  const neighborIdentifiers = $derived(requester?.state.neighbors.map((neighbor) => neighbor.id) ?? []);
  const seriesActive = $derived(panel.isEchoSeriesActive);
  const expectedRoundTrip = $derived.by(() => {
    const radio = requester?.state.radio ?? null;
    if (radio === null || !Number.isInteger(size) || size < MINIMUM_ECHO_SIZE || size > MAXIMUM_PAYLOAD_SIZE) {
      return null;
    }
    return 2 * timeOnAirFor(computeFrameLength(size), radio);
  });

  $effect(() => {
    if (requester === undefined && candidates.length > 0) {
      requesterKey = candidates[0]?.key ?? "";
    }
  });

  $effect(() => {
    if (destination === "" && neighborIdentifiers.length > 0) {
      destination = neighborIdentifiers[0] ?? "";
    }
  });

  const nodesWithEchoes = $derived(
    panel.connections.filter(
      (connection) => connection.state.echoResults.length > 0 || connection.state.servedEchoes.length > 0,
    ),
  );

  function requestEchoes(): void {
    const result = buildEchoCommand(destination, size);
    if (!result.valid) {
      problems = result.problems;
      return;
    }
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      problems = [{ field: "count", message: "La cantidad de ecos va de 1 a 1000." }];
      return;
    }
    problems = [];
    if (count === 1) {
      void panel.sendCommand(requesterKey, result.command);
    } else {
      panel.startEchoSeries(requesterKey, destination, size, count);
    }
  }

  function problemFor(field: string): boolean {
    return problems.some((problem) => problem.field === field);
  }
</script>

<div class="flex flex-col gap-3">
  <form
    class="panel-card flex flex-col gap-3"
    onsubmit={(event) => {
      event.preventDefault();
      requestEchoes();
    }}
  >
    <h3 class="panel-section-title">Pedir un eco</h3>
    <p class="panel-hint">
      El nodo elegido envía un pedido de eco con un cuerpo del largo indicado y el destino responde con
      otro del mismo largo. El tiempo de ida y vuelta (RTT) va desde que empieza a transmitirse el pedido
      hasta que llega la respuesta. Cada nodo atiende un eco por vez.
    </p>
    <div class="flex flex-wrap items-end gap-3">
      <label class="panel-label">
        Nodo que pide
        <select class="panel-input" bind:value={requesterKey} disabled={candidates.length === 0}>
          {#each candidates as connection (connection.key)}
            <option value={connection.key}>{connection.state.identifier}</option>
          {/each}
        </select>
      </label>
      <label class="panel-label">
        Destino
        <input
          class="panel-input w-28 font-mono uppercase {problemFor('id') ? 'panel-input-invalid' : ''}"
          type="text"
          maxlength="4"
          list="echo-destinations"
          autocomplete="off"
          spellcheck="false"
          bind:value={destination}
        />
        <datalist id="echo-destinations">
          {#each neighborIdentifiers as identifier (identifier)}
            <option value={identifier}></option>
          {/each}
        </datalist>
      </label>
      <label class="panel-label">
        Largo del cuerpo (bytes)
        <input
          class="panel-input w-28 {problemFor('size') ? 'panel-input-invalid' : ''}"
          type="number"
          min={MINIMUM_ECHO_SIZE}
          max={MAXIMUM_PAYLOAD_SIZE}
          step="1"
          bind:value={size}
        />
      </label>
      <label class="panel-label">
        Cantidad
        <input
          class="panel-input w-24 {problemFor('count') ? 'panel-input-invalid' : ''}"
          type="number"
          min="1"
          max="1000"
          step="1"
          bind:value={count}
        />
      </label>
      <button
        type="submit"
        class="panel-button-primary"
        disabled={requester === undefined || requester.status !== "open" || seriesActive}
      >
        {count > 1 ? "Pedir la serie de ecos" : "Pedir eco"}
      </button>
      {#if seriesActive}
        <button type="button" class="panel-button-danger" onclick={() => panel.stopEchoSeries()}>
          Detener la serie
        </button>
      {/if}
    </div>
    {#if problems.length > 0}
      <ul class="flex flex-col gap-1">
        {#each problems as problem (problem.field)}
          <li class="panel-error-text">{problem.message}</li>
        {/each}
      </ul>
    {/if}
    {#if expectedRoundTrip !== null}
      <p class="panel-hint">
        Tiempo de aire del pedido más el de la respuesta, según la fórmula de Semtech:
        {formatMicrosecondsAsMilliseconds(expectedRoundTrip)}.
      </p>
    {/if}
    {#if panel.echoSeries !== null}
      {@const series = panel.echoSeries}
      <p class="text-sm">
        Serie de ecos a <span class="font-mono">{series.destination}</span>: {formatNumber(series.requested)} de
        {formatNumber(series.total)} pedidos, {formatNumber(series.answered)} respondidos y
        {formatNumber(series.lost)} perdidos{series.status === "running"
          ? "."
          : series.status === "stopping"
            ? "; se detiene al terminar el eco en curso."
            : series.status === "finished"
              ? "; terminada."
              : series.status === "stopped"
                ? "; detenida."
                : "; falló."}
      </p>
    {/if}
  </form>

  {#each nodesWithEchoes as connection (connection.key)}
    {@const node = connection.state}
    {@const statistics = summarizeEchoResults(node.echoResults)}
    <div class="panel-card flex flex-col gap-3">
      <h3 class="panel-section-title">Ecos de <span class="font-mono">{node.identifier ?? connection.key}</span></h3>

      {#if statistics.length > 0}
        <div class="overflow-x-auto">
          <table class="panel-table">
            <thead>
              <tr>
                <th>Destino</th>
                <th>Pedidos</th>
                <th>Respondidos</th>
                <th>Perdidos</th>
                <th>RTT medio</th>
                <th>RTT mínimo</th>
                <th>RTT máximo</th>
              </tr>
            </thead>
            <tbody>
              {#each statistics as item (item.destination)}
                <tr>
                  <td class="font-mono font-semibold">{item.destination}</td>
                  <td>{formatNumber(item.requested)}</td>
                  <td>{formatNumber(item.answered)}</td>
                  <td>{formatNumber(item.lost)}</td>
                  <td>{formatMicrosecondsAsMilliseconds(item.meanRoundTrip, 2)}</td>
                  <td>{formatMicrosecondsAsMilliseconds(item.minimumRoundTrip, 2)}</td>
                  <td>{formatMicrosecondsAsMilliseconds(item.maximumRoundTrip, 2)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <div class="overflow-x-auto">
          <table class="panel-table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Destino</th>
                <th>N.º</th>
                <th>Largo</th>
                <th>Resultado</th>
                <th>RTT</th>
                <th>Ida (en el destino)</th>
                <th>Vuelta (en este nodo)</th>
              </tr>
            </thead>
            <tbody>
              {#each node.echoResults.slice(-MAXIMUM_VISIBLE_RESULTS).toReversed() as result (`${result.hostTime}:${result.number}`)}
                <tr>
                  <td class="font-mono text-xs">{formatClockTime(result.hostTime)}</td>
                  <td class="font-mono">{result.destination}</td>
                  <td>{result.number}</td>
                  <td>{result.size} B</td>
                  {#if result.outcome === "answered"}
                    <td class="text-emerald-700">Respondido</td>
                    <td class="whitespace-nowrap">{formatMicrosecondsAsMilliseconds(result.roundTripMicroseconds, 2)}</td>
                    <td class="whitespace-nowrap">{formatRssi(result.remoteRssi)}, {formatSnr(result.remoteSnr)}</td>
                    <td class="whitespace-nowrap">{formatRssi(result.rssi)}, {formatSnr(result.snr)}</td>
                  {:else}
                    <td class="text-red-700">Perdido</td>
                    <td colspan="3" class="text-slate-500">sin respuesta en {formatNumber(result.timeoutMilliseconds)} ms</td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      {#if node.servedEchoes.length > 0}
        {@const last = node.servedEchoes.at(-1)}
        <p class="text-sm text-slate-700">
          Respondió {formatNumber(node.servedEchoes.length)}
          {node.servedEchoes.length === 1 ? "eco" : "ecos"} de otros nodos.
          {#if last !== undefined}
            El último fue el n.º {last.number} de <span class="font-mono">{last.source}</span>, recibido con
            {formatRssi(last.rssi)} y {formatSnr(last.snr)}.
          {/if}
        </p>
      {/if}
    </div>
  {/each}
</div>

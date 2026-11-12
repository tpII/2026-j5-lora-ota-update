<script lang="ts">
  import { untrack } from "svelte";
  import {
    DEFAULT_ECHO_SIZE,
    MAXIMUM_ECHO_SIZE,
    MINIMUM_ECHO_SIZE,
  } from "$lib/protocol/protocol-contract.ts";
  import { buildEchoCommand, type CommandProblem } from "$lib/commands/console-command.ts";
  import {
    ECHO_SERIES_STATUS_LABELS,
    MAXIMUM_ECHO_SERIES_COUNT,
    MINIMUM_ECHO_SERIES_COUNT,
  } from "$lib/measurements/echo-series.ts";
  import { summarizeEchoResults } from "$lib/measurements/echo-statistics.ts";
  import { timeOnAirOfPayload } from "$lib/radio/time-on-air.ts";
  import {
    formatClockTime,
    formatMicrosecondsAsMilliseconds,
    formatNumber,
    formatRssi,
    formatSnr,
  } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import type { DestinationChoice } from "$lib/state/destination-choice.svelte.ts";
  import TargetNodeLine from "$lib/components/TargetNodeLine.svelte";

  /** The chosen node requests the echoes; the neighbor table can also fill in `destination`. */
  let { panel, destination }: { panel: ControlPanel; destination: DestinationChoice } = $props();

  /** Echo results drawn per node, newest first. */
  const MAXIMUM_VISIBLE_RESULTS = 50;

  let size = $state<number>(DEFAULT_ECHO_SIZE);
  let count = $state<number>(MINIMUM_ECHO_SERIES_COUNT);
  let problems = $state<readonly CommandProblem[]>([]);

  let card = $state<HTMLFormElement>();
  let destinationInput = $state<HTMLInputElement>();

  const requester = $derived(panel.nodes.selectedIdentified);
  const neighborIdentifiers = $derived(requester?.state.neighbors.map((neighbor) => neighbor.id) ?? []);
  const seriesActive = $derived(panel.echoSeries.isActive);
  const refusal = $derived(requester === null ? null : panel.refusal("echo-series", requester.key));
  /** A single echo also runs as a series, but only a series of several echoes is reported here. */
  const shownSeries = $derived.by(() => {
    const series = panel.echoSeries.snapshot;
    return series !== null && series.total > 1 ? series : null;
  });
  /** The node that runs the echo series, which need not be the chosen one. */
  const seriesRequesterKey = $derived(panel.echoSeries.keys[0] ?? null);
  const seriesRequesterNode = $derived(panel.echoSeries.nodes[0] ?? null);
  const expectedRoundTrip = $derived.by(() => {
    const radio = requester?.state.radio ?? null;
    if (radio === null || !Number.isInteger(size) || size < MINIMUM_ECHO_SIZE || size > MAXIMUM_ECHO_SIZE) {
      return null;
    }
    return 2 * timeOnAirOfPayload(size, radio);
  });

  $effect(() => {
    if (destination.follow(requester?.key ?? null, neighborIdentifiers)) {
      problems = [];
    }
  });

  /** Preparations already shown: one made before this form was drawn does not move the page. */
  let shownPreparations = untrack(() => destination.preparations);

  $effect(() => {
    const preparations = destination.preparations;
    if (preparations !== shownPreparations) {
      shownPreparations = preparations;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      card?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
      destinationInput?.focus({ preventScroll: true });
    }
  });

  const nodesWithEchoResults = $derived(
    panel.nodes.connections.filter((connection) => connection.state.echoResults.length > 0),
  );
  const nodesWithServedEchoes = $derived(
    panel.nodes.connections.filter((connection) => connection.state.servedEchoes.length > 0),
  );

  function requestEchoes(): void {
    if (requester === null) {
      return;
    }
    const result = buildEchoCommand(destination.text, size);
    if (!result.valid) {
      problems = result.problems;
      return;
    }
    if (!Number.isInteger(count) || count < MINIMUM_ECHO_SERIES_COUNT || count > MAXIMUM_ECHO_SERIES_COUNT) {
      problems = [
        {
          field: "count",
          message: `La cantidad de ecos va de ${MINIMUM_ECHO_SERIES_COUNT} a ${MAXIMUM_ECHO_SERIES_COUNT}.`,
        },
      ];
      return;
    }
    problems = [];
    panel.startEchoSeries(requester.key, destination.text, size, count);
  }

  function problemFor(field: string): boolean {
    return problems.some((problem) => problem.field === field);
  }
</script>

<div class="flex flex-col gap-3">
  <form
    bind:this={card}
    class="panel-card flex scroll-mt-4 flex-col gap-3"
    aria-labelledby="echo-card-title"
    data-testid="echo-form"
    onsubmit={(event) => {
      event.preventDefault();
      requestEchoes();
    }}
  >
    <h3 id="echo-card-title" class="panel-section-title">
      {requester === null ? "Eco con un vecino" : "Eco desde "}<span class="font-mono"
        >{requester?.state.identifier ?? ""}</span
      >
    </h3>
    {#if requester === null}<TargetNodeLine target={panel.testTarget()} role="Nodo que pide" />{/if}
    <p class="panel-hint">
      El destino responde con un cuerpo del mismo largo. El RTT va desde que empieza a transmitirse el
      pedido hasta que llega la respuesta. Cada nodo atiende un eco por vez.
    </p>
    <div class="flex flex-wrap items-end gap-3">
      <label class="panel-label">
        Destino
        <input
          class="panel-input w-28 font-mono uppercase {problemFor('id') ? 'panel-input-invalid' : ''}"
          type="text"
          maxlength="4"
          list="echo-destinations"
          data-testid="echo-destination"
          autocomplete="off"
          spellcheck="false"
          bind:this={destinationInput}
          bind:value={destination.text}
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
          max={MAXIMUM_ECHO_SIZE}
          step="1"
          bind:value={size}
        />
      </label>
      <label class="panel-label">
        Cantidad
        <input
          class="panel-input w-24 {problemFor('count') ? 'panel-input-invalid' : ''}"
          type="number"
          min={MINIMUM_ECHO_SERIES_COUNT}
          max={MAXIMUM_ECHO_SERIES_COUNT}
          step="1"
          bind:value={count}
        />
      </label>
      <button
        type="submit"
        class="panel-button panel-button-primary"
        disabled={requester === null || refusal !== null}
      >
        {count > 1 ? "Pedir la serie de ecos" : "Pedir eco"}
      </button>
      {#if seriesActive && shownSeries !== null}
        <button type="button" class="panel-button panel-button-danger" onclick={() => panel.stopEchoSeries()}>
          Detener la serie
        </button>
      {/if}
    </div>
    {#if refusal !== null && refusal.cause === "activity" && refusal.activity !== "echo-series"}
      <p class="panel-note">{refusal.message}</p>
    {/if}
    {#if problems.length > 0}
      <ul class="flex flex-col gap-1">
        {#each problems as problem (problem.field)}
          <li class="panel-error-text">{problem.message}</li>
        {/each}
      </ul>
    {/if}
    {#if expectedRoundTrip !== null}
      <p class="panel-hint">
        Tiempo de aire de ida y vuelta (Semtech): {formatMicrosecondsAsMilliseconds(expectedRoundTrip)}.
      </p>
    {/if}
    {#if shownSeries !== null}
      {@const series = shownSeries}
      <p class="text-sm">
        Serie de ecos{#if seriesRequesterNode !== null && seriesRequesterKey !== requester?.key}
          de <span class="font-mono">{seriesRequesterNode}</span>{/if}
        a <span class="font-mono">{series.destination}</span>: {formatNumber(series.requested)} de
        {formatNumber(series.total)} pedidos, {formatNumber(series.answered)} {series.answered === 1 ? "respondido" : "respondidos"} y
        {formatNumber(series.lost)} {series.lost === 1 ? "perdido" : "perdidos"}; {ECHO_SERIES_STATUS_LABELS[series.status]}.
      </p>
    {/if}
    {#each nodesWithServedEchoes as connection (connection.key)}
      {@const node = connection.state}
      {@const last = node.servedEchoes.at(-1)}
      <p class="text-sm text-muted">
        <span class="font-mono">{node.identifier ?? connection.key}</span> respondió
        {formatNumber(node.servedEchoes.length)}
        {node.servedEchoes.length === 1 ? "eco" : "ecos"} de otros nodos.
        {#if last !== undefined}
          El último fue el n.º {last.number} de <span class="font-mono">{last.source}</span>, recibido con
          {formatRssi(last.rssi)} y {formatSnr(last.snr)}.
        {/if}
      </p>
    {/each}
  </form>

  {#each nodesWithEchoResults as connection (connection.key)}
    {@const node = connection.state}
    {@const statistics = summarizeEchoResults(node.echoResults)}
    {#if statistics.length > 0}
      <div class="panel-card flex flex-col gap-3" data-testid="echo-results-{node.identifier ?? connection.key}">
        <h3 class="panel-section-title">Ecos de <span class="font-mono">{node.identifier ?? connection.key}</span></h3>

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
                    <td class="text-ok">Respondido</td>
                    <td class="whitespace-nowrap">{formatMicrosecondsAsMilliseconds(result.roundTripMicroseconds, 2)}</td>
                    <td class="whitespace-nowrap">{formatRssi(result.remoteRssi)}, {formatSnr(result.remoteSnr)}</td>
                    <td class="whitespace-nowrap">{formatRssi(result.rssi)}, {formatSnr(result.snr)}</td>
                  {:else}
                    <td class="text-danger">Perdido</td>
                    <td colspan="3" class="text-faint">sin respuesta en {formatNumber(result.timeoutMilliseconds)} ms</td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  {/each}
</div>

<script lang="ts">
  import {
    MAXIMUM_PAYLOAD_SIZE,
    MAXIMUM_RUN_COUNT,
    MAXIMUM_RUN_INTERVAL,
    MINIMUM_TEST_SIZE,
    RUN_STOP_COMMAND,
    buildRunCommand,
    type CommandProblem,
  } from "$lib/console/console-command.ts";
  import { isRunActive } from "$lib/nodes/node-state.ts";
  import { timeOnAirFor } from "$lib/radio/radio-settings.ts";
  import { computeFrameLength } from "$lib/radio/time-on-air.ts";
  import {
    formatBitRate,
    formatDeliveryRatio,
    formatDuration,
    formatMicrosecondsAsMilliseconds,
    formatModulation,
    formatNumber,
    formatPower,
    formatRssi,
    formatShortClockTime,
    formatSnr,
  } from "$lib/utils/format.ts";
  import { RECEPTION_OUTCOME_LABELS } from "$lib/utils/labels.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  const MAXIMUM_VISIBLE_RUNS = 30;

  let senderKey = $state("");
  let count = $state<number>(100);
  let size = $state<number>(MAXIMUM_PAYLOAD_SIZE);
  let interval = $state<number>(0);
  let problems = $state<readonly CommandProblem[]>([]);

  const candidates = $derived(panel.identifiedConnections);
  const sender = $derived(candidates.find((connection) => connection.key === senderKey));
  const senderBusy = $derived(sender !== undefined && isRunActive(sender.state));

  $effect(() => {
    if (sender === undefined && candidates.length > 0) {
      senderKey = candidates[0]?.key ?? "";
    }
  });

  const estimate = $derived.by(() => {
    const radio = sender?.state.radio ?? null;
    const valid = buildRunCommand(count, size, interval).valid;
    if (radio === null || !valid) {
      return null;
    }
    const timeOnAir = timeOnAirFor(computeFrameLength(size), radio);
    return { timeOnAir, durationMilliseconds: count * (timeOnAir / 1000) + (count - 1) * interval };
  });

  const visibleRuns = $derived(panel.runs.slice(-MAXIMUM_VISIBLE_RUNS).toReversed());

  function startRun(): void {
    const result = buildRunCommand(count, size, interval);
    if (!result.valid) {
      problems = result.problems;
      return;
    }
    problems = [];
    void panel.sendCommand(senderKey, result.command);
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
      startRun();
    }}
  >
    <h3 class="panel-section-title">Transmitir una corrida</h3>
    <p class="panel-hint">
      El emisor transmite paquetes TEST a todos los nodos. Cada nodo conectado al panel que comparte el canal
      del emisor informa lo que recibió; el panel arma una fila de resumen por receptor.
    </p>
    <div class="flex flex-wrap items-end gap-3">
      <label class="panel-label">
        Emisor
        <select class="panel-input" bind:value={senderKey} disabled={candidates.length === 0}>
          {#each candidates as connection (connection.key)}
            <option value={connection.key}>{connection.state.identifier}</option>
          {/each}
        </select>
      </label>
      <label class="panel-label">
        Cantidad de paquetes
        <input
          class="panel-input w-32 {problemFor('count') ? 'panel-input-invalid' : ''}"
          type="number"
          min="1"
          max={MAXIMUM_RUN_COUNT}
          step="1"
          bind:value={count}
        />
      </label>
      <label class="panel-label">
        Largo del cuerpo (bytes)
        <input
          class="panel-input w-32 {problemFor('size') ? 'panel-input-invalid' : ''}"
          type="number"
          min={MINIMUM_TEST_SIZE}
          max={MAXIMUM_PAYLOAD_SIZE}
          step="1"
          bind:value={size}
        />
      </label>
      <label class="panel-label">
        Intervalo (ms)
        <input
          class="panel-input w-32 {problemFor('interval') ? 'panel-input-invalid' : ''}"
          type="number"
          min="0"
          max={MAXIMUM_RUN_INTERVAL}
          step="1"
          bind:value={interval}
        />
      </label>
      <button
        type="submit"
        class="panel-button-primary"
        disabled={sender === undefined || sender.status !== "open" || senderBusy || panel.isCampaignActive}
      >
        Iniciar la corrida
      </button>
      <button
        type="button"
        class="panel-button-danger"
        disabled={sender === undefined || sender.status !== "open" || sender.state.senderRun?.completion !== null}
        onclick={() => panel.sendCommand(senderKey, RUN_STOP_COMMAND)}
      >
        Detener la corrida
      </button>
    </div>
    {#if problems.length > 0}
      <ul class="flex flex-col gap-1">
        {#each problems as problem (problem.field)}
          <li class="panel-error-text">{problem.message}</li>
        {/each}
      </ul>
    {/if}
    {#if estimate !== null}
      <p class="panel-hint">
        Tiempo de aire por paquete según Semtech: {formatMicrosecondsAsMilliseconds(estimate.timeOnAir)}.
        Duración estimada de la corrida: {formatDuration(estimate.durationMilliseconds)}.
      </p>
    {/if}
    {#if panel.isCampaignActive}
      <p class="panel-hint">Hay una prueba de capacidad en curso: las corridas manuales esperan a que termine.</p>
    {/if}
  </form>

  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">Corridas</h3>
    {#if visibleRuns.length === 0}
      <p class="text-sm text-slate-600">Todavía no hay corridas registradas.</p>
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
                      {#if run.completion?.aborted}<span class="text-amber-700">(detenida)</span>{/if}
                    </td>
                  {/if}
                  {#if reception === null}
                    <td colspan="7" class="text-slate-500">
                      {run.completion === null ? "Transmitiendo…" : "Ningún nodo conectado al panel escuchaba ese canal."}
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
  </div>
</div>

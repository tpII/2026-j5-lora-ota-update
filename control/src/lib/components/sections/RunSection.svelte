<script lang="ts">
  import TargetNodeLine from "$lib/components/TargetNodeLine.svelte";
  import {
    MAXIMUM_PAYLOAD_SIZE,
    MAXIMUM_RUN_COUNT,
    MAXIMUM_RUN_INTERVAL,
    MINIMUM_TEST_SIZE,
    RUN_STOP_COMMAND,
    buildRadioSetCommand,
    buildRunCommand,
    type CommandProblem,
  } from "$lib/console/console-command.ts";
  import { isRunActive } from "$lib/nodes/node-state.ts";
  import { ON_AIR_MAXIMUM_POWER_DBM, listTransmitPowerValues, timeOnAirFor } from "$lib/radio/radio-settings.ts";
  import { computeFrameLength } from "$lib/radio/time-on-air.ts";
  import { formatDuration, formatMicrosecondsAsMilliseconds, formatPower } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  /**
   * One step of a power sweep: the transmit power of the sender and a run of TEST packets. The sender
   * is the node chosen above.
   */
  let { panel }: { panel: ControlPanel } = $props();

  let count = $state<number>(100);
  let size = $state<number>(MAXIMUM_PAYLOAD_SIZE);
  let interval = $state<number>(0);
  let problems = $state<readonly CommandProblem[]>([]);
  /**
   * Power the operator picked and has not applied yet, for the node it was picked for, with the power
   * the node had then: once the node reports another power, the choice no longer applies.
   */
  let powerChoice = $state<{ readonly key: string; readonly power: number; readonly base: number | null } | null>(
    null,
  );
  let powerProblems = $state<readonly CommandProblem[]>([]);

  const sender = $derived(panel.selectedIdentifiedConnection);
  const senderBusy = $derived(sender !== null && isRunActive(sender.state));
  const model = $derived(sender?.state.model ?? null);
  const currentPower = $derived(sender?.state.radio?.power ?? null);
  const powerValues = $derived(listTransmitPowerValues(model));
  const pendingPower = $derived(
    sender !== null && powerChoice !== null && powerChoice.key === sender.key && powerChoice.base === currentPower && powerChoice.power !== currentPower
      ? powerChoice.power
      : null,
  );
  const shownPower = $derived(pendingPower ?? currentPower);
  const powerWarnings = $derived.by(() => {
    const list: string[] = [];
    if (shownPower !== null && shownPower > ON_AIR_MAXIMUM_POWER_DBM) {
      list.push("Por encima de unos 26 dBm se supera el límite de densidad espectral de los canales de 500 kHz.");
    }
    if (model === "V2" && shownPower === 20) {
      list.push("A 20 dBm la hoja de datos del SX1276 limita el ciclo de trabajo al 1 %.");
    }
    return list;
  });

  /**
   * The connection that transmits a run, which «Detener la corrida» goes to: the chosen node when it
   * transmits one, otherwise any other node that does, since the operator may have chosen another node
   * after starting the run. The runs of a capacity test are left to its own «Detener».
   */
  const transmittingConnection = $derived.by(() => {
    const campaignSender = panel.isCampaignActive ? (panel.campaign?.sender ?? null) : null;
    const transmitting = panel.connections.filter(
      (connection) =>
        connection.status === "open" &&
        connection.state.identifier !== campaignSender &&
        connection.state.senderRun !== null &&
        connection.state.senderRun.completion === null,
    );
    return transmitting.find((connection) => connection.key === sender?.key) ?? transmitting[0] ?? null;
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

  function startRun(): void {
    if (sender === null) {
      return;
    }
    const result = buildRunCommand(count, size, interval);
    if (!result.valid) {
      problems = result.problems;
      return;
    }
    problems = [];
    void panel.sendCommand(sender.key, result.command);
  }

  function choosePower(text: string): void {
    if (sender !== null && text !== "") {
      powerChoice = { key: sender.key, power: Number(text), base: currentPower };
      powerProblems = [];
    }
  }

  function applyPower(): void {
    if (sender === null || pendingPower === null) {
      return;
    }
    const result = buildRadioSetCommand({ power: pendingPower }, model);
    if (!result.valid) {
      powerProblems = result.problems;
      return;
    }
    powerProblems = [];
    void panel.sendCommand(sender.key, result.command);
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
      del emisor informa lo que recibió; el panel arma una fila de resumen por receptor. Cada paso del barrido
      es una corrida: se fija la potencia del emisor, se transmite la corrida y se repite con la potencia
      siguiente.
    </p>
    <TargetNodeLine {panel} role="Emisor" />

    <div class="flex flex-wrap items-end gap-3">
      <label class="panel-label">
        Potencia en la antena
        <select
          class="panel-input {powerProblems.length > 0 ? 'panel-input-invalid' : ''}"
          disabled={sender === null}
          onchange={(event) => choosePower(event.currentTarget.value)}
        >
          {#if shownPower === null}
            <option value="" selected>—</option>
          {/if}
          {#each powerValues as value (value)}
            <option {value} selected={value === shownPower}>{formatPower(value)}</option>
          {/each}
          {#if shownPower !== null && !powerValues.includes(shownPower)}
            <option value={shownPower} selected>{formatPower(shownPower)}</option>
          {/if}
        </select>
      </label>
      <button
        type="button"
        class="panel-button"
        disabled={sender === null || pendingPower === null || senderBusy || panel.isCampaignActive}
        onclick={applyPower}
      >
        Aplicar la potencia
      </button>
      {#if sender !== null && sender.state.radio !== null}
        <span class="panel-hint pb-2">
          Actual: {formatPower(sender.state.radio.power)} en la antena (ajuste del transceptor:
          {formatPower(sender.state.radio.chip)})
        </span>
      {/if}
    </div>
    {#if powerProblems.length > 0}
      <ul class="flex flex-col gap-1">
        {#each powerProblems as problem (problem.field)}
          <li class="panel-error-text">{problem.message}</li>
        {/each}
      </ul>
    {/if}
    {#if powerWarnings.length > 0}
      <ul class="panel-note flex list-disc flex-col gap-1 pl-6">
        {#each powerWarnings as warning (warning)}
          <li>{warning}</li>
        {/each}
      </ul>
    {/if}
    {#if senderBusy}
      <p class="panel-hint">El nodo tiene una corrida en curso: rechaza los cambios de radio hasta que termine.</p>
    {/if}

    <div class="flex flex-wrap items-end gap-3">
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
        disabled={sender === null || senderBusy || panel.isCampaignActive}
      >
        Iniciar la corrida
      </button>
      <button
        type="button"
        class="panel-button-danger"
        disabled={transmittingConnection === null}
        onclick={() => transmittingConnection !== null && panel.sendCommand(transmittingConnection.key, RUN_STOP_COMMAND)}
      >
        {transmittingConnection === null || transmittingConnection.key === sender?.key
          ? "Detener la corrida"
          : `Detener la corrida de ${transmittingConnection.state.identifier}`}
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
</div>

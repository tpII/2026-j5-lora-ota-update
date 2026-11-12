<script lang="ts">
  import TargetNodeLine from "$lib/components/TargetNodeLine.svelte";
  import {
    MAXIMUM_RUN_COUNT,
    MAXIMUM_RUN_INTERVAL_MILLISECONDS,
    MAXIMUM_TEST_SIZE,
    MINIMUM_RUN_COUNT,
    MINIMUM_RUN_INTERVAL_MILLISECONDS,
    MINIMUM_TEST_SIZE,
  } from "$lib/protocol/protocol-contract.ts";
  import { listTransmitPowerWarnings } from "$lib/radio/transmit-power-warnings.ts";
  import {
    RUN_STOP_COMMAND,
    buildRadioSetCommand,
    buildRunCommand,
    type CommandProblem,
  } from "$lib/commands/console-command.ts";
  import { estimateRunMilliseconds } from "$lib/measurements/run-timing.ts";
  import { listTransmitPowerValues } from "$lib/radio/radio-settings.ts";
  import { choosePower, pendingPowerOf, type PowerChoice } from "$lib/radio/power-choice.ts";
  import { timeOnAirOfPayload } from "$lib/radio/time-on-air.ts";
  import {
    formatDuration,
    formatMicrosecondsAsMilliseconds,
    formatPower,
  } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  /**
   * One step of a power sweep: the transmit power of the sender and a run of TEST packets. The sender
   * is the node chosen above.
   */
  let { panel }: { panel: ControlPanel } = $props();

  let count = $state<number>(100);
  let size = $state<number>(MAXIMUM_TEST_SIZE);
  let interval = $state<number>(MINIMUM_RUN_INTERVAL_MILLISECONDS);
  let problems = $state<readonly CommandProblem[]>([]);
  let powerChoice = $state.raw<PowerChoice | null>(null);
  let powerProblems = $state<readonly CommandProblem[]>([]);

  const sender = $derived(panel.nodes.selectedIdentified);
  const runRefusal = $derived(sender === null ? null : panel.refusal("manual-run", sender.key));
  const radioRefusal = $derived(sender === null ? null : panel.refusal("radio-settings", sender.key));
  const model = $derived(sender?.state.model ?? null);
  const currentPower = $derived(sender?.state.radio?.power ?? null);
  const powerValues = $derived(listTransmitPowerValues(model));
  const pendingPower = $derived(pendingPowerOf(powerChoice, sender?.key ?? null, currentPower));
  const shownPower = $derived(pendingPower ?? currentPower);
  const powerWarnings = $derived(shownPower === null ? [] : listTransmitPowerWarnings(shownPower, model));

  /**
   * The connection that transmits a run, which «Detener la corrida» goes to: the chosen node when it
   * transmits one, otherwise any other node that does, since the operator may have chosen another node
   * after starting the run. The runs of a capacity test are left to its own «Detener».
   */
  const transmitting = $derived.by(() => {
    const run = panel.activities.find((activity) => activity.kind === "manual-run");
    if (run === undefined) {
      return null;
    }
    const index = Math.max(0, run.keys.findIndex((key) => key === sender?.key));
    return { key: run.keys[index] ?? "", node: run.nodes[index] ?? "" };
  });

  const estimate = $derived.by(() => {
    const radio = sender?.state.radio ?? null;
    const valid = buildRunCommand(count, size, interval).valid;
    if (radio === null || !valid) {
      return null;
    }
    return {
      timeOnAir: timeOnAirOfPayload(size, radio),
      durationMilliseconds: estimateRunMilliseconds({ count, size, interval }, radio),
    };
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
    void panel.startManualRun(sender.key, result.command);
  }

  function pickPower(text: string): void {
    if (sender !== null && text !== "") {
      powerChoice = choosePower(sender.key, Number(text), currentPower);
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
    void panel.changeRadioSettings(sender.key, result.command);
  }

  function problemFor(field: string): boolean {
    return problems.some((problem) => problem.field === field);
  }
</script>

<form
  class="panel-card flex flex-col gap-3"
  data-testid="run-form"
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
  <TargetNodeLine target={panel.testTarget()} role="Emisor" />

  <div class="flex flex-wrap items-end gap-3">
    <label class="panel-label">
      Potencia en la antena
      <select
        class="panel-input {powerProblems.length > 0 ? 'panel-input-invalid' : ''}"
        disabled={sender === null}
        onchange={(event) => pickPower(event.currentTarget.value)}
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
      disabled={sender === null || pendingPower === null || radioRefusal !== null}
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
  {#if radioRefusal !== null && radioRefusal.cause !== "unready"}
    <p class="panel-hint">{radioRefusal.message}</p>
  {/if}

  <div class="flex flex-wrap items-end gap-3">
    <label class="panel-label">
      Cantidad de paquetes
      <input
        class="panel-input w-32 {problemFor('count') ? 'panel-input-invalid' : ''}"
        type="number"
        min={MINIMUM_RUN_COUNT}
        max={MAXIMUM_RUN_COUNT}
        step="1"
        data-testid="run-count"
        bind:value={count}
      />
    </label>
    <label class="panel-label">
      Largo del cuerpo (bytes)
      <input
        class="panel-input w-32 {problemFor('size') ? 'panel-input-invalid' : ''}"
        type="number"
        min={MINIMUM_TEST_SIZE}
        max={MAXIMUM_TEST_SIZE}
        step="1"
        bind:value={size}
      />
    </label>
    <label class="panel-label">
      Intervalo (ms)
      <input
        class="panel-input w-32 {problemFor('interval') ? 'panel-input-invalid' : ''}"
        type="number"
        min={MINIMUM_RUN_INTERVAL_MILLISECONDS}
        max={MAXIMUM_RUN_INTERVAL_MILLISECONDS}
        step="1"
        bind:value={interval}
      />
    </label>
    <button
      type="submit"
      class="panel-button panel-button-primary"
      disabled={sender === null || runRefusal !== null}
    >
      Iniciar la corrida
    </button>
    <button
      type="button"
      class="panel-button panel-button-danger"
      disabled={transmitting === null}
      onclick={() => transmitting !== null && panel.sendCommand(transmitting.key, RUN_STOP_COMMAND)}
    >
      {transmitting === null || transmitting.key === sender?.key
        ? "Detener la corrida"
        : `Detener la corrida de ${transmitting.node}`}
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
  {#if runRefusal !== null && runRefusal.cause === "activity" && transmitting?.key !== sender?.key}
    <p class="panel-hint">{runRefusal.message}</p>
  {/if}
</form>

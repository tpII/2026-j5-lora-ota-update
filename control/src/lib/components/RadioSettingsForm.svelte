<script lang="ts">
  import { untrack } from "svelte";
  import {
    BANDWIDTHS_KILOHERTZ,
    CODING_RATE_DENOMINATORS,
    DEFAULT_RADIO_SETTINGS,
    FREQUENCY_DECIMALS,
    MAXIMUM_FREQUENCY_MEGAHERTZ,
    MAXIMUM_PREAMBLE_LENGTH,
    MAXIMUM_SYNC_WORD,
    MINIMUM_FREQUENCY_MEGAHERTZ,
    MINIMUM_PREAMBLE_LENGTH,
    MINIMUM_SYNC_WORD,
    SPREADING_FACTORS,
  } from "$lib/protocol/protocol-contract.ts";
  import {
    RADIO_QUERY_COMMAND,
    RADIO_RESET_COMMAND,
    buildRadioSetCommand,
    type CommandProblem,
  } from "$lib/commands/console-command.ts";
  import type { LnaMode } from "$lib/console/console-event.ts";
  import {
    ALL_RADIO_SETTING_FIELDS,
    hasLowNoiseAmplifier,
    listTransmitPowerValues,
    settingsMatch,
    type RadioSettings,
  } from "$lib/radio/radio-settings.ts";
  import {
    formShowsSettings,
    listRadioFormWarnings,
    radioFormChanges,
    radioFormChannel,
    radioFormValuesOf,
    type RadioFormValues,
  } from "$lib/radio/radio-settings-form.ts";
  import { formatCodingRate, formatPower, formatSyncWord } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import type { IdentifiedConnection } from "$lib/node-session/connection-view.ts";

  let { panel, connection }: { panel: ControlPanel; connection: IdentifiedConnection } = $props();

  const node = $derived(connection.state);
  const current = $derived(node.radio);
  const model = $derived(node.model);
  const withLowNoiseAmplifier = $derived(hasLowNoiseAmplifier(model));
  const lowNoiseAmplifier = $derived<LnaMode>(current?.lna ?? DEFAULT_RADIO_SETTINGS.lna);
  const powerValues = $derived(listTransmitPowerValues(model));
  /** Why the node takes no radio change now: a run in progress or a test that holds its radio. */
  const radioRefusal = $derived(panel.refusal("radio-settings", connection.key));
  const radioHeld = $derived(radioRefusal !== null && radioRefusal.cause !== "unready");

  let values = $state<RadioFormValues>(radioFormValuesOf(DEFAULT_RADIO_SETTINGS));
  let problems = $state<readonly CommandProblem[]>([]);
  let loadedSettings = $state.raw<RadioSettings | null>(null);

  function loadCurrentSettings(settings: RadioSettings): void {
    values = radioFormValuesOf(settings);
    problems = [];
    loadedSettings = settings;
  }

  $effect(() => {
    const settings = current;
    if (settings === null) {
      return;
    }
    untrack(() => {
      if (loadedSettings === null || formShowsSettings(values, loadedSettings)) {
        loadCurrentSettings(settings);
      }
    });
  });

  const outdated = $derived(
    current !== null && loadedSettings !== null && !settingsMatch(current, loadedSettings, ALL_RADIO_SETTING_FIELDS),
  );

  const changes = $derived(radioFormChanges(values, current));
  const changeCount = $derived(Object.keys(changes).length);
  const warnings = $derived(listRadioFormWarnings(values, model, lowNoiseAmplifier));

  function problemFor(field: string): string | null {
    return problems.find((problem) => problem.field === field)?.message ?? null;
  }

  async function applyChanges(): Promise<void> {
    const result = buildRadioSetCommand(changes, model);
    if (!result.valid) {
      problems = result.problems;
      return;
    }
    problems = [];
    await panel.changeRadioSettings(connection.key, result.command);
  }

  async function copyChannelToOtherNodes(): Promise<void> {
    const result = buildRadioSetCommand(radioFormChannel(values), null);
    if (!result.valid) {
      problems = result.problems;
      return;
    }
    problems = [];
    const others = panel.nodes.identified.filter((other) => other.key !== connection.key);
    await Promise.all(others.map((other) => panel.changeRadioSettings(other.key, result.command)));
  }

  function resetToDefaults(): void {
    if (window.confirm(`¿Restablecer los parámetros de radio por defecto en el nodo ${node.identifier}?`)) {
      void panel.changeRadioSettings(connection.key, RADIO_RESET_COMMAND);
    }
  }
</script>

<!-- The radio settings of one node, bare: the section that mounts it supplies the card and its title. -->
<form
  class="flex flex-col gap-3"
  aria-label="Parámetros de radio de {node.identifier}"
  onsubmit={(event) => {
    event.preventDefault();
    void applyChanges();
  }}
>
  <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
    <label class="panel-label">
      Frecuencia (MHz)
      <input
        class="panel-input {problemFor('freq') !== null ? 'panel-input-invalid' : ''}"
        type="number"
        min={MINIMUM_FREQUENCY_MEGAHERTZ}
        max={MAXIMUM_FREQUENCY_MEGAHERTZ}
        step={10 ** -FREQUENCY_DECIMALS}
        bind:value={values.freq}
      />
    </label>
    <label class="panel-label">
      Factor de dispersión
      <select class="panel-input" bind:value={values.sf}>
        {#each SPREADING_FACTORS as value (value)}
          <option {value}>SF{value}</option>
        {/each}
      </select>
    </label>
    <label class="panel-label">
      Ancho de banda
      <select class="panel-input" bind:value={values.bw}>
        {#each BANDWIDTHS_KILOHERTZ as value (value)}
          <option {value}>{value} kHz</option>
        {/each}
      </select>
    </label>
    <label class="panel-label">
      Tasa de código
      <select class="panel-input" bind:value={values.cr}>
        {#each CODING_RATE_DENOMINATORS as value (value)}
          <option {value}>{formatCodingRate(value)}</option>
        {/each}
      </select>
    </label>
    <label class="panel-label">
      Preámbulo (símbolos)
      <input
        class="panel-input {problemFor('preamble') !== null ? 'panel-input-invalid' : ''}"
        type="number"
        min={MINIMUM_PREAMBLE_LENGTH}
        max={MAXIMUM_PREAMBLE_LENGTH}
        step="1"
        bind:value={values.preamble}
      />
    </label>
    <label class="panel-label">
      Palabra de sincronismo
      <input
        class="panel-input {problemFor('sync') !== null ? 'panel-input-invalid' : ''}"
        type="number"
        min={MINIMUM_SYNC_WORD}
        max={MAXIMUM_SYNC_WORD}
        step="1"
        bind:value={values.sync}
      />
      <span class="font-normal text-faint">
        {Number.isInteger(values.sync) && values.sync >= MINIMUM_SYNC_WORD && values.sync <= MAXIMUM_SYNC_WORD
          ? formatSyncWord(values.sync)
          : `${MINIMUM_SYNC_WORD} a ${MAXIMUM_SYNC_WORD}`}
      </span>
    </label>
    <label class="panel-label">
      Potencia en la antena
      <select class="panel-input {problemFor('power') !== null ? 'panel-input-invalid' : ''}" bind:value={values.power}>
        {#each powerValues as value (value)}
          <option {value}>{formatPower(value)}</option>
        {/each}
        {#if !powerValues.includes(values.power)}
          <option value={values.power}>{formatPower(values.power)}</option>
        {/if}
      </select>
      {#if current !== null && values.power === current.power}
        <span class="font-normal text-faint">transceptor a {formatPower(current.chip)}</span>
      {/if}
    </label>
    {#if withLowNoiseAmplifier}
      <label class="panel-label">
        LNA de la V4.3
        <!-- Disabled: an active LNA can damage the SX1262 when the nodes are close. -->
        <select class="panel-input" value={lowNoiseAmplifier} disabled>
          <option value="bypass">Puenteado</option>
          <option value="on">Activo</option>
        </select>
        <span class="font-normal text-faint">Solo se cambia desde la consola</span>
      </label>
    {/if}
  </div>

  {#if problems.length > 0}
    <ul class="flex flex-col gap-1">
      {#each problems as problem (problem.field)}
        <li class="panel-error-text">{problem.message}</li>
      {/each}
    </ul>
  {/if}
  {#if warnings.length > 0}
    <ul class="panel-note flex list-disc flex-col gap-1 pl-6">
      {#each warnings as warning (warning)}
        <li>{warning}</li>
      {/each}
    </ul>
  {/if}
  {#if outdated}
    <p class="panel-hint">
      El nodo informó otros parámetros después de cargar el formulario; «Volver a los valores actuales» los
      carga.
    </p>
  {/if}
  {#if radioRefusal !== null && radioHeld}
    <p class="panel-hint">{radioRefusal.message}</p>
  {/if}

  <div class="flex flex-wrap gap-2">
    <button type="submit" class="panel-button panel-button-primary" disabled={changeCount === 0 || radioHeld}>
      {changeCount === 0 ? "Sin cambios" : `Aplicar ${changeCount === 1 ? "1 cambio" : `${changeCount} cambios`}`}
    </button>
    <button
      type="button"
      class="panel-button"
      disabled={current === null || (changeCount === 0 && !outdated)}
      onclick={() => current !== null && loadCurrentSettings(current)}
    >
      Volver a los valores actuales
    </button>
    <button type="button" class="panel-button" onclick={() => panel.sendCommand(connection.key, RADIO_QUERY_COMMAND)}>
      Consultar
    </button>
    <button
      type="button"
      class="panel-button"
      title="Copia frecuencia, modulación, preámbulo y palabra de sincronismo; no la potencia ni el LNA"
      onclick={copyChannelToOtherNodes}
    >
      Copiar el canal a los demás nodos
    </button>
    <button type="button" class="panel-button panel-button-danger" disabled={radioHeld} onclick={resetToDefaults}>
      Restablecer valores por defecto
    </button>
  </div>
</form>

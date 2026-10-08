<script lang="ts">
  import { untrack } from "svelte";
  import {
    RADIO_QUERY_COMMAND,
    RADIO_RESET_COMMAND,
    buildRadioSetCommand,
    type CommandProblem,
    type RadioSettingChanges,
  } from "$lib/console/console-command.ts";
  import type { LnaMode } from "$lib/console/console-event.ts";
  import { isRunActive } from "$lib/nodes/node-state.ts";
  import {
    BANDWIDTHS_KILOHERTZ,
    CODING_RATE_DENOMINATORS,
    DEFAULT_RADIO_SETTINGS,
    ON_AIR_BANDWIDTH_KILOHERTZ,
    ON_AIR_MAXIMUM_CENTER_MEGAHERTZ,
    ON_AIR_MAXIMUM_POWER_DBM,
    ON_AIR_MINIMUM_CENTER_MEGAHERTZ,
    SPREADING_FACTORS,
    frequenciesMatch,
    hasLowNoiseAmplifier,
    formatCodingRate,
    listTransmitPowerValues,
    radioSettingsMatch,
    type RadioSettings,
  } from "$lib/radio/radio-settings.ts";
  import { formatPower, formatSyncWord } from "$lib/utils/format.ts";
  import type { ConnectionView, ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel, connection }: { panel: ControlPanel; connection: ConnectionView } = $props();

  const node = $derived(connection.state);
  const current = $derived(node.radio);
  const model = $derived(node.model);
  const withLowNoiseAmplifier = $derived(hasLowNoiseAmplifier(model));
  /** The form only shows the LNA mode the node reports. */
  const lowNoiseAmplifier = $derived<LnaMode>(current?.lna ?? DEFAULT_RADIO_SETTINGS.lna);
  const powerValues = $derived(listTransmitPowerValues(model));
  const busy = $derived(isRunActive(node));
  const open = $derived(connection.status === "open");

  let frequency = $state<number>(DEFAULT_RADIO_SETTINGS.freq);
  let spreadingFactor = $state<number>(DEFAULT_RADIO_SETTINGS.sf);
  let bandwidth = $state<number>(DEFAULT_RADIO_SETTINGS.bw);
  let codingRate = $state<number>(DEFAULT_RADIO_SETTINGS.cr);
  let preamble = $state<number>(DEFAULT_RADIO_SETTINGS.preamble);
  let syncWord = $state<number>(DEFAULT_RADIO_SETTINGS.sync);
  let power = $state<number>(DEFAULT_RADIO_SETTINGS.power);
  let problems = $state<readonly CommandProblem[]>([]);
  /** Settings the form was last filled with. */
  let loadedSettings = $state.raw<RadioSettings | null>(null);

  function loadCurrentSettings(settings: RadioSettings): void {
    frequency = settings.freq;
    spreadingFactor = settings.sf;
    bandwidth = settings.bw;
    codingRate = settings.cr;
    preamble = settings.preamble;
    syncWord = settings.sync;
    power = settings.power;
    problems = [];
    loadedSettings = settings;
  }

  /** True while the operator has not edited the values loaded from `settings`. */
  function formShows(settings: RadioSettings): boolean {
    return (
      frequenciesMatch(frequency, settings.freq) &&
      spreadingFactor === settings.sf &&
      bandwidth === settings.bw &&
      codingRate === settings.cr &&
      preamble === settings.preamble &&
      syncWord === settings.sync &&
      power === settings.power
    );
  }

  $effect(() => {
    // Follow the settings the node reports, unless the operator has edits pending.
    const settings = current;
    if (settings === null) {
      return;
    }
    untrack(() => {
      if (loadedSettings === null || formShows(loadedSettings)) {
        loadCurrentSettings(settings);
      }
    });
  });

  const outdated = $derived(
    current !== null && loadedSettings !== null && !radioSettingsMatch(current, loadedSettings),
  );

  /**
   * Only the values that differ from the current settings, or all of them when those are unknown.
   * The LNA mode never goes out from the form: it only changes from the console.
   */
  const changes = $derived.by((): RadioSettingChanges => {
    const all: RadioSettingChanges = {
      freq: frequency,
      sf: spreadingFactor,
      bw: bandwidth,
      cr: codingRate,
      preamble,
      sync: syncWord,
      power,
    };
    if (current === null) {
      return all;
    }
    return {
      ...(frequenciesMatch(frequency, current.freq) ? {} : { freq: frequency }),
      ...(spreadingFactor === current.sf ? {} : { sf: spreadingFactor }),
      ...(bandwidth === current.bw ? {} : { bw: bandwidth }),
      ...(codingRate === current.cr ? {} : { cr: codingRate }),
      ...(preamble === current.preamble ? {} : { preamble }),
      ...(syncWord === current.sync ? {} : { sync: syncWord }),
      ...(power === current.power ? {} : { power }),
    };
  });
  const changeCount = $derived(Object.keys(changes).length);

  const warnings = $derived.by(() => {
    const list: string[] = [];
    if (bandwidth !== ON_AIR_BANDWIDTH_KILOHERTZ) {
      list.push(
        "Con antena solo se usan canales de 500 kHz. Los de 125 y 250 kHz son para el banco, con cable coaxial y atenuadores o cargas de 50 Ω.",
      );
    } else if (frequency < ON_AIR_MINIMUM_CENTER_MEGAHERTZ || frequency > ON_AIR_MAXIMUM_CENTER_MEGAHERTZ) {
      list.push("Un canal de 500 kHz va centrado entre 915,25 y 927,75 MHz para quedar dentro de la banda.");
    }
    if (power > ON_AIR_MAXIMUM_POWER_DBM) {
      list.push("Por encima de unos 26 dBm se supera el límite de densidad espectral de los canales de 500 kHz.");
    }
    if (model === "V2" && power === 20) {
      list.push("A 20 dBm la hoja de datos del SX1276 limita el ciclo de trabajo al 1 %.");
    }
    if (withLowNoiseAmplifier && lowNoiseAmplifier === "on") {
      list.push(
        "Con el LNA activo, una señal de más de unos −21 dBm en la antena satura el SX1262 y puede dañarlo: sobre la mesa debe quedar puenteado.",
      );
    }
    return list;
  });

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
    await panel.sendCommand(connection.key, result.command);
  }

  async function copyChannelToOtherNodes(): Promise<void> {
    const result = buildRadioSetCommand(
      { freq: frequency, sf: spreadingFactor, bw: bandwidth, cr: codingRate, preamble, sync: syncWord },
      null,
    );
    if (!result.valid) {
      problems = result.problems;
      return;
    }
    problems = [];
    const others = panel.connections.filter(
      (other) => other.key !== connection.key && other.status === "open" && other.state.identifier !== null,
    );
    await Promise.all(others.map((other) => panel.sendCommand(other.key, result.command)));
  }

  function resetToDefaults(): void {
    if (window.confirm(`¿Restablecer los parámetros de radio por defecto en el nodo ${node.identifier}?`)) {
      void panel.sendCommand(connection.key, RADIO_RESET_COMMAND);
    }
  }
</script>

<form
  class="panel-card flex flex-col gap-3"
  onsubmit={(event) => {
    event.preventDefault();
    void applyChanges();
  }}
>
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h3 class="panel-section-title">
      Radio de <span class="font-mono">{node.identifier}</span>
      <span class="text-sm font-normal text-slate-500">({model ?? "modelo desconocido"})</span>
    </h3>
    {#if current !== null}
      <span class="panel-hint">
        Ajuste del transceptor: {formatPower(current.chip)} para {formatPower(current.power)} en la antena
      </span>
    {/if}
  </div>

  <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
    <label class="panel-label">
      Frecuencia (MHz)
      <input
        class="panel-input {problemFor('freq') !== null ? 'panel-input-invalid' : ''}"
        type="number"
        min="915"
        max="928"
        step="0.001"
        bind:value={frequency}
      />
    </label>
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
    <label class="panel-label">
      Preámbulo (símbolos)
      <input
        class="panel-input {problemFor('preamble') !== null ? 'panel-input-invalid' : ''}"
        type="number"
        min="6"
        max="65535"
        step="1"
        bind:value={preamble}
      />
    </label>
    <label class="panel-label">
      Palabra de sincronismo
      <input
        class="panel-input {problemFor('sync') !== null ? 'panel-input-invalid' : ''}"
        type="number"
        min="0"
        max="255"
        step="1"
        bind:value={syncWord}
      />
      <span class="font-normal text-slate-500">
        {Number.isInteger(syncWord) && syncWord >= 0 && syncWord <= 255 ? formatSyncWord(syncWord) : "0 a 255"}
      </span>
    </label>
    <label class="panel-label">
      Potencia en la antena
      <select class="panel-input {problemFor('power') !== null ? 'panel-input-invalid' : ''}" bind:value={power}>
        {#each powerValues as value (value)}
          <option {value}>{formatPower(value)}</option>
        {/each}
        {#if !powerValues.includes(power)}
          <option value={power}>{formatPower(power)}</option>
        {/if}
      </select>
    </label>
    {#if withLowNoiseAmplifier}
      <label class="panel-label">
        LNA de la V4.3
        <!-- Disabled: an active LNA can damage the SX1262 when the nodes are close. -->
        <select class="panel-input" value={lowNoiseAmplifier} disabled>
          <option value="bypass">Puenteado</option>
          <option value="on">Activo</option>
        </select>
        <span class="font-normal text-slate-500">Solo se cambia desde la consola</span>
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
  {#if busy}
    <p class="panel-hint">El nodo tiene una corrida en curso: rechaza los cambios de radio hasta que termine.</p>
  {/if}

  <div class="flex flex-wrap gap-2">
    <button type="submit" class="panel-button-primary" disabled={!open || changeCount === 0}>
      {changeCount === 0 ? "Sin cambios" : `Aplicar ${changeCount === 1 ? "1 cambio" : `${changeCount} cambios`}`}
    </button>
    <button
      type="button"
      class="panel-button"
      disabled={current === null}
      onclick={() => current !== null && loadCurrentSettings(current)}
    >
      Volver a los valores actuales
    </button>
    <button type="button" class="panel-button" disabled={!open} onclick={() => panel.sendCommand(connection.key, RADIO_QUERY_COMMAND)}>
      Consultar
    </button>
    <button type="button" class="panel-button" disabled={!open} onclick={copyChannelToOtherNodes}>
      Copiar el canal a los demás nodos
    </button>
    <button type="button" class="panel-button-danger" disabled={!open} onclick={resetToDefaults}>
      Restablecer valores por defecto
    </button>
  </div>
  <p class="panel-hint">
    El canal (frecuencia, modulación, preámbulo y palabra de sincronismo) tiene que coincidir en los nodos
    que se quieren escuchar; la potencia y el LNA son propios de cada nodo.
  </p>
</form>

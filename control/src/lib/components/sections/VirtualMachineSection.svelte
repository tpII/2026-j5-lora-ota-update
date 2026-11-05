<script lang="ts">
  import RegisterInputs from "../RegisterInputs.svelte";
  import RegisterTable from "../RegisterTable.svelte";
  import {
    STATUS_COMMAND,
    buildLoadRegistersCommand,
    type CommandProblem,
  } from "$lib/console/console-command.ts";
  import { parseInteger } from "$lib/vm/assembler.ts";
  import { TICK_PERIOD_SECONDS, formatPrintLine } from "$lib/vm/instruction-set.ts";
  import { formatImageVersion, formatShortClockTime } from "$lib/utils/format.ts";
  import { VM_FAULT_LABELS } from "$lib/utils/labels.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  const MAXIMUM_VISIBLE_PRINTS = 30;

  let nodeKey = $state("");
  let registerTexts = $state(["0", "0", "0", "0"]);
  let registerProblems = $state<readonly CommandProblem[]>([]);

  const candidates = $derived(panel.identifiedConnections);
  const node = $derived(candidates.find((connection) => connection.key === nodeKey));
  const machine = $derived(node?.state.virtualMachine ?? null);
  const lastFault = $derived(node?.state.lastVirtualMachineFault ?? null);
  const visiblePrints = $derived(
    (node?.state.virtualMachinePrints ?? []).slice(-MAXIMUM_VISIBLE_PRINTS).toReversed(),
  );
  const connected = $derived(node !== undefined && node.status === "open");

  $effect(() => {
    if (node === undefined && candidates.length > 0) {
      nodeKey = candidates[0]?.key ?? "";
    }
  });

  function loadRegisters(): void {
    // A text that is not an integer becomes NaN, which the builder reports for that register.
    const result = buildLoadRegistersCommand(
      registerTexts.map((text) => parseInteger(text) ?? Number.NaN),
    );
    if (!result.valid) {
      registerProblems = result.problems;
      return;
    }
    registerProblems = [];
    void panel.sendCommand(nodeKey, result.command);
  }
</script>

<div class="flex flex-col gap-3">
  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">Máquina virtual del nodo</h3>
    <p class="panel-hint">
      El nodo ejecuta un tick de su programa activo cada {TICK_PERIOD_SECONDS} s y el primero apenas lo activa.
      Cada PRINT aparece en la pantalla del nodo y en la tabla de salidas. Los programas llegan como imágenes
      firmadas, que se cargan y se activan desde la sección Actualización. Al reiniciarse, el nodo vuelve al
      programa de fábrica, la versión 0.
    </p>
    <div class="flex flex-wrap items-end gap-3">
      <label class="panel-label">
        Nodo
        <select class="panel-input" bind:value={nodeKey} disabled={candidates.length === 0}>
          {#each candidates as connection (connection.key)}
            <option value={connection.key}>{connection.state.identifier}</option>
          {/each}
        </select>
      </label>
      <button
        type="button"
        class="panel-button"
        disabled={!connected}
        onclick={() => panel.sendCommand(nodeKey, STATUS_COMMAND)}
      >
        Consultar el estado
      </button>
    </div>
    {#if candidates.length === 0}
      <p class="text-sm text-slate-600">No hay nodos identificados conectados.</p>
    {:else if machine === null}
      <p class="text-sm text-slate-600">El nodo todavía no informó el estado de su VM.</p>
    {:else}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt class="text-slate-600">Versión activa</dt>
        <dd class="font-mono">{machine.version === 0 ? "0 (programa de fábrica)" : machine.version}</dd>
        <dt class="text-slate-600">Versión disponible</dt>
        <dd class="font-mono">{formatImageVersion(node?.state.availableVersion)}</dd>
        <dt class="text-slate-600">Largo</dt>
        <dd>{machine.size} bytes</dd>
        <dt class="text-slate-600">Tick</dt>
        <dd class="font-mono">{machine.tick}</dd>
      </dl>
      <RegisterTable registers={machine.registers} />
      <p class="panel-hint">
        Los valores salen del último evento vm y de cada PRINT; un registro que el programa cambia sin
        mostrarlo se actualiza al consultar el estado.
      </p>
      {#if lastFault !== null}
        <p class="panel-error-text">
          Última falla, en el tick {lastFault.tick} y la dirección {lastFault.address}:
          {VM_FAULT_LABELS[lastFault.reason]}.
        </p>
      {/if}
    {/if}
  </div>

  <form
    class="panel-card flex flex-col gap-3"
    onsubmit={(event) => {
      event.preventDefault();
      loadRegisters();
    }}
  >
    <h3 class="panel-section-title">Cargar registros</h3>
    <p class="panel-hint">Enteros de 32 bits en decimal o con 0x; el programa los usa desde el próximo tick.</p>
    <RegisterInputs bind:values={registerTexts} />
    <div>
      <button type="submit" class="panel-button-primary" disabled={!connected}>Cargar registros</button>
    </div>
    {#if registerProblems.length > 0}
      <ul class="flex flex-col gap-1">
        {#each registerProblems as problem (problem.field)}
          <li class="panel-error-text">{problem.message}</li>
        {/each}
      </ul>
    {/if}
  </form>

  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">Salidas del nodo</h3>
    {#if visiblePrints.length === 0}
      <p class="text-sm text-slate-600">Todavía no hay salidas.</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="panel-table">
          <thead>
            <tr>
              <th>Hora</th>
              <th>Tick</th>
              <th>Pantalla del nodo</th>
              <th>Decimal</th>
            </tr>
          </thead>
          <tbody>
            {#each visiblePrints as print, index (index)}
              <tr>
                <td class="font-mono text-xs">{formatShortClockTime(print.hostTime)}</td>
                <td>{print.tick}</td>
                <td class="font-mono">{formatPrintLine(print.register, print.value)}</td>
                <td class="text-right font-mono">{print.value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>

<script lang="ts">
  import PrintOutputTable from "../PrintOutputTable.svelte";
  import RegisterInputs from "../RegisterInputs.svelte";
  import RegisterTable from "../RegisterTable.svelte";
  import TargetNodeLine from "../TargetNodeLine.svelte";
  import { buildLoadRegistersCommand, type CommandProblem } from "$lib/console/console-command.ts";
  import { parseInteger } from "$lib/vm/assembler.ts";
  import { TICK_PERIOD_SECONDS } from "$lib/vm/instruction-set.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  /**
   * The VM of the chosen node, the column «En el nodo» of the Programa section: its state, the
   * loading of its registers and the outputs it reports.
   */
  let { panel }: { panel: ControlPanel } = $props();

  let registerTexts = $state(["0", "0", "0", "0"]);
  let registerProblems = $state<readonly CommandProblem[]>([]);

  const node = $derived(panel.selectedIdentifiedConnection);
  const machine = $derived(node?.state.virtualMachine ?? null);
  const lastFault = $derived(node?.state.lastVirtualMachineFault ?? null);
  const prints = $derived(node?.state.virtualMachinePrints ?? []);

  function loadRegisters(): void {
    if (node === null) {
      return;
    }
    // A text that is not an integer becomes NaN, which the builder reports for that register.
    const result = buildLoadRegistersCommand(
      registerTexts.map((text) => parseInteger(text) ?? Number.NaN),
    );
    if (!result.valid) {
      registerProblems = result.problems;
      return;
    }
    registerProblems = [];
    void panel.sendCommand(node.key, result.command);
  }
</script>

<div class="flex flex-col gap-3">
  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">En el nodo{node === null ? "" : ` ${node.state.identifier}`}</h3>
    <TargetNodeLine {panel} />
    <p class="panel-hint">
      El nodo ejecuta un tick de su programa activo cada {TICK_PERIOD_SECONDS} s y el primero apenas lo activa.
      Cada PRINT aparece en la pantalla del nodo y en la tabla de salidas. Al reiniciarse, el nodo vuelve al
      programa de fábrica, la versión 0.
    </p>
    <form
      class="flex flex-col gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        loadRegisters();
      }}
    >
      <span class="panel-caption">Cargar registros</span>
      <p class="panel-hint">Enteros de 32 bits en decimal o con 0x; el programa los usa desde el próximo tick.</p>
      <RegisterInputs bind:values={registerTexts} />
      <div>
        <button type="submit" class="panel-button-primary" disabled={node === null}>Cargar registros</button>
      </div>
      {#if registerProblems.length > 0}
        <ul class="flex flex-col gap-1">
          {#each registerProblems as problem (problem.field)}
            <li class="panel-error-text">{problem.message}</li>
          {/each}
        </ul>
      {/if}
    </form>
    {#if node !== null}
      {#if machine === null}
        <p class="text-sm text-muted">El nodo todavía no informó el estado de su VM.</p>
      {:else}
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt class="text-muted">Largo</dt>
          <dd>{machine.size} bytes</dd>
          <dt class="text-muted">Tick</dt>
          <dd class="font-mono">{machine.tick}</dd>
        </dl>
        <RegisterTable registers={machine.registers} />
        <p class="panel-hint">
          Los valores salen del último evento vm y de cada PRINT; un registro que el programa cambia sin
          mostrarlo se actualiza al consultar el estado desde el detalle del nodo elegido.
        </p>
      {/if}
    {/if}
  </div>

  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">Salidas del nodo</h3>
    {#if node === null}
      <p class="text-sm text-muted">Sin nodo elegido.</p>
    {:else}
      <PrintOutputTable {prints} fault={lastFault} showHostTime />
    {/if}
  </div>
</div>

<script lang="ts">
  import PrintOutputTable from "../PrintOutputTable.svelte";
  import RegisterInputs from "../RegisterInputs.svelte";
  import RegisterTable from "../RegisterTable.svelte";
  import { parseInteger } from "$lib/vm/assembler.ts";
  import { formatProgramHex } from "$lib/vm/instruction-set.ts";
  import {
    VirtualMachine,
    finishTick,
    runTick,
    type PrintedValue,
    type VmFault,
  } from "$lib/vm/virtual-machine.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  /**
   * The reference interpreter over the program of the editor, the column «En la computadora» of the
   * Programa section: its outputs are the ones the node is expected to report.
   */
  let { draft }: { draft: ProgramDraft } = $props();

  const MAXIMUM_RECORDED_PRINTS = 100;

  interface MachineSnapshot {
    readonly registers: readonly number[];
    readonly programCounter: number;
    readonly tick: number;
    readonly running: boolean;
    readonly fault: VmFault | null;
  }

  interface FaultRecord {
    readonly tick: number;
    readonly address: number;
    readonly reason: VmFault;
  }

  let machine = new VirtualMachine();
  let initialRegisters = $state(["0", "0", "0", "0"]);
  let loadedHex = $state<string | null>(null);
  let snapshot = $state<MachineSnapshot | null>(null);
  let prints = $state<readonly PrintedValue[]>([]);
  /** Kept until the next reset, as a node keeps its last fault while it runs the next ticks. */
  let lastFault = $state<FaultRecord | null>(null);
  let notice = $state("");

  const assembly = $derived(draft.assembly);
  const currentHex = $derived(assembly.valid ? formatProgramHex(assembly.code) : null);
  const stale = $derived(loadedHex !== null && currentHex !== loadedHex);
  const registersValid = $derived(initialRegisters.every((text) => parseInteger(text) !== null));
  const runnable = $derived(assembly.valid && registersValid);
  const currentAddress = $derived(snapshot !== null && snapshot.running ? snapshot.programCounter : null);

  function refresh(): void {
    snapshot = {
      registers: machine.registers,
      programCounter: machine.programCounter,
      tick: machine.tickNumber,
      running: machine.isRunning,
      fault: machine.fault,
    };
    if (machine.fault !== null) {
      lastFault = { tick: machine.tickNumber, address: machine.faultAddress, reason: machine.fault };
    }
  }

  /** Loads the program and the initial registers, as a node does when it activates an image. */
  function reset(): void {
    if (!assembly.valid || !registersValid) {
      return;
    }
    machine = new VirtualMachine();
    machine.load(assembly.code);
    machine.setRegisters(initialRegisters.map((text) => parseInteger(text) ?? 0));
    loadedHex = formatProgramHex(assembly.code);
    prints = [];
    lastFault = null;
    notice = "";
    refresh();
  }

  /** Reloads first when the program changed since the last run. */
  function prepare(): boolean {
    if (!runnable) {
      return false;
    }
    if (loadedHex === null || stale) {
      reset();
    }
    return true;
  }

  function record(newPrints: readonly PrintedValue[]): void {
    prints = [...prints, ...newPrints].slice(-MAXIMUM_RECORDED_PRINTS);
  }

  function executeTick(): void {
    if (!prepare()) {
      return;
    }
    const outcome = machine.isRunning ? finishTick(machine) : runTick(machine);
    record(outcome.prints);
    notice = outcome.step === "halted" ? `El tick ${machine.tickNumber} terminó en HALT.` : "";
    refresh();
  }

  function executeStep(): void {
    if (!prepare()) {
      return;
    }
    if (!machine.isRunning) {
      machine.startTick();
    }
    const step = machine.execute(1);
    if (step === "printed") {
      const register = machine.printedRegister;
      record([{ tick: machine.tickNumber, register, value: machine.registers[register - 1] ?? 0 }]);
    }
    notice = step === "halted" ? `El tick ${machine.tickNumber} terminó en HALT.` : "";
    refresh();
  }
</script>

<div class="flex flex-col gap-3">
  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">En la computadora</h3>
    <p class="panel-hint">
      Intérprete de referencia. Cada tick corre desde la dirección 0 hasta HALT o una falla; los registros
      pasan de un tick al siguiente.
    </p>
    <div class="flex flex-col gap-1">
      <span class="panel-caption">Registros al reiniciar</span>
      <RegisterInputs bind:values={initialRegisters} />
    </div>
    <div class="flex flex-wrap gap-2">
      <button type="button" class="panel-button-primary" disabled={!runnable} onclick={executeTick}>
        Ejecutar tick
      </button>
      <button type="button" class="panel-button" disabled={!runnable} onclick={executeStep}>Paso</button>
      <button type="button" class="panel-button" disabled={!runnable} onclick={reset}>Reiniciar</button>
    </div>
    {#if !assembly.valid}
      <p class="panel-error-text">El programa tiene errores: corregirlos en el editor para ejecutarlo.</p>
    {/if}
    {#if !registersValid}
      <p class="panel-error-text">Cada registro es un entero de 32 bits, en decimal o con 0x.</p>
    {/if}
    {#if stale}
      <p class="panel-note">El programa cambió: la próxima ejecución lo vuelve a cargar desde cero.</p>
    {/if}
    {#if snapshot === null}
      <p class="text-sm text-muted">Todavía no se ejecutó el programa.</p>
    {:else}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt class="text-muted">Tick</dt>
        <dd class="font-mono">{snapshot.tick}</dd>
        <dt class="text-muted">PC</dt>
        <dd class="font-mono">{snapshot.programCounter}</dd>
        <dt class="text-muted">Estado</dt>
        <dd>{snapshot.running ? "Tick en curso" : snapshot.fault !== null ? "Detenida por una falla" : "Detenida"}</dd>
      </dl>
      <RegisterTable registers={snapshot.registers} />
      {#if notice !== ""}
        <p class="panel-hint">{notice}</p>
      {/if}
    {/if}
  </div>

  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">Salidas esperadas</h3>
    <PrintOutputTable {prints} fault={lastFault} />
  </div>

  {#if assembly.valid}
    <div class="panel-card flex flex-col gap-3">
      <h3 class="panel-section-title">Listado</h3>
      <div class="max-h-96 overflow-auto">
        <table class="panel-table">
          <thead>
            <tr>
              <th>Dirección</th>
              <th>Bytes</th>
              <th>Instrucción</th>
            </tr>
          </thead>
          <tbody>
            {#each assembly.instructions as instruction (instruction.address)}
              <tr class={!stale && currentAddress === instruction.address ? "bg-neon/10" : ""}>
                <td class="font-mono">{instruction.address}</td>
                <td class="font-mono text-xs">{formatProgramHex(instruction.bytes)}</td>
                <td class="font-mono">{instruction.source}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

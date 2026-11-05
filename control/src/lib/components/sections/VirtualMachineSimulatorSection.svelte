<script lang="ts">
  import ProgramEditor from "../ProgramEditor.svelte";
  import RegisterInputs from "../RegisterInputs.svelte";
  import RegisterTable from "../RegisterTable.svelte";
  import { parseInteger } from "$lib/vm/assembler.ts";
  import { formatPrintLine, formatProgramHex, formatRegisterHex } from "$lib/vm/instruction-set.ts";
  import {
    VirtualMachine,
    finishTick,
    runTick,
    type PrintedValue,
    type VmFault,
  } from "$lib/vm/virtual-machine.ts";
  import { VM_FAULT_LABELS } from "$lib/utils/labels.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  let { draft }: { draft: ProgramDraft } = $props();

  const MAXIMUM_VISIBLE_PRINTS = 100;

  interface MachineSnapshot {
    readonly registers: readonly number[];
    readonly programCounter: number;
    readonly tick: number;
    readonly running: boolean;
    readonly fault: VmFault | null;
    readonly faultAddress: number;
  }

  let machine = new VirtualMachine();
  let initialRegisters = $state(["0", "0", "0", "0"]);
  let loadedHex = $state<string | null>(null);
  let snapshot = $state<MachineSnapshot | null>(null);
  let prints = $state<readonly PrintedValue[]>([]);
  let notice = $state("");

  const assembly = $derived(draft.assembly);
  const currentHex = $derived(assembly.valid ? formatProgramHex(assembly.code) : null);
  const stale = $derived(loadedHex !== null && currentHex !== loadedHex);
  const registersValid = $derived(initialRegisters.every((text) => parseInteger(text) !== null));
  const runnable = $derived(assembly.valid && registersValid);
  const currentAddress = $derived(snapshot !== null && snapshot.running ? snapshot.programCounter : null);
  const visiblePrints = $derived(prints.slice(-MAXIMUM_VISIBLE_PRINTS).toReversed());

  function refresh(): void {
    snapshot = {
      registers: machine.registers,
      programCounter: machine.programCounter,
      tick: machine.tickNumber,
      running: machine.isRunning,
      fault: machine.fault,
      faultAddress: machine.faultAddress,
    };
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
    prints = [...prints, ...newPrints].slice(-MAXIMUM_VISIBLE_PRINTS);
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
    <h3 class="panel-section-title">Simulador de la VM</h3>
    <p class="panel-hint">
      Ejecuta el programa en esta computadora con el intérprete de referencia, sin ningún nodo. Un tick
      corre desde la dirección 0 hasta HALT o hasta una falla y los registros se conservan de un tick al
      siguiente, como en el nodo. El programa es el mismo de la pestaña VM.
    </p>
    <div class="grid gap-4 lg:grid-cols-2">
      <ProgramEditor {draft} />
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium text-slate-600">Registros al reiniciar</span>
          <RegisterInputs bind:values={initialRegisters} />
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="panel-button-primary" disabled={!runnable} onclick={executeTick}>
            Ejecutar tick
          </button>
          <button type="button" class="panel-button" disabled={!runnable} onclick={executeStep}>Paso</button>
          <button type="button" class="panel-button" disabled={!runnable} onclick={reset}>Reiniciar</button>
        </div>
        {#if !registersValid}
          <p class="panel-error-text">Cada registro es un entero de 32 bits, en decimal o con 0x.</p>
        {/if}
        {#if stale}
          <p class="panel-note">El programa cambió: la próxima ejecución lo vuelve a cargar desde cero.</p>
        {/if}
        {#if snapshot === null}
          <p class="text-sm text-slate-600">Todavía no se ejecutó el programa.</p>
        {:else}
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt class="text-slate-600">Tick</dt>
            <dd class="font-mono">{snapshot.tick}</dd>
            <dt class="text-slate-600">PC</dt>
            <dd class="font-mono">{snapshot.programCounter}</dd>
            <dt class="text-slate-600">Estado</dt>
            <dd>{snapshot.running ? "Tick en curso" : "Detenida"}</dd>
          </dl>
          <RegisterTable registers={snapshot.registers} />
          {#if snapshot.fault !== null}
            <p class="panel-error-text">
              Falla en la dirección {snapshot.faultAddress}: {VM_FAULT_LABELS[snapshot.fault]}.
            </p>
          {/if}
          {#if notice !== ""}
            <p class="panel-hint">{notice}</p>
          {/if}
        {/if}
      </div>
    </div>
  </div>

  <div class="grid gap-3 lg:grid-cols-2">
    <div class="panel-card flex flex-col gap-3">
      <h3 class="panel-section-title">Listado</h3>
      {#if assembly.valid}
        <div class="max-h-96 overflow-y-auto">
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
                <tr class={!stale && currentAddress === instruction.address ? "bg-sky-100" : ""}>
                  <td class="font-mono">{instruction.address}</td>
                  <td class="font-mono text-xs">{formatProgramHex(instruction.bytes)}</td>
                  <td class="font-mono">{instruction.source}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="text-sm text-slate-600">El programa tiene errores.</p>
      {/if}
    </div>

    <div class="panel-card flex flex-col gap-3">
      <h3 class="panel-section-title">Salidas de PRINT</h3>
      {#if visiblePrints.length === 0}
        <p class="text-sm text-slate-600">Todavía no hay salidas.</p>
      {:else}
        <div class="max-h-96 overflow-y-auto">
          <table class="panel-table">
            <thead>
              <tr>
                <th>Tick</th>
                <th>Pantalla del nodo</th>
                <th>Decimal</th>
              </tr>
            </thead>
            <tbody>
              {#each visiblePrints as print, index (index)}
                <tr>
                  <td>{print.tick}</td>
                  <td class="font-mono">{formatPrintLine(print.register, print.value)}</td>
                  <td class="text-right font-mono" title={formatRegisterHex(print.value)}>{print.value}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </div>
</div>

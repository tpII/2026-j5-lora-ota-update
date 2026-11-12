<script lang="ts">
  import PrintOutputTable from "../PrintOutputTable.svelte";
  import RegisterInputs from "../RegisterInputs.svelte";
  import RegisterTable from "../RegisterTable.svelte";
  import {
    REGISTER_COUNT,
    RETURN_STACK_DEPTH,
    VM_MINIMUM_PRINT_INTERVAL_MILLISECONDS,
    VM_RESTART_DELAY_MILLISECONDS,
  } from "$lib/protocol/protocol-contract.ts";
  import { parseInteger } from "$lib/vm/assembler.ts";
  import { formatHex } from "$lib/utils/hex.ts";
  import { ReferenceRun, isStaleRun } from "$lib/vm/reference-run.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  /**
   * The reference interpreter over the program of the editor, the column «En la computadora» of the
   * Programa section: its outputs are the ones the node is expected to report. «Ejecutar» runs the
   * program without end, with the waits of the node, one animation frame at a time.
   */
  let { draft }: { draft: ProgramDraft } = $props();

  const reference = new ReferenceRun();
  let run = $state.raw(reference.snapshot);
  let initialRegisters = $state(Array.from({ length: REGISTER_COUNT }, () => "0"));
  let executing = $state(false);
  let frameHandle: number | null = null;

  const assembly = $derived(draft.assembly);
  const stale = $derived(isStaleRun(run, assembly.valid ? assembly.code : null));
  const registers = $derived(initialRegisters.map(parseInteger));
  const registersValid = $derived(registers.every((value) => value !== null));
  const runnable = $derived(assembly.valid && registersValid);
  const snapshot = $derived(run.machine);
  const currentAddress = $derived(snapshot !== null && snapshot.running ? snapshot.programCounter : null);
  const restartSeconds = VM_RESTART_DELAY_MILLISECONDS / 1000;
  const stateLabel = $derived.by(() => {
    if (snapshot === null) {
      return "";
    }
    if (snapshot.running) {
      return executing ? "En ejecución" : "En pausa";
    }
    const cause = run.stopCause === "fault" ? "Detenida por una falla" : "Detenida en HALT";
    return executing ? `${cause}; vuelve a empezar a los ${restartSeconds} s` : cause;
  });

  // The continuous run stops when the program changes or the section goes away.
  $effect(() => {
    if (stale && executing) {
      pause();
    }
  });
  $effect(() => () => pause());

  function currentInputs(): { code: Uint8Array; values: number[] } | null {
    if (!assembly.valid || !registersValid) {
      return null;
    }
    return { code: assembly.code, values: registers.map((value) => value ?? 0) };
  }

  function runFrame(now: number): void {
    const inputs = currentInputs();
    if (inputs === null) {
      pause();
      return;
    }
    reference.run(inputs.code, inputs.values, now);
    run = reference.snapshot;
    frameHandle = requestAnimationFrame(runFrame);
  }

  function execute(): void {
    const inputs = currentInputs();
    if (inputs === null) {
      return;
    }
    reference.start(inputs.code, inputs.values, performance.now());
    run = reference.snapshot;
    executing = true;
    frameHandle = requestAnimationFrame(runFrame);
  }

  function pause(): void {
    if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    executing = false;
  }

  function perform(action: "reset" | "step"): void {
    pause();
    const inputs = currentInputs();
    if (inputs === null) {
      return;
    }
    if (action === "reset") {
      reference.reset(inputs.code, inputs.values);
    } else {
      reference.step(inputs.code, inputs.values, performance.now());
    }
    run = reference.snapshot;
  }
</script>

<div class="flex flex-col gap-3">
  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">En la computadora</h3>
    <p class="panel-hint">
      Intérprete de referencia. El programa corre sin parar, como en el nodo: espera
      {VM_MINIMUM_PRINT_INTERVAL_MILLISECONDS} ms después de cada PRINT y lo que pida cada SLEEP y, tras HALT o una
      falla, vuelve a empezar desde la dirección 0 a los {restartSeconds} s. Los registros se conservan. «Paso»
      ejecuta una instrucción sin esperas.
    </p>
    <div class="flex flex-col gap-1">
      <span class="panel-caption">Registros al reiniciar</span>
      <RegisterInputs bind:values={initialRegisters} />
    </div>
    <div class="flex flex-wrap gap-2">
      {#if executing}
        <button type="button" class="panel-button panel-button-primary" onclick={pause}>Pausar</button>
      {:else}
        <button type="button" class="panel-button panel-button-primary" disabled={!runnable} onclick={execute}>
          Ejecutar
        </button>
      {/if}
      <button type="button" class="panel-button" disabled={!runnable} onclick={() => perform("step")}>Paso</button>
      <button type="button" class="panel-button" disabled={!runnable} onclick={() => perform("reset")}>Reiniciar</button>
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
        <dt class="text-muted">Estado</dt>
        <dd>{stateLabel}</dd>
        <dt class="text-muted">Arranques</dt>
        <dd class="font-mono">{snapshot.starts}</dd>
        <dt class="text-muted">Salidas</dt>
        <dd class="font-mono">{snapshot.outputs}</dd>
        <dt class="text-muted">PC</dt>
        <dd class="font-mono">{snapshot.programCounter}</dd>
        <dt class="text-muted">Pila de retorno</dt>
        <dd class="font-mono">{snapshot.stackDepth} de {RETURN_STACK_DEPTH}</dd>
      </dl>
      <RegisterTable registers={snapshot.registers} />
    {/if}
  </div>

  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">Salidas esperadas</h3>
    <PrintOutputTable prints={run.prints} fault={run.lastFault} />
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
              <th>Etiqueta</th>
              <th>Instrucción</th>
            </tr>
          </thead>
          <tbody>
            {#each assembly.instructions as instruction (instruction.address)}
              <tr class={!stale && currentAddress === instruction.address ? "bg-neon/10" : ""}>
                <td class="font-mono">{instruction.address}</td>
                <td class="font-mono text-xs">{formatHex(instruction.bytes)}</td>
                <td class="font-mono">{instruction.labels.map((label) => `${label}:`).join(" ")}</td>
                <td class="font-mono">{instruction.source}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

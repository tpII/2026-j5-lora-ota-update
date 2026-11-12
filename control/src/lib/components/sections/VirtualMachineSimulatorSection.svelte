<script lang="ts">
  import PrintOutputTable from "../PrintOutputTable.svelte";
  import RegisterInputs from "../RegisterInputs.svelte";
  import RegisterTable from "../RegisterTable.svelte";
  import { REGISTER_COUNT } from "$lib/protocol/protocol-contract.ts";
  import { parseInteger } from "$lib/vm/assembler.ts";
  import { formatHex } from "$lib/utils/hex.ts";
  import { ReferenceRun, isStaleRun } from "$lib/vm/reference-run.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  /**
   * The reference interpreter over the program of the editor, the column «En la computadora» of the
   * Programa section: its outputs are the ones the node is expected to report.
   */
  let { draft }: { draft: ProgramDraft } = $props();

  const reference = new ReferenceRun();
  let run = $state.raw(reference.snapshot);
  let initialRegisters = $state(Array.from({ length: REGISTER_COUNT }, () => "0"));

  const assembly = $derived(draft.assembly);
  const stale = $derived(isStaleRun(run, assembly.valid ? assembly.code : null));
  const registers = $derived(initialRegisters.map(parseInteger));
  const registersValid = $derived(registers.every((value) => value !== null));
  const runnable = $derived(assembly.valid && registersValid);
  const snapshot = $derived(run.machine);
  const currentAddress = $derived(snapshot !== null && snapshot.running ? snapshot.programCounter : null);

  function perform(action: "reset" | "tick" | "step"): void {
    if (!assembly.valid || !registersValid) {
      return;
    }
    reference[action](assembly.code, registers.map((value) => value ?? 0));
    run = reference.snapshot;
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
      <button type="button" class="panel-button panel-button-primary" disabled={!runnable} onclick={() => perform("tick")}>
        Ejecutar tick
      </button>
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
        <dt class="text-muted">Tick</dt>
        <dd class="font-mono">{snapshot.tick}</dd>
        <dt class="text-muted">PC</dt>
        <dd class="font-mono">{snapshot.programCounter}</dd>
        <dt class="text-muted">Estado</dt>
        <dd>{snapshot.running ? "Tick en curso" : snapshot.fault !== null ? "Detenida por una falla" : "Detenida"}</dd>
      </dl>
      <RegisterTable registers={snapshot.registers} />
      {#if run.haltedTick !== null}
        <p class="panel-hint">El tick {run.haltedTick} terminó en HALT.</p>
      {/if}
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
              <th>Instrucción</th>
            </tr>
          </thead>
          <tbody>
            {#each assembly.instructions as instruction (instruction.address)}
              <tr class={!stale && currentAddress === instruction.address ? "bg-neon/10" : ""}>
                <td class="font-mono">{instruction.address}</td>
                <td class="font-mono text-xs">{formatHex(instruction.bytes)}</td>
                <td class="font-mono">{instruction.source}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

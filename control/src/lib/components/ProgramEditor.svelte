<script lang="ts">
  import { countWithNoun } from "$lib/utils/format.ts";
  import { PROGRAM_CAPACITY, REGISTER_COUNT, VM_PIN_COUNT } from "$lib/protocol/protocol-contract.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  let { draft }: { draft: ProgramDraft } = $props();

  const assembly = $derived(draft.assembly);
</script>

<div class="flex flex-col gap-2">
  <label class="panel-label">
    <span class="sr-only">Programa en ensamblador</span>
    <textarea
      class="panel-input min-h-64 font-mono text-sm leading-5 {assembly.valid ? '' : 'panel-input-invalid'}"
      spellcheck="false"
      autocomplete="off"
      bind:value={draft.source}
    ></textarea>
  </label>
  <p class="panel-hint">
    Una instrucción por línea, operandos separados por comas o espacios, registros R1 a R{REGISTER_COUNT}, enteros en
    decimal o con 0x y comentarios después de «;;». Una etiqueta como «loop:» al comienzo de una línea nombra la
    instrucción siguiente, para JMP, JZ, JNZ, JNEG y CALL. PINM, PINR y PINW usan los pines 0 a {VM_PIN_COUNT - 1} de la VM, que son
    los mismos en las dos placas; la columna «En la computadora» muestra el GPIO de cada uno.
  </p>
  {#if assembly.valid}
    <p class="text-xs text-muted">
      {assembly.code.length} de {PROGRAM_CAPACITY} bytes, {countWithNoun(assembly.instructions.length, "instrucción", "instrucciones")}.
    </p>
  {:else}
    <ul class="flex flex-col gap-1">
      {#each assembly.problems as problem, index (index)}
        <li class="panel-error-text">Línea {problem.line}: {problem.message}</li>
      {/each}
    </ul>
  {/if}
</div>

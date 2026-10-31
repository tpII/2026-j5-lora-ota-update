<script lang="ts">
  import { PROGRAM_CAPACITY, formatProgramHex } from "$lib/vm/instruction-set.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  let { draft }: { draft: ProgramDraft } = $props();

  const assembly = $derived(draft.assembly);
</script>

<div class="flex flex-col gap-2">
  <label class="panel-label">
    Programa en assembly
    <textarea
      class="panel-input min-h-64 font-mono text-sm leading-5 {assembly.valid ? '' : 'panel-input-invalid'}"
      spellcheck="false"
      autocomplete="off"
      bind:value={draft.source}
    ></textarea>
  </label>
  <p class="panel-hint">
    Una instrucción por línea, operandos separados por comas o espacios, registros R1 a R4, enteros en
    decimal o con 0x y comentarios después de «;;».
  </p>
  {#if assembly.valid}
    <p class="text-xs text-slate-600">
      {assembly.code.length} de {PROGRAM_CAPACITY} bytes, {assembly.instructions.length}
      {assembly.instructions.length === 1 ? "instrucción" : "instrucciones"}.
    </p>
    <code class="block max-h-24 overflow-y-auto rounded-md bg-slate-100 px-2 py-1 font-mono text-xs break-all text-slate-700">
      {formatProgramHex(assembly.code)}
    </code>
  {:else}
    <ul class="flex flex-col gap-1">
      {#each assembly.problems as problem, index (index)}
        <li class="panel-error-text">Línea {problem.line}: {problem.message}</li>
      {/each}
    </ul>
  {/if}
</div>

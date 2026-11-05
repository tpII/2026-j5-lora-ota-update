<script lang="ts">
  import { REGISTER_COUNT } from "$lib/vm/instruction-set.ts";
  import { parseInteger } from "$lib/vm/assembler.ts";

  /** One text per register, so that 0x values can be typed. */
  let { values = $bindable() }: { values: string[] } = $props();

  const indices = Array.from({ length: REGISTER_COUNT }, (_, index) => index);
</script>

<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
  {#each indices as index (index)}
    <label class="panel-label">
      R{index + 1}
      <input
        class="panel-input w-full min-w-0 font-mono {parseInteger(values[index] ?? '') === null ? 'panel-input-invalid' : ''}"
        type="text"
        inputmode="text"
        title="Entero de 32 bits, en decimal o con 0x"
        spellcheck="false"
        bind:value={values[index]}
      />
    </label>
  {/each}
</div>

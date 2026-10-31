<script lang="ts">
  import { formatRegisterHex } from "$lib/vm/instruction-set.ts";

  let { registers }: { registers: readonly number[] } = $props();
</script>

<table class="panel-table w-auto">
  <thead>
    <tr>
      <th>Registro</th>
      <th>Decimal</th>
      <th>Hexadecimal</th>
    </tr>
  </thead>
  <tbody>
    {#each registers as value, index (index)}
      <tr>
        <td class="font-mono font-semibold">R{index + 1}</td>
        <td class="text-right font-mono">{value}</td>
        <td class="font-mono">{formatRegisterHex(value)}</td>
      </tr>
    {/each}
  </tbody>
</table>

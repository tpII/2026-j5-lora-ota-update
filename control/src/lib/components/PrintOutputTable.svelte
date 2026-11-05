<script lang="ts">
  import { formatPrintLine, formatRegisterHex } from "$lib/vm/instruction-set.ts";
  import type { PrintedValue } from "$lib/vm/virtual-machine.ts";
  import type { VirtualMachineFaultRecord } from "$lib/nodes/node-state.ts";
  import { formatShortClockTime } from "$lib/utils/format.ts";
  import { VM_FAULT_LABELS } from "$lib/utils/labels.ts";

  /**
   * The PRINT outputs of a VM and its last fault, drawn the same way for the reference interpreter
   * and for a node so that the expected and the reported outputs compare row by row (metric M5).
   * `prints` is in the order they happened; the table shows the newest first. `showHostTime` adds
   * the hour at which the panel received each output, which only the outputs of a node carry.
   */
  let {
    prints,
    fault,
    showHostTime = false,
  }: {
    prints: readonly (PrintedValue & { readonly hostTime?: number })[];
    fault: Pick<VirtualMachineFaultRecord, "tick" | "address" | "reason"> | null;
    showHostTime?: boolean;
  } = $props();

  const MAXIMUM_VISIBLE_PRINTS = 100;

  const visiblePrints = $derived(prints.slice(-MAXIMUM_VISIBLE_PRINTS).toReversed());
</script>

<div class="flex flex-col gap-2">
  {#if fault !== null}
    <p class="panel-error-text">
      Última falla, en el tick {fault.tick} y la dirección {fault.address}: {VM_FAULT_LABELS[fault.reason]}.
    </p>
  {/if}
  {#if visiblePrints.length === 0}
    <p class="text-sm text-muted">Todavía no hay salidas.</p>
  {:else}
    <div class="max-h-96 overflow-auto">
      <table class="panel-table">
        <thead>
          <tr>
            <th>Tick</th>
            <th>Pantalla del nodo</th>
            <th>Decimal</th>
            {#if showHostTime}
              <th>Hora</th>
            {/if}
          </tr>
        </thead>
        <tbody>
          {#each visiblePrints as print, index (index)}
            <tr>
              <td>{print.tick}</td>
              <td class="font-mono">{formatPrintLine(print.register, print.value)}</td>
              <td class="text-right font-mono" title={formatRegisterHex(print.value)}>{print.value}</td>
              {#if showHostTime}
                <td class="font-mono text-xs">
                  {print.hostTime === undefined ? "" : formatShortClockTime(print.hostTime)}
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

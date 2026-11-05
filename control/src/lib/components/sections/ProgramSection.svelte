<script lang="ts">
  import ProgramEditor from "../ProgramEditor.svelte";
  import VirtualMachineSection from "./VirtualMachineSection.svelte";
  import VirtualMachineSimulatorSection from "./VirtualMachineSimulatorSection.svelte";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  /**
   * The Programa section: the single editor of the program draft, the reference interpreter that
   * computes the expected outputs and the VM of the chosen node that reports its own, side by side
   * (metric M5). `openUpdate`, when given, turns the mention of the Actualización section into a
   * link to it.
   */
  let {
    panel,
    draft,
    openUpdate,
  }: { panel: ControlPanel; draft: ProgramDraft; openUpdate?: () => void } = $props();
</script>

<div class="flex flex-col gap-3">
  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">Editor del programa</h3>
    <p class="panel-hint">
      El editor no envía nada a los nodos: los programas les llegan como imágenes, que se firman, se cargan
      y se activan desde la pestaña
      {#if openUpdate === undefined}
        Actualización.
      {:else}
        <button
          type="button"
          class="font-medium text-neon underline-offset-2 hover:underline"
          onclick={openUpdate}>Actualización</button
        >.
      {/if}
    </p>
    <ProgramEditor {draft} />
  </div>

  <div class="grid items-start gap-3 lg:grid-cols-2">
    <VirtualMachineSimulatorSection {draft} />
    <VirtualMachineSection {panel} />
  </div>
</div>

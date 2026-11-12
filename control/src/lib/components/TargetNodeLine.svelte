<script lang="ts">
  import type { TestTarget } from "$lib/state/radio-test-activity.ts";

  /**
   * The node that the actions of a section go to: the one chosen in the node strip or the graph,
   * or, while a test of the section runs, the node of the test, which choosing another node does
   * not move. `role` names it as the section sees it: "Nodo", "Nodo origen", "Emisor".
   */
  let { target, role = "Nodo" }: { target: TestTarget; role?: string } = $props();

  const connection = $derived(target.connection);
  const pinned = $derived(target.pinned);
</script>

{#if connection === null}
  <p class="flex flex-wrap items-center gap-2 text-sm text-warn">
    <span class="panel-caption text-warn">{role}:</span>
    {pinned ? "La conexión del nodo de la prueba en curso se cerró." : "Elegir arriba un nodo conectado e identificado."}
  </p>
{:else}
  <p class="flex flex-wrap items-center gap-2 text-sm">
    <span class="panel-caption">{role}:</span>
    <span class="panel-oled px-1.5 py-0.5 text-sm">{connection.state.identifier}</span>
    {#if pinned}
      <span class="panel-hint">(el de la prueba en curso)</span>
    {/if}
  </p>
{/if}

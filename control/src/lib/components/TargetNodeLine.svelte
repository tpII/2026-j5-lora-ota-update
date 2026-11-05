<script lang="ts">
  import type { ConnectionView, ControlPanel } from "$lib/state/control-panel.svelte.ts";

  /**
   * The node that the actions of a section go to: the one chosen in the node strip or the graph.
   * `role` names it as the section sees it: "Nodo", "Nodo origen", "Emisor". A section with a test
   * in progress passes the node of the test as `connection`, which the chosen node no longer moves.
   */
  let {
    panel,
    role = "Nodo",
    connection: pinnedConnection = undefined,
  }: { panel: ControlPanel; role?: string; connection?: ConnectionView | null } = $props();

  const connection = $derived(
    pinnedConnection === undefined ? panel.selectedIdentifiedConnection : pinnedConnection,
  );
  const pinned = $derived(pinnedConnection !== undefined);
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

<script lang="ts" generics="Key extends string">
  import type { Snippet } from "svelte";
  import { panelElementId, tabElementId } from "./tab-navigation.ts";

  /**
   * The panels of a tab list drawn by `Tabs` with the same `tabs` and prefixes: one panel per tab,
   * in the order of `tabs`, with the content of its key, shown while its tab is selected.
   */
  let {
    tabs,
    selected,
    tabIdPrefix,
    panelIdPrefix,
    panels,
  }: {
    tabs: readonly { readonly key: Key; readonly label: string }[];
    selected: Key;
    tabIdPrefix: string;
    panelIdPrefix: string;
    panels: { readonly [Item in Key]: Snippet };
  } = $props();
</script>

{#each tabs as tab (tab.key)}
  <div
    id={panelElementId(panelIdPrefix, tab.key)}
    role="tabpanel"
    aria-labelledby={tabElementId(tabIdPrefix, tab.key)}
    hidden={selected !== tab.key}
  >
    {@render panels[tab.key]()}
  </div>
{/each}

<script lang="ts" generics="Key extends string">
  import type { Snippet } from "svelte";
  import { adjacentTabIndex, focusTab, panelElementId, tabElementId } from "./tab-navigation.ts";

  /**
   * A tab list whose tabs control the panels with the identifiers `panelIdPrefix` + key, which the
   * caller draws. The keyboard follows tab-navigation.ts. `badge` draws extra content after the
   * label of a tab. Each tab carries its element identifier also as data-testid, the name the
   * screenshot driver (tools/control_panel_screenshot_driver.mjs) finds it by.
   */
  let {
    tabs,
    selected = $bindable(),
    tabIdPrefix,
    panelIdPrefix,
    label,
    labelledby,
    variant = "underline",
    badge,
  }: {
    tabs: readonly { readonly key: Key; readonly label: string }[];
    selected: Key;
    tabIdPrefix: string;
    panelIdPrefix: string;
    label?: string;
    labelledby?: string;
    /** "underline" for the sections of the panel, "outline" for a choice inside a section. */
    variant?: "underline" | "outline";
    badge?: Snippet<[Key]>;
  } = $props();

  function selectWithKeyboard(event: KeyboardEvent): void {
    const index = tabs.findIndex((tab) => tab.key === selected);
    const next = tabs[adjacentTabIndex(event.key, index, tabs.length) ?? -1];
    if (next !== undefined) {
      event.preventDefault();
      selected = next.key;
      focusTab(tabIdPrefix, next.key);
    }
  }
</script>

<div
  class="flex flex-wrap gap-1 {variant === 'underline' ? 'border-b border-line' : ''}"
  role="tablist"
  aria-label={label}
  aria-labelledby={labelledby}
  tabindex="-1"
  onkeydown={selectWithKeyboard}
>
  {#each tabs as tab (tab.key)}
    {@const current = tab.key === selected}
    <button
      id={tabElementId(tabIdPrefix, tab.key)}
      data-testid={tabElementId(tabIdPrefix, tab.key)}
      type="button"
      role="tab"
      aria-selected={current}
      aria-controls={panelElementId(panelIdPrefix, tab.key)}
      tabindex={current ? 0 : -1}
      class={variant === "underline"
        ? `-mb-px border-b-2 px-3 py-2 text-sm font-medium ${current ? "border-neon text-neon" : "border-transparent text-muted hover:border-line-strong hover:text-ink"}`
        : `panel-choice ${current ? "panel-choice-current" : ""}`}
      onclick={() => (selected = tab.key)}
    >
      {tab.label}
      {@render badge?.(tab.key)}
    </button>
  {/each}
</div>

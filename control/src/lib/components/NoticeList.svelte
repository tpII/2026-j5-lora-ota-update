<script lang="ts">
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();
</script>

{#if panel.notices.length > 0}
  <ul class="flex flex-col gap-2" aria-live="polite">
    {#each panel.notices as notice (notice.identifier)}
      <li
        class="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm {notice.level === 'error'
          ? 'border-danger/40 bg-danger/10 text-danger'
          : 'border-line-strong bg-surface text-ink'}"
      >
        <span>{notice.text}</span>
        <button
          type="button"
          class="shrink-0 text-xs font-medium underline-offset-2 hover:underline"
          onclick={() => panel.dismissNotice(notice.identifier)}
        >
          Cerrar
        </button>
      </li>
    {/each}
  </ul>
{/if}

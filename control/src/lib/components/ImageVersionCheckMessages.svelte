<script lang="ts">
  import type { ImageVersionCheck } from "$lib/image/image-preparation.ts";

  /** Why the node would reject an image of the version, and what deserves attention anyway. */
  let { check }: { check: ImageVersionCheck } = $props();
</script>

{#if check.problem !== null}
  <p class="panel-error-text">{check.problem}</p>
{/if}
{#each check.warnings as warning (warning)}
  <p class="text-xs text-warn">{warning}</p>
{/each}

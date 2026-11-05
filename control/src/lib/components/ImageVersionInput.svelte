<script lang="ts">
  import {
    MAXIMUM_IMAGE_VERSION,
    MINIMUM_IMAGE_VERSION,
    proposeImageVersion,
  } from "$lib/image/image-format.ts";
  import type { ImageVersionCheck } from "$lib/image/image-preparation.ts";
  import { formatVersionDate } from "$lib/utils/format.ts";

  let { version = $bindable(), check }: { version: number; check: ImageVersionCheck } = $props();

  const date = $derived(Number.isInteger(version) ? formatVersionDate(version) : null);
</script>

<div class="flex flex-col gap-1">
  <div class="flex flex-wrap items-end gap-2">
    <label class="panel-label">
      Versión
      <input
        class="panel-input w-40 font-mono {check.acceptable ? '' : 'panel-input-invalid'}"
        type="number"
        min={MINIMUM_IMAGE_VERSION}
        max={MAXIMUM_IMAGE_VERSION}
        step="1"
        bind:value={version}
      />
    </label>
    <button type="button" class="panel-button" onclick={() => (version = proposeImageVersion(Date.now()))}>
      Proponer la hora actual
    </button>
  </div>
  {#if date !== null}
    <p class="panel-hint">Como hora Unix, la versión corresponde al {date} de esta computadora.</p>
  {/if}
  {#if check.problem !== null}
    <p class="panel-error-text">{check.problem}</p>
  {/if}
  {#each check.warnings as warning (warning)}
    <p class="text-xs text-amber-800">{warning}</p>
  {/each}
</div>

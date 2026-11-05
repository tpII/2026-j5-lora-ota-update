<script lang="ts">
  import type { BoardModel } from "$lib/console/console-event.ts";
  import { BOARD_IMAGES } from "$lib/utils/board-images.ts";

  /** `class` sets the width; the height follows from the 5:2 crop of the photograph. */
  let { model, class: className = "" }: { model: BoardModel | null; class?: string } = $props();
</script>

{#if model === null}
  <div
    class="aspect-5/2 shrink-0 rounded-md border border-dashed border-line-strong bg-raised {className}"
    aria-hidden="true"
  ></div>
{:else}
  <img
    src={BOARD_IMAGES[model]}
    alt=""
    width="800"
    height="320"
    draggable="false"
    class="aspect-5/2 shrink-0 rounded-md bg-surface object-cover outline-1 -outline-offset-1 outline-line select-none {className}"
  />
{/if}

<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The head of the results of an automated test: its title and status, the progress bar, a summary
   * line, the failure and whether the node was left as it was before the test.
   */
  let {
    title,
    status,
    failed = false,
    progress = null,
    failure = null,
    restored = null,
    restorationProblems = [],
    children,
  }: {
    title: Snippet;
    /** Status of the test, in Spanish. */
    status: string;
    failed?: boolean;
    /** Share of the test done, from 0 to 1; null leaves the bar out. */
    progress?: number | null;
    failure?: string | null;
    /** True or false once the test tried to restore the node; null before that or when it does not. */
    restored?: boolean | null;
    restorationProblems?: readonly string[];
    /** The summary line: counts and times. */
    children?: Snippet;
  } = $props();

  const percentage = $derived(progress === null ? 0 : Math.min(1, Math.max(0, progress)) * 100);
</script>

<div class="flex flex-wrap items-baseline justify-between gap-2">
  <h3 class="panel-section-title">{@render title()}</h3>
  <span class="text-sm {failed ? 'text-danger' : 'text-muted'}">{status}</span>
</div>
{#if progress !== null}
  <div
    class="h-2 w-full overflow-hidden rounded-full bg-line-strong"
    role="progressbar"
    aria-label="Avance de la prueba"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={Math.round(percentage)}
  >
    <div class="h-full bg-neon transition-[width] duration-300 ease-out" style="width: {percentage}%"></div>
  </div>
{/if}
{#if children !== undefined}
  <p class="text-sm text-muted">{@render children()}</p>
{/if}
{#if failure !== null}
  <p class="panel-error-text">{failure}</p>
{/if}
{#if restored === true}
  <p class="text-sm text-ok">El nodo volvió a su modulación anterior y reanudó los HELLO.</p>
{:else if restored === false}
  <div class="panel-error-text">
    No se pudo dejar el nodo como estaba:
    <ul class="list-disc pl-5">
      {#each restorationProblems as problem (problem)}
        <li>{problem}</li>
      {/each}
    </ul>
  </div>
{/if}

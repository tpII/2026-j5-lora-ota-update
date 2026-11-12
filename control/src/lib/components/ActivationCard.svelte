<script lang="ts">
  import { MAXIMUM_IMAGE_VERSION, MINIMUM_IMAGE_VERSION } from "$lib/protocol/protocol-contract.ts";
  import {
    ACTIVATION_BLOCK_REASON_LABELS,
    activationReadiness,
    describeForcedActivation,
    pendingActivationVersion,
  } from "$lib/update/activation.ts";
  import { isImageVersion } from "$lib/image/image-format.ts";
  import { countWithNoun, formatImageVersion } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  let version = $state<number | null>(null);
  /** Last version the panel proposed, so a new pending version replaces it but an edit stays. */
  let proposed: number | null = null;

  const update = $derived(panel.update);
  const graph = $derived(panel.connectionGraph);
  /** The node chosen above, which receives the order; null when there is none. */
  const target = $derived(update.target);
  const pending = $derived(pendingActivationVersion(graph));

  $effect(() => {
    if (pending !== null && pending !== proposed) {
      proposed = pending;
      version = pending;
    }
  });

  const validVersion = $derived(version !== null && isImageVersion(version) ? version : null);
  const readiness = $derived(validVersion === null ? null : activationReadiness(graph, validVersion));
  /** Why the node chosen would answer `activate` with an error; null when it would accept it. */
  const targetProblem = $derived(update.activationProblem(validVersion));
  const canActivate = $derived(targetProblem === null && readiness !== null && readiness.ready);
  const canForce = $derived(targetProblem === null && readiness !== null && !readiness.ready);

  function send(): void {
    if (validVersion !== null) {
      void update.activate(validVersion);
    }
  }

  function force(): void {
    if (readiness !== null && window.confirm(describeForcedActivation(readiness))) {
      send();
    }
  }
</script>

<div class="panel-card flex flex-col gap-3">
  <h3 class="panel-section-title">Activación</h3>
  <p class="panel-hint">
    Al activar una versión, el HELLO del nodo la anuncia como activa y cada vecino que la tiene disponible la activa al escucharlo, un
    salto por HELLO.
  </p>
  <div class="flex flex-wrap items-end gap-3">
    <label class="panel-label">
      Versión
      <input
        class="panel-input w-40 font-mono"
        type="number"
        min={MINIMUM_IMAGE_VERSION}
        max={MAXIMUM_IMAGE_VERSION}
        step="1"
        bind:value={version}
      />
    </label>
    <button type="button" class="panel-button panel-button-primary" disabled={!canActivate} onclick={send}>
      {validVersion === null || target === null
        ? "Activar"
        : `Activar la versión ${validVersion} en ${target.state.identifier}`}
    </button>
  </div>
  {#if pending === null}
    <p class="panel-hint">Ningún nodo del grafo anuncia una versión disponible mayor que su versión activa.</p>
  {/if}
  {#if targetProblem !== null && version !== null}
    <p class="panel-hint">{targetProblem}</p>
  {/if}

  {#if readiness !== null}
    <p class="text-sm">
      {readiness.nodeCount === 0
        ? "El grafo de conexiones todavía no tiene nodos."
        : `${readiness.activeCount} de ${countWithNoun(readiness.nodeCount, "nodo", "nodos")} ${readiness.activeCount === 1 ? "ejecuta" : "ejecutan"} la versión ${readiness.version}.`}
    </p>
    {#if readiness.blockers.length > 0}
      <div class="flex flex-col gap-1">
        <span class="panel-caption">Nodos que bloquean la orden</span>
        <ul class="flex flex-col gap-1 text-sm">
          {#each readiness.blockers as blocker (blocker.id)}
            <li>
              <span class="font-mono font-semibold">{blocker.id}</span>: {ACTIVATION_BLOCK_REASON_LABELS[blocker.reason]}
              {#if blocker.availableVersion !== null}
                <span class="text-faint">(disponible: {formatImageVersion(blocker.availableVersion)})</span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}

  <details class="rounded-md border border-danger/40 p-3">
    <summary class="cursor-pointer text-sm font-medium text-danger">Activación forzada (RF5)</summary>
    <div class="mt-2 flex flex-col gap-2">
      <p class="text-sm text-muted">
        El firmware no impone el bloqueo del panel. La activación forzada envía la orden aunque algún nodo del grafo
        no anuncie la versión como disponible: los nodos que la tienen la activan enseguida y los demás, cuando
        completan la imagen y escuchan a un vecino que la anuncia como activa. Mientras tanto la red ejecuta dos
        programas distintos.
      </p>
      <div>
        <button type="button" class="panel-button panel-button-danger" disabled={!canForce} onclick={force}>
          Forzar la activación
        </button>
      </div>
    </div>
  </details>
</div>

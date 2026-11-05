<script lang="ts">
  import { buildActivateCommand } from "$lib/console/console-command.ts";
  import {
    activationReadiness,
    pendingActivationVersion,
    type ActivationBlockReason,
    type ConnectionGraph,
  } from "$lib/nodes/connection-graph.ts";
  import { MAXIMUM_IMAGE_VERSION, MINIMUM_IMAGE_VERSION, isImageVersion } from "$lib/image/image-format.ts";
  import { formatImageVersion } from "$lib/utils/format.ts";
  import { ACTIVATION_BLOCK_REASON_LABELS } from "$lib/utils/labels.ts";
  import type { ConnectionView, ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let {
    panel,
    graph,
    target,
  }: {
    panel: ControlPanel;
    graph: ConnectionGraph;
    /** The node chosen above, which receives the order; null when there is none. */
    target: ConnectionView | null;
  } = $props();

  let version = $state<number | null>(null);
  /** Last version the panel proposed, so a new pending version replaces it but an edit stays. */
  let proposed: number | null = null;

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
  const targetProblem = $derived.by(() => {
    if (target === null) {
      return "Falta elegir arriba un nodo conectado e identificado.";
    }
    if (validVersion === null) {
      return "La versión es un entero de 1 a 4294967295.";
    }
    const state = target.state;
    if (state.activeVersion === validVersion) {
      return `${state.identifier} ya ejecuta la versión ${validVersion}.`;
    }
    if (state.availableVersion !== validVersion) {
      return `${state.identifier} tiene disponible la versión ${formatImageVersion(state.availableVersion)}: solo puede activar esa.`;
    }
    if (state.activeVersion !== null && validVersion <= state.activeVersion) {
      return `La versión no es mayor que la activa de ${state.identifier}.`;
    }
    return null;
  });
  const canActivate = $derived(targetProblem === null && readiness !== null && readiness.ready);
  const canForce = $derived(targetProblem === null && readiness !== null && !readiness.ready);

  function send(): void {
    if (target === null || validVersion === null) {
      return;
    }
    const result = buildActivateCommand(validVersion);
    if (result.valid) {
      void panel.sendCommand(target.key, result.command);
    }
  }

  function force(): void {
    if (readiness === null) {
      return;
    }
    const blockersWith = (reason: ActivationBlockReason) =>
      readiness.blockers.filter((blocker) => blocker.reason === reason);
    const missing = blockersWith("missing").map((blocker) => blocker.id);
    const newer = blockersWith("newer").map(
      (blocker) => `${blocker.id} (versión ${formatImageVersion(blocker.availableVersion)})`,
    );
    const unknown = blockersWith("unknown").map((blocker) => blocker.id);
    const sentences = [`Activación forzada de la versión ${validVersion}.`];
    if (missing.length > 0) {
      sentences.push(
        `Estos nodos todavía no la tienen disponible: ${missing.join(", ")}. Cada uno la activa recién ` +
          "cuando complete la imagen y escuche a un vecino que la anuncie como activa; mientras tanto " +
          "ejecuta su programa activo.",
      );
    }
    if (newer.length > 0) {
      sentences.push(
        `Estos nodos tienen disponible una versión mayor: ${newer.join(", ")}. Nunca van a recibir ni ` +
          `activar la versión ${validVersion} y siguen con su programa activo; para unificar la red hay ` +
          "que cargar una imagen con una versión mayor que la de ellos.",
      );
    }
    if (unknown.length > 0) {
      sentences.push(
        `De estos nodos no se conoce la versión disponible: ${unknown.join(", ")}. Pueden activarla más ` +
          "adelante o nunca, si ya tienen una versión mayor.",
      );
    }
    sentences.push("¿Forzar la activación?");
    const confirmed = window.confirm(sentences.join(" "));
    if (confirmed) {
      send();
    }
  }
</script>

<div class="panel-card flex flex-col gap-3">
  <h3 class="panel-section-title">Activación</h3>
  <p class="panel-hint">
    Al activarla, su HELLO la anuncia como activa y cada vecino que la tiene disponible la activa al escucharlo, un
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
    <button type="button" class="panel-button-primary" disabled={!canActivate} onclick={send}>
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
        : `${readiness.activeCount} de ${readiness.nodeCount} nodos ejecutan la versión ${readiness.version}.`}
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
        <button type="button" class="panel-button-danger" disabled={!canForce} onclick={force}>
          Forzar la activación
        </button>
      </div>
    </div>
  </details>
</div>

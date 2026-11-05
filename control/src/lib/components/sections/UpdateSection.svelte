<script lang="ts">
  import ActivationCard from "../ActivationCard.svelte";
  import ImageLoadCard from "../ImageLoadCard.svelte";
  import OperatorKeyCard from "../OperatorKeyCard.svelte";
  import RollbackCard from "../RollbackCard.svelte";
  import UpdateMetricsCard from "../UpdateMetricsCard.svelte";
  import UpdateProgress from "../UpdateProgress.svelte";
  import { STATUS_COMMAND, buildLoadImageCommand } from "$lib/console/console-command.ts";
  import {
    checkImageVersion,
    highestAvailableVersion,
    type ImageVersionCheck,
  } from "$lib/image/image-preparation.ts";
  import { formatImageVersion, formatNumber, formatShortClockTime } from "$lib/utils/format.ts";
  import { describeErrorReason } from "$lib/utils/labels.ts";
  import { ImageSigningSession } from "$lib/state/image-signing-session.svelte.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  let { panel, draft, active }: { panel: ControlPanel; draft: ProgramDraft; active: boolean } = $props();

  interface LoadAttempt {
    readonly key: string;
    readonly node: string;
    readonly version: number;
    readonly imageSize: number;
    readonly hostTime: number;
  }

  const session = new ImageSigningSession();

  let targetKey = $state("");
  let lastLoad = $state<LoadAttempt | null>(null);

  const candidates = $derived(panel.identifiedConnections);
  const target = $derived(candidates.find((connection) => connection.key === targetKey));
  const graph = $derived(panel.connectionGraph);
  const networkAvailableVersion = $derived(highestAvailableVersion(graph));

  $effect(() => {
    if (target === undefined && candidates.length > 0) {
      targetKey = candidates[0]?.key ?? "";
    }
  });

  /** How the node chosen and the rest of the graph would take an image of `version`. */
  function checkVersion(version: number): ImageVersionCheck {
    return checkImageVersion(version, {
      targetAvailableVersion: target?.state.availableVersion ?? null,
      networkAvailableVersion,
      nowMilliseconds: panel.now,
    });
  }

  /** Signs `program` with `version` and sends `load_image` to the node chosen. */
  async function signAndLoad(program: Uint8Array, version: number): Promise<string | null> {
    const connection = target;
    if (connection === undefined || connection.state.identifier === null) {
      return "No hay un nodo conectado e identificado.";
    }
    let image: Uint8Array;
    try {
      image = (await session.sign(program, version)).image;
    } catch (error) {
      return `No se pudo firmar la imagen: ${error instanceof Error ? error.message : String(error)}`;
    }
    const result = buildLoadImageCommand(image);
    if (!result.valid) {
      return result.problems.map((problem) => problem.message).join(" ");
    }
    const hostTime = Date.now();
    if (!(await panel.sendCommand(connection.key, result.command))) {
      return "No se pudo enviar la imagen al nodo.";
    }
    lastLoad = {
      key: connection.key,
      node: connection.state.identifier,
      version,
      imageSize: image.length,
      hostTime,
    };
    return null;
  }

  const loadResponse = $derived.by(() => {
    const attempt = lastLoad;
    if (attempt === null) {
      return null;
    }
    const state = panel.connection(attempt.key)?.state;
    if (state === undefined) {
      return { kind: "unknown" as const };
    }
    const accepted = state.images.some(
      (record) =>
        record.version === attempt.version && record.via === "console" && record.hostTime >= attempt.hostTime,
    );
    if (accepted) {
      return { kind: "accepted" as const };
    }
    const error = state.errors.findLast(
      (record) => record.command === "load_image" && record.hostTime >= attempt.hostTime,
    );
    return error === undefined ? { kind: "waiting" as const } : { kind: "rejected" as const, error };
  });

  function queryEveryNode(): void {
    for (const connection of candidates) {
      void panel.sendCommand(connection.key, STATUS_COMMAND);
    }
  }
</script>

<div class="flex flex-col gap-3">
  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">Actualización</h3>
    <p class="panel-hint">
      El operador firma el programa del editor como imagen y la carga en un nodo conectado, que pasa a ser el nodo
      origen: la envía en ráfagas a sus vecinos y cada uno la reenvía a los vecinos que anuncian una versión
      disponible menor. Los nodos no la ejecutan hasta la orden de activación, que el panel habilita cuando todo el
      grafo de conexiones anuncia la versión como disponible. Las imágenes viven solo en la RAM: un nodo que se
      reinicia vuelve a la versión 0 y recibe de sus vecinos la imagen disponible.
    </p>
    <div class="flex flex-wrap items-end gap-3">
      <label class="panel-label">
        Nodo conectado
        <select class="panel-input" bind:value={targetKey} disabled={candidates.length === 0}>
          {#each candidates as connection (connection.key)}
            <option value={connection.key}>{connection.state.identifier}</option>
          {/each}
        </select>
      </label>
      <button type="button" class="panel-button" disabled={candidates.length === 0} onclick={queryEveryNode}>
        Consultar el estado de todos los nodos conectados
      </button>
    </div>
    {#if target === undefined}
      <p class="text-sm text-slate-600">No hay nodos identificados conectados.</p>
    {:else}
      {@const state = target.state}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt class="text-slate-600">Versión activa</dt>
        <dd class="font-mono">{formatImageVersion(state.activeVersion)}</dd>
        <dt class="text-slate-600">Versión disponible</dt>
        <dd class="font-mono">{formatImageVersion(state.availableVersion)}</dd>
        <dt class="text-slate-600">Clave del operador</dt>
        <dd>
          {#if state.operatorKey === null}
            <span class="text-slate-500">se conoce con el próximo arranque</span>
          {:else}
            {state.operatorKey === "default" ? "la clave pública por defecto" : "una clave pública propia"}
          {/if}
        </dd>
      </dl>
      {#if session.key !== null && state.operatorKey !== null && session.key.isDefault !== (state.operatorKey === "default")}
        <p class="panel-note">
          {session.key.isDefault
            ? "El nodo verifica con una clave pública propia y la clave cargada es la del par por defecto: va a rechazar la firma."
            : "El nodo verifica con la clave pública por defecto y la clave cargada es otra: va a rechazar la firma."}
        </p>
      {/if}
    {/if}
    {#if lastLoad !== null && loadResponse !== null}
      <p class="text-sm">
        Última carga, a las {formatShortClockTime(lastLoad.hostTime)}: versión
        <span class="font-mono">{lastLoad.version}</span>
        ({formatNumber(lastLoad.imageSize)} bytes) en <span class="font-mono">{lastLoad.node}</span>.
        {#if loadResponse.kind === "accepted"}
          <span class="text-emerald-700">El nodo la aceptó y la envía a sus vecinos.</span>
        {:else if loadResponse.kind === "rejected"}
          <span class="text-red-700">
            El nodo la rechazó: {loadResponse.error.reason} ({describeErrorReason(loadResponse.error.reason)}){loadResponse
              .error.detail === null
              ? ""
              : `, ${loadResponse.error.detail}`}.
          </span>
        {:else if loadResponse.kind === "waiting"}
          <span class="text-slate-600">Esperando la respuesta del nodo.</span>
        {/if}
      </p>
    {/if}
  </div>

  <OperatorKeyCard {session} />
  <ImageLoadCard {panel} {draft} {session} {target} {checkVersion} {signAndLoad} />
  <ActivationCard {panel} {graph} {target} />
  <UpdateProgress {panel} {graph} />
  <RollbackCard {draft} {session} {target} {panel} {checkVersion} {signAndLoad} />
  <UpdateMetricsCard {panel} {active} />
</div>

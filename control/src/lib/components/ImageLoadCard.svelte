<script lang="ts">
  import ImageVersionInput from "./ImageVersionInput.svelte";
  import {
    DEFAULT_FRAGMENT_SIZE,
    FRAGMENT_SIZE_QUERY_COMMAND,
    MAXIMUM_FRAGMENT_SIZE,
    MINIMUM_FRAGMENT_SIZE,
    buildFragmentSizeCommand,
  } from "$lib/console/console-command.ts";
  import { IMAGE_HEADER_SIZE, IMAGE_SIGNATURE_SIZE } from "$lib/image/image-format.ts";
  import type { ImageVersionCheck } from "$lib/image/image-preparation.ts";
  import { PROGRAM_CAPACITY } from "$lib/vm/instruction-set.ts";
  import { formatNumber, formatShortClockTime } from "$lib/utils/format.ts";
  import { describeErrorReason } from "$lib/utils/labels.ts";
  import type { ConnectionView, ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import type { ImageSigningSession } from "$lib/state/image-signing-session.svelte.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  let {
    panel,
    draft,
    session,
    target,
    checkVersion,
    signAndLoad,
    openProgram,
  }: {
    panel: ControlPanel;
    draft: ProgramDraft;
    session: ImageSigningSession;
    /** The node chosen above, which becomes the origin of the update; null when there is none. */
    target: ConnectionView | null;
    checkVersion: (version: number) => ImageVersionCheck;
    signAndLoad: (program: Uint8Array, version: number) => Promise<string | null>;
    /** Switches the panel to the Programa tab, where the draft is edited. */
    openProgram: () => void;
  } = $props();

  /** Problems of the draft listed here; the rest are seen in the editor. */
  const MAXIMUM_LISTED_PROBLEMS = 3;

  let fragmentSize = $state<number>(DEFAULT_FRAGMENT_SIZE);
  let fragmentSizeProblem = $state<string | null>(null);
  let problem = $state<string | null>(null);
  let loading = $state(false);

  const assembly = $derived(draft.assembly);
  const check = $derived(checkVersion(session.nextVersion));
  const connected = $derived(target !== null);
  const nodeFragmentSize = $derived(target?.state.transfer?.fragmentSize ?? null);
  const imageSize = $derived(assembly.valid ? IMAGE_HEADER_SIZE + assembly.code.length + IMAGE_SIGNATURE_SIZE : null);
  const fragmentCount = $derived(
    imageSize === null || nodeFragmentSize === null ? null : Math.ceil(imageSize / nodeFragmentSize),
  );
  const canLoad = $derived(connected && !loading && session.key !== null && assembly.valid && check.acceptable);

  /** How the node answered the last `load_image` of the panel, from its events. */
  const loadResponse = $derived.by(() => {
    const attempt = session.lastLoad;
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

  async function load(): Promise<void> {
    if (!assembly.valid) {
      problem = "El programa tiene errores: corregirlos en la pestaña Programa antes de firmarlo.";
      return;
    }
    loading = true;
    problem = null;
    try {
      problem = await signAndLoad(assembly.code, session.nextVersion);
    } finally {
      loading = false;
    }
  }

  function setFragmentSize(): void {
    const result = buildFragmentSizeCommand(fragmentSize);
    if (!result.valid) {
      fragmentSizeProblem = result.problems.map((item) => item.message).join(" ");
      return;
    }
    fragmentSizeProblem = null;
    if (target !== null) {
      void panel.sendCommand(target.key, result.command);
    }
  }
</script>

<form
  class="panel-card flex flex-col gap-3"
  onsubmit={(event) => {
    event.preventDefault();
    void load();
  }}
>
  <h3 class="panel-section-title">Firmar y cargar una imagen</h3>
  <p class="panel-hint">
    El nodo solo acepta una versión mayor que su versión disponible y la envía enseguida en una ráfaga completa, sin
    activarla.
  </p>

  <div class="flex flex-wrap items-end gap-3">
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <span class="panel-caption">Programa del editor</span>
      {#if assembly.valid}
        <p class="text-sm">
          {formatNumber(assembly.code.length)} de {formatNumber(PROGRAM_CAPACITY)} bytes, {assembly.instructions.length}
          {assembly.instructions.length === 1 ? "instrucción" : "instrucciones"}{#if imageSize !== null}; la imagen
            ocupa {formatNumber(imageSize)} bytes con el encabezado y la firma{/if}.
        </p>
      {:else}
        <p class="text-sm text-danger">
          {assembly.problems.length === 1
            ? "El programa tiene un error y no se puede firmar."
            : `El programa tiene ${assembly.problems.length} errores y no se puede firmar.`}
        </p>
        <ul class="flex flex-col gap-1">
          {#each assembly.problems.slice(0, MAXIMUM_LISTED_PROBLEMS) as item, index (index)}
            <li class="panel-error-text">Línea {item.line}: {item.message}</li>
          {/each}
          {#if assembly.problems.length > MAXIMUM_LISTED_PROBLEMS}
            <li class="panel-hint">Los demás se ven en el editor.</li>
          {/if}
        </ul>
      {/if}
    </div>
    <button type="button" class="panel-button" onclick={openProgram}>Editar en Programa</button>
  </div>

  <ImageVersionInput bind:version={session.nextVersion} {check} />

  <div class="flex flex-wrap items-end gap-2">
    <label class="panel-label">
      Tamaño de fragmento (bytes)
      <input
        class="panel-input w-28"
        type="number"
        min={MINIMUM_FRAGMENT_SIZE}
        max={MAXIMUM_FRAGMENT_SIZE}
        step="1"
        bind:value={fragmentSize}
      />
    </label>
    <button type="button" class="panel-button" disabled={!connected} onclick={setFragmentSize}>
      Fijar en el nodo
    </button>
    <button
      type="button"
      class="panel-button"
      disabled={!connected}
      onclick={() => target !== null && panel.sendCommand(target.key, FRAGMENT_SIZE_QUERY_COMMAND)}
    >
      Consultar la transferencia
    </button>
  </div>
  <p class="panel-hint">
    El tamaño vale para las ráfagas completas del nodo elegido, de {MINIMUM_FRAGMENT_SIZE} a {MAXIMUM_FRAGMENT_SIZE}
    bytes; al arrancar vale {DEFAULT_FRAGMENT_SIZE}. Las reparaciones usan el tamaño del reporte.
    {#if nodeFragmentSize !== null}
      Hoy el nodo usa {nodeFragmentSize} bytes{#if imageSize !== null && fragmentCount !== null}: la imagen de
        {formatNumber(imageSize)} bytes viaja en {fragmentCount}
        {fragmentCount === 1 ? "fragmento" : "fragmentos"}{/if}.
    {/if}
  </p>
  {#if fragmentSizeProblem !== null}
    <p class="panel-error-text">{fragmentSizeProblem}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-3">
    <button type="submit" class="panel-button-primary" disabled={!canLoad}>
      {loading
        ? "Firmando…"
        : target === null || target.state.identifier === null
          ? "Firmar y cargar"
          : `Firmar y cargar en ${target.state.identifier}`}
    </button>
    {#if session.key === null}
      <span class="panel-hint">Falta cargar o generar la clave del operador.</span>
    {:else if !connected}
      <span class="panel-hint">Falta elegir arriba un nodo conectado e identificado.</span>
    {:else if !assembly.valid}
      <span class="panel-hint">Falta corregir el programa en la pestaña Programa.</span>
    {/if}
  </div>
  {#if problem !== null}
    <p class="panel-error-text">{problem}</p>
  {/if}

  {#if session.lastLoad !== null && loadResponse !== null}
    {@const attempt = session.lastLoad}
    <p class="text-sm">
      <span class="panel-caption">Última carga:</span>
      versión <span class="font-mono">{attempt.version}</span> ({formatNumber(attempt.imageSize)} bytes) en
      <span class="font-mono">{attempt.node}</span>, a las {formatShortClockTime(attempt.hostTime)}:
      {#if loadResponse.kind === "accepted"}
        <span class="text-ok">aceptada; el nodo la envía a sus vecinos.</span>
      {:else if loadResponse.kind === "rejected"}
        <span class="text-danger">
          rechazada: {loadResponse.error.reason} ({describeErrorReason(loadResponse.error.reason)}){loadResponse
            .error.detail === null
            ? ""
            : `, ${loadResponse.error.detail}`}.
        </span>
      {:else if loadResponse.kind === "waiting"}
        <span class="text-muted">esperando la respuesta del nodo.</span>
      {:else}
        <span class="text-muted">sin respuesta conocida: la conexión ya no está.</span>
      {/if}
    </p>
  {/if}
</form>

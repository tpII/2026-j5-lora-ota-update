<script lang="ts">
  import ImageVersionInput from "./ImageVersionInput.svelte";
  import ProgramEditor from "./ProgramEditor.svelte";
  import {
    DEFAULT_FRAGMENT_SIZE,
    FRAGMENT_SIZE_QUERY_COMMAND,
    MAXIMUM_FRAGMENT_SIZE,
    MINIMUM_FRAGMENT_SIZE,
    buildFragmentSizeCommand,
  } from "$lib/console/console-command.ts";
  import { IMAGE_HEADER_SIZE, IMAGE_SIGNATURE_SIZE, proposeImageVersion } from "$lib/image/image-format.ts";
  import type { ImageVersionCheck } from "$lib/image/image-preparation.ts";
  import { formatNumber } from "$lib/utils/format.ts";
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
  }: {
    panel: ControlPanel;
    draft: ProgramDraft;
    session: ImageSigningSession;
    target: ConnectionView | undefined;
    checkVersion: (version: number) => ImageVersionCheck;
    signAndLoad: (program: Uint8Array, version: number) => Promise<string | null>;
  } = $props();

  let version = $state(proposeImageVersion(Date.now()));
  let fragmentSize = $state<number>(DEFAULT_FRAGMENT_SIZE);
  let fragmentSizeProblem = $state<string | null>(null);
  let problem = $state<string | null>(null);
  let loading = $state(false);

  const assembly = $derived(draft.assembly);
  const check = $derived(checkVersion(version));
  const connected = $derived(target !== undefined && target.status === "open");
  const nodeFragmentSize = $derived(target?.state.transfer?.fragmentSize ?? null);
  const imageSize = $derived(assembly.valid ? IMAGE_HEADER_SIZE + assembly.code.length + IMAGE_SIGNATURE_SIZE : null);
  const fragmentCount = $derived(
    imageSize === null || nodeFragmentSize === null ? null : Math.ceil(imageSize / nodeFragmentSize),
  );
  const canLoad = $derived(connected && !loading && session.key !== null && assembly.valid && check.acceptable);

  async function load(): Promise<void> {
    if (!assembly.valid) {
      problem = "El programa tiene errores: corregirlos antes de firmarlo.";
      return;
    }
    loading = true;
    problem = null;
    try {
      problem = await signAndLoad(assembly.code, version);
      if (problem === null) {
        // The next image needs a greater version.
        version = Math.max(proposeImageVersion(Date.now()), version + 1);
      }
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
    if (target !== undefined) {
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
    El nodo solo acepta una versión mayor que su versión disponible y, si la imagen pasa la verificación, la envía
    enseguida en una ráfaga completa. No la activa. El programa se puede probar antes en la pestaña Simulador, que
    comparte este editor.
  </p>
  <ProgramEditor {draft} />
  <ImageVersionInput bind:version {check} />

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
      onclick={() => target !== undefined && panel.sendCommand(target.key, FRAGMENT_SIZE_QUERY_COMMAND)}
    >
      Consultar la transferencia
    </button>
  </div>
  <p class="panel-hint">
    El tamaño vale para las ráfagas completas del nodo conectado, de {MINIMUM_FRAGMENT_SIZE} a {MAXIMUM_FRAGMENT_SIZE}
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
        : target?.state.identifier === null || target === undefined
          ? "Firmar y cargar"
          : `Firmar y cargar en ${target.state.identifier}`}
    </button>
    {#if session.key === null}
      <span class="panel-hint">Falta cargar o generar la clave del operador.</span>
    {:else if !connected}
      <span class="panel-hint">Falta un nodo conectado.</span>
    {/if}
  </div>
  {#if problem !== null}
    <p class="panel-error-text">{problem}</p>
  {/if}
</form>

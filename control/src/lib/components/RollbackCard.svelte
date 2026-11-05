<script lang="ts">
  import ImageVersionInput from "./ImageVersionInput.svelte";
  import { PROGRAM_COMMAND } from "$lib/console/console-command.ts";
  import { proposeImageVersion } from "$lib/image/image-format.ts";
  import { recoverProgram, type ImageVersionCheck } from "$lib/image/image-preparation.ts";
  import { disassemble } from "$lib/vm/disassembler.ts";
  import { formatProgramHex } from "$lib/vm/instruction-set.ts";
  import { VM_FAULT_LABELS } from "$lib/utils/labels.ts";
  import { formatImageVersion, formatShortClockTime } from "$lib/utils/format.ts";
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

  interface ProgramSource {
    readonly key: string;
    /** Version of the image the program came in. */
    readonly version: number;
    readonly program: Uint8Array;
    readonly description: string;
  }

  let version = $state(proposeImageVersion(Date.now()));
  let problem = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let loading = $state(false);

  const check = $derived(checkVersion(version));
  const connected = $derived(target !== undefined && target.status === "open");
  const record = $derived(target?.state.program ?? null);
  const recovery = $derived(record === null ? null : recoverProgram(record.code));
  const stale = $derived(
    record !== null && target?.state.activeVersion !== null && target?.state.activeVersion !== record.version,
  );

  /** Programs the operator can sign again: the active one of the node and those signed here. */
  const sources = $derived.by(() => {
    const list: ProgramSource[] = [];
    if (record !== null && recovery !== null && recovery.valid) {
      list.push({
        key: `node:${record.version}:${record.hostTime}`,
        version: record.version,
        program: recovery.program,
        description: `programa activo de ${target?.state.identifier ?? "—"}, informado a las ${formatShortClockTime(record.hostTime)}`,
      });
    }
    for (const signed of session.signedImages.toReversed()) {
      list.push({
        key: `signed:${signed.version}:${signed.hostTime}`,
        version: signed.version,
        program: signed.program,
        description: `firmada en el panel a las ${formatShortClockTime(signed.hostTime)}`,
      });
    }
    return list;
  });

  async function resign(source: ProgramSource): Promise<void> {
    loading = true;
    problem = null;
    notice = null;
    try {
      problem = await signAndLoad(source.program, version);
      if (problem === null) {
        notice = `Se cargó el programa de la versión ${source.version} como versión ${version}.`;
        version = Math.max(proposeImageVersion(Date.now()), version + 1);
      }
    } finally {
      loading = false;
    }
  }

  function moveToEditor(source: ProgramSource): void {
    const result = disassemble(source.program);
    if (!result.valid) {
      problem = `El programa no se puede desensamblar: ${VM_FAULT_LABELS[result.fault]} en la dirección ${result.address}.`;
      return;
    }
    if (!window.confirm("El programa reemplaza al del editor. ¿Continuar?")) {
      return;
    }
    draft.source = `;; Program of version ${source.version}\n${result.source}`;
    problem = null;
    notice = `El programa de la versión ${source.version} quedó en el editor de la sección Firmar y cargar una imagen.`;
  }
</script>

<div class="panel-card flex flex-col gap-3">
  <h3 class="panel-section-title">Reversión</h3>
  <p class="panel-hint">
    Los nodos nunca vuelven solos a una versión anterior y el protocolo no tiene una orden de abortar. Para revertir
    o abortar una actualización, el operador carga un programa anterior como imagen con una versión nueva, mayor que
    todas las de la red. El nodo conectado devuelve su programa activo con el comando program; el panel también
    recuerda las imágenes que firmó desde que se abrió.
  </p>
  <div>
    <button
      type="button"
      class="panel-button"
      disabled={!connected}
      onclick={() => target !== undefined && panel.sendCommand(target.key, PROGRAM_COMMAND)}
    >
      Pedir el programa activo
    </button>
  </div>
  {#if record !== null}
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt class="text-slate-600">Programa activo</dt>
      <dd>
        versión <span class="font-mono">{formatImageVersion(record.version)}</span>, {record.size} bytes, a las
        {formatShortClockTime(record.hostTime)}
        {#if stale}
          <span class="text-amber-800">(el nodo activó otra versión después: conviene pedirlo de nuevo)</span>
        {/if}
      </dd>
    </dl>
    {#if recovery !== null && !recovery.valid}
      <p class="text-sm text-slate-600">{recovery.message}</p>
    {/if}
  {/if}

  <ImageVersionInput bind:version {check} />

  {#if sources.length === 0}
    <p class="text-sm text-slate-600">Todavía no hay programas para volver a firmar.</p>
  {:else}
    <div class="overflow-x-auto">
      <table class="panel-table">
        <thead>
          <tr>
            <th>Versión original</th>
            <th>Origen</th>
            <th>Código</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each sources as source (source.key)}
            <tr>
              <td class="font-mono">{source.version}</td>
              <td class="text-xs">{source.description}</td>
              <td class="max-w-64 truncate font-mono text-xs" title={formatProgramHex(source.program)}>
                {formatProgramHex(source.program)}
              </td>
              <td class="whitespace-nowrap">
                <button
                  type="button"
                  class="panel-button"
                  disabled={!connected || loading || session.key === null || !check.acceptable}
                  onclick={() => resign(source)}
                >
                  Firmar como versión {Number.isInteger(version) ? version : "—"} y cargar
                </button>
                <button type="button" class="panel-button" onclick={() => moveToEditor(source)}>
                  Llevar al editor
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  {#if session.key === null}
    <p class="panel-hint">Para volver a firmar hace falta la clave del operador.</p>
  {/if}
  {#if notice !== null}
    <p class="text-sm text-emerald-700">{notice}</p>
  {/if}
  {#if problem !== null}
    <p class="panel-error-text">{problem}</p>
  {/if}
</div>

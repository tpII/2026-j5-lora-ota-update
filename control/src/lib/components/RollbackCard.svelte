<script lang="ts">
  import ImageVersionCheckMessages from "./ImageVersionCheckMessages.svelte";
  import { PROGRAM_COMMAND } from "$lib/commands/console-command.ts";
  import { recoverProgram } from "$lib/image/image-preparation.ts";
  import { disassemble } from "$lib/vm/disassembler.ts";
  import { formatHex } from "$lib/utils/hex.ts";
  import { describeProgramDefect } from "$lib/vm/fault-descriptions.ts";
  import { formatImageVersion, formatShortClockTime } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  let {
    panel,
    draft,
    openProgram,
  }: {
    panel: ControlPanel;
    draft: ProgramDraft;
    /** Switches the panel to the Programa tab, where the draft is edited. */
    openProgram: () => void;
  } = $props();

  interface ProgramSource {
    readonly key: string;
    /** Version of the image the program came in. */
    readonly version: number;
    readonly program: Uint8Array;
    readonly description: string;
  }

  let problem = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let loading = $state(false);

  const update = $derived(panel.update);
  const session = $derived(update.session);
  /** The node chosen above, which becomes the origin of the update; null when there is none. */
  const target = $derived(update.target);
  /** The next version is the one of the signing card, so both always propose the same. */
  const version = $derived(session.nextVersion);
  const check = $derived(update.checkVersion(version));
  const connected = $derived(target !== null);
  const record = $derived(target?.state.program ?? null);
  const recovery = $derived(record === null ? null : recoverProgram(record.code));
  const stale = $derived(
    record !== null &&
      target !== null &&
      target.state.activeVersion !== null &&
      target.state.activeVersion !== record.version,
  );

  /** Programs the operator can sign again: the active one of the node and those signed here. */
  const sources = $derived.by(() => {
    const list: ProgramSource[] = [];
    if (target !== null && record !== null && recovery !== null && recovery.valid) {
      list.push({
        key: `node:${record.version}:${record.hostTime}`,
        version: record.version,
        program: recovery.program,
        description: `programa activo de ${target.state.identifier}, informado a las ${formatShortClockTime(record.hostTime)}`,
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
    const signedVersion = version;
    try {
      problem = await update.loadImage(source.program, signedVersion);
      if (problem === null) {
        notice =
          `Se envió el programa de la versión ${source.version} como versión ${signedVersion}; ` +
          "la respuesta del nodo aparece en «Última carga» de «Firmar y cargar una imagen».";
      }
    } finally {
      loading = false;
    }
  }

  function moveToEditor(source: ProgramSource): void {
    const result = disassemble(source.program);
    if (!result.valid) {
      problem = `El programa no se puede desensamblar: ${describeProgramDefect(result.defect, result.address)}.`;
      return;
    }
    if (!window.confirm("El programa reemplaza al del editor. ¿Continuar?")) {
      return;
    }
    draft.source = `;; Program of version ${source.version}\n${result.source}`;
    problem = null;
    notice = `El programa de la versión ${source.version} quedó en el editor de la pestaña Programa.`;
    openProgram();
  }
</script>

<div class="panel-card flex flex-col gap-3">
  <h3 class="panel-section-title">Reversión</h3>
  <p class="panel-hint">
    El protocolo no tiene orden de abortar: para revertir, se vuelve a firmar un programa anterior con una versión
    mayor que todas las de la red.
  </p>
  <div>
    <button
      type="button"
      class="panel-button"
      disabled={!connected}
      title="Envía el comando program al nodo elegido, que devuelve su programa activo"
      onclick={() => target !== null && panel.sendCommand(target.key, PROGRAM_COMMAND)}
    >
      Pedir el programa activo
    </button>
  </div>
  {#if record !== null}
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt class="text-muted">Programa activo</dt>
      <dd>
        versión <span class="font-mono">{formatImageVersion(record.version)}</span>, {record.size} bytes, a las
        {formatShortClockTime(record.hostTime)}
        {#if stale}
          <span class="text-warn">(el nodo activó otra versión después: conviene pedirlo de nuevo)</span>
        {/if}
      </dd>
    </dl>
    {#if recovery !== null && !recovery.valid}
      <p class="text-sm text-muted">{recovery.message}</p>
    {/if}
  {/if}

  <div class="flex flex-col gap-1">
    <p class="text-sm">
      <span class="panel-caption">Próxima versión:</span>
      <span class="font-mono">{Number.isInteger(version) ? version : "—"}</span>
      <span class="text-xs text-muted">(la misma de «Firmar y cargar una imagen», donde se cambia)</span>
    </p>
    <ImageVersionCheckMessages {check} />
  </div>

  {#if sources.length === 0}
    <p class="text-sm text-muted">Todavía no hay programas para volver a firmar.</p>
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
              <td class="max-w-64 truncate font-mono text-xs" title={formatHex(source.program)}>
                {formatHex(source.program)}
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
  {#if sources.length > 0 && session.key === null}
    <p class="panel-hint">Para volver a firmar hace falta la clave del operador.</p>
  {/if}
  {#if notice !== null}
    <p class="text-sm text-ok">{notice}</p>
  {/if}
  {#if problem !== null}
    <p class="panel-error-text">{problem}</p>
  {/if}
</div>

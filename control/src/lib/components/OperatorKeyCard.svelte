<script lang="ts">
  import { DEFAULT_OPERATOR_PUBLIC_KEY } from "$lib/image/image-signing.ts";
  import { operatorKeyDefinition } from "$lib/image/image-preparation.ts";
  import type { ImageSigningSession } from "$lib/state/image-signing-session.svelte.ts";

  let { session }: { session: ImageSigningSession } = $props();

  let problem = $state<string | null>(null);
  let busy = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  const key = $derived(session.key);

  async function importFile(file: File): Promise<void> {
    busy = true;
    problem = null;
    try {
      problem = await session.importKey(await file.text(), file.name);
    } catch (error) {
      problem = `No se pudo leer el archivo: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
      if (fileInput !== null) {
        fileInput.value = "";
      }
    }
  }

  async function generate(): Promise<void> {
    if (
      session.key !== null &&
      !window.confirm("La clave cargada se reemplaza por un par nuevo. ¿Continuar?")
    ) {
      return;
    }
    busy = true;
    problem = null;
    try {
      await session.generateKey();
    } catch (error) {
      problem = `El navegador no pudo generar el par: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
    }
  }

  function downloadPrivateKey(): void {
    const pem = session.generatedPrivateKeyPem;
    if (pem === null) {
      return;
    }
    const url = URL.createObjectURL(new Blob([pem], { type: "application/x-pem-file" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = session.keyFileName ?? "operator_key.pem";
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }
</script>

<div class="panel-card flex flex-col gap-3">
  <h3 class="panel-section-title">Clave del operador</h3>
  <p class="panel-hint">
    El panel firma cada imagen con la clave privada Ed25519 del operador, que queda solo en la memoria de esta
    pestaña: al recargar el panel hay que volver a cargarla. Los nodos verifican la firma con la clave pública
    compilada en su firmware. El par por defecto del repositorio, con la clave privada en
    keys/default_operator_key.pem, solo sirve para el banco.
  </p>

  <div class="flex flex-wrap items-center gap-2">
    <input
      bind:this={fileInput}
      class="hidden"
      type="file"
      accept=".pem,application/x-pem-file,text/plain"
      onchange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file !== undefined) {
          void importFile(file);
        }
      }}
    />
    <button type="button" class="panel-button" disabled={busy} onclick={() => fileInput?.click()}>
      Cargar una clave privada (PEM)
    </button>
    <button type="button" class="panel-button" disabled={busy} onclick={generate}>Generar un par nuevo</button>
    {#if key !== null}
      <button type="button" class="panel-button-danger" disabled={busy} onclick={() => session.forgetKey()}>
        Olvidar la clave
      </button>
    {/if}
  </div>

  {#if problem !== null}
    <p class="panel-error-text">{problem}</p>
  {/if}

  {#if key === null}
    <p class="text-sm text-slate-600">No hay una clave cargada: sin ella el panel no puede firmar imágenes.</p>
  {:else}
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt class="text-slate-600">Origen</dt>
      <dd>
        {session.keyOrigin === "generated" ? "par generado en el panel" : `archivo ${session.keyFileName ?? ""}`}
      </dd>
      <dt class="text-slate-600">Clave pública</dt>
      <dd class="flex flex-wrap items-center gap-2">
        <code class="font-mono text-xs break-all">{key.publicKey}</code>
        <button type="button" class="panel-button px-2 py-0.5 text-xs" onclick={() => copy(key.publicKey)}>
          Copiar
        </button>
      </dd>
      <dt class="text-slate-600">Par</dt>
      <dd>
        {#if key.isDefault}
          <span class="panel-badge bg-amber-100 text-amber-800">por defecto</span>
          <span class="text-slate-600">coincide con {DEFAULT_OPERATOR_PUBLIC_KEY.slice(0, 8)}…, válido solo en el banco</span>
        {:else}
          <span class="panel-badge bg-emerald-100 text-emerald-800">propio</span>
          <span class="text-slate-600">
            no coincide con la clave por defecto: solo lo aceptan los nodos compilados con esta clave pública
          </span>
        {/if}
      </dd>
    </dl>
  {/if}

  {#if key !== null && session.keyOrigin === "generated"}
    <div class="flex flex-col gap-2 rounded-md border border-slate-200 p-3">
      <p class="text-sm">
        La clave privada del par nuevo existe solo en esta pestaña. Conviene descargarla y guardarla fuera del
        repositorio; para que los nodos acepten sus firmas, la clave pública se compila en el firmware con esta
        línea de firmware/build_opt.h:
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <code class="rounded-md bg-slate-100 px-2 py-1 font-mono text-xs break-all">
          {operatorKeyDefinition(key.publicKey)}
        </code>
        <button
          type="button"
          class="panel-button px-2 py-0.5 text-xs"
          onclick={() => copy(operatorKeyDefinition(key.publicKey))}
        >
          Copiar
        </button>
      </div>
      <div>
        <button type="button" class="panel-button-primary" onclick={downloadPrivateKey}>
          Descargar la clave privada
        </button>
      </div>
    </div>
  {/if}
</div>

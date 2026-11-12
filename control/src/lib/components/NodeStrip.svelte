<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import { CONSOLE_WEBSOCKET_URL } from "$lib/protocol/protocol-contract.ts";
  import { TRANSPORT_LABELS } from "$lib/transports/console-transport.ts";
  import { CONNECTION_STATUS_LABELS, type ConnectionStatus } from "$lib/node-session/node-connection.ts";
  import BoardThumbnail from "./BoardThumbnail.svelte";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  let connectingSerial = $state(false);
  let connectingWifi = $state(false);

  const selectedKey = $derived(panel.nodes.selected?.key ?? null);

  const STATUS_DOT_CLASSES: { readonly [Status in ConnectionStatus]: string } = {
    opening: "bg-warn",
    open: "bg-ok",
    closing: "bg-warn",
    closed: "bg-faint",
  };

  async function connectSerial(): Promise<void> {
    connectingSerial = true;
    try {
      await panel.connectSerial();
    } finally {
      connectingSerial = false;
    }
  }

  async function connectWifi(): Promise<void> {
    connectingWifi = true;
    try {
      await panel.connectWifi();
    } finally {
      connectingWifi = false;
    }
  }
</script>

<section aria-label="Nodos conectados">
  <ul role="list" class="relative -mx-1 flex snap-x scroll-px-1 gap-3 overflow-x-auto px-1 pt-1 pb-2">
    {#each panel.nodes.connections as connection (connection.key)}
      {@const node = connection.state}
      {@const selected = connection.key === selectedKey}
      <li class="shrink-0 snap-start">
        <button
          type="button"
          data-testid="node-card-{node.identifier ?? connection.key}"
          aria-pressed={selected}
          class="flex h-16 w-60 items-center gap-3 rounded-lg border py-2 pr-3 pl-2 text-left {selected
            ? 'border-neon bg-neon/5'
            : 'border-line bg-surface hover:border-neon/50'}"
          onclick={() => panel.nodes.select(connection.key)}
        >
          <BoardThumbnail
            model={node.model}
            class="w-20 {connection.status === 'closed' ? 'opacity-50 grayscale' : ''}"
          />
          <div class="min-w-0 flex-1">
            <p class="flex">
              <span class="panel-oled truncate px-1.5 text-sm/5 {selected ? '' : 'text-neon/80'}">
                {#if node.identifier !== null}{node.identifier}{:else}<span aria-hidden="true">····</span><span
                    class="sr-only">Identificando…</span
                  >{/if}
              </span>
            </p>
            <p class="truncate font-mono text-caption tracking-wide text-faint uppercase">
              {node.model ?? "Placa desconocida"} · {TRANSPORT_LABELS[connection.transportKind]}
              {#if connection.duplicated}· <span class="text-warn">duplicado</span>{/if}
            </p>
            <p class="flex items-center gap-1.5 font-mono text-caption tracking-wide text-muted uppercase">
              <span
                class="size-1.5 shrink-0 rounded-full {STATUS_DOT_CLASSES[connection.status]}"
                aria-hidden="true"
              ></span>
              {CONNECTION_STATUS_LABELS[connection.status]}
            </p>
          </div>
        </button>
      </li>
    {/each}

    <li
      class="flex h-16 w-60 shrink-0 snap-start rounded-lg border border-dashed border-neon/30 text-muted"
    >
      <button
        data-testid="connect-serial"
        type="button"
        class="panel-connect-button rounded-l-lg"
        disabled={!panel.webSerialAvailable || connectingSerial}
        title={panel.webSerialAvailable ? "Elegir el puerto serie de un nodo" : "Este navegador no ofrece Web Serial"}
        onclick={connectSerial}
      >
        <Plus class="size-3.5 shrink-0" aria-hidden="true" />
        <span>{#if connectingSerial}Conectando…<span class="sr-only"> un nodo por USB</span>{:else}<span class="sr-only">Conectar un nodo por </span>USB{/if}</span>
      </button>
      <div class="my-2 border-l border-dashed border-neon/30" aria-hidden="true"></div>
      <button
        data-testid="connect-wifi"
        type="button"
        class="panel-connect-button rounded-r-lg"
        disabled={connectingWifi || panel.nodes.hasWebSocketConnection}
        title={panel.nodes.hasWebSocketConnection
          ? "Ya hay una conexión WiFi: una computadora ve un solo nodo por vez"
          : `Abrir ${CONSOLE_WEBSOCKET_URL}`}
        onclick={connectWifi}
      >
        <Plus class="size-3.5 shrink-0" aria-hidden="true" />
        <span>{#if connectingWifi}Conectando…<span class="sr-only"> un nodo por WiFi</span>{:else}<span class="sr-only">Conectar un nodo por </span>WiFi{/if}</span>
      </button>
    </li>
  </ul>
</section>

<script lang="ts">
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  let connectingSerial = $state(false);
  let connectingWifi = $state(false);

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

<header class="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
  <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
    <div>
      <h1 class="text-lg font-semibold text-slate-900">Panel de control J5</h1>
      <p class="text-xs text-slate-500">
        Red LoRa de placas Heltec · consola de los nodos por USB o por WiFi
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        class="panel-button-primary"
        disabled={!panel.webSerialAvailable || connectingSerial}
        title={panel.webSerialAvailable ? "Elegir el puerto serie de un nodo" : "Este navegador no ofrece Web Serial"}
        onclick={connectSerial}
      >
        {connectingSerial ? "Conectando…" : "Conectar por USB"}
      </button>
      <button
        type="button"
        class="panel-button-primary"
        disabled={connectingWifi || panel.hasWebSocketConnection}
        title={panel.hasWebSocketConnection
          ? "Ya hay una conexión WiFi: una computadora ve un solo nodo por vez"
          : "Abrir ws://192.168.4.1/console"}
        onclick={connectWifi}
      >
        {connectingWifi ? "Conectando…" : "Conectar por WiFi"}
      </button>
    </div>
  </div>
  {#if !panel.webSerialAvailable}
    <div class="border-t border-amber-200 bg-amber-50">
      <p class="mx-auto max-w-7xl px-4 py-2 text-sm text-amber-900">
        Este navegador no ofrece Web Serial, así que la conexión por USB no está disponible. Hace falta
        Chrome o Chromium 154 o posterior y una página servida por HTTPS o desde localhost. La conexión
        por WiFi sigue disponible.
      </p>
    </div>
  {/if}
</header>

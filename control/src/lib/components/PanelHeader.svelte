<script lang="ts">
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  const openConnectionCount = $derived(
    panel.connections.filter((connection) => connection.status === "open").length,
  );
  const graphNodeCount = $derived(panel.connectionGraph.nodes.length);
</script>

<header class="sticky top-0 z-10 border-b border-line bg-canvas/85 backdrop-blur">
  <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
    <div class="flex items-center gap-3">
      <span class="panel-oled px-2 py-1 text-sm" aria-hidden="true">J5</span>
      <div>
        <h1 class="font-display text-xl font-bold tracking-wide uppercase italic">
          Panel de control <span class="text-neon text-shadow-neon">J5</span>
        </h1>
        <p class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">
          Red LoRa de placas Heltec · consola de los nodos por USB o por WiFi
        </p>
      </div>
    </div>
    <dl class="flex gap-5 font-mono text-[0.6875rem] tracking-wider uppercase">
      <div class="flex items-center gap-2">
        <dt class="text-faint">Conexiones</dt>
        <dd class="text-neon tabular-nums text-shadow-neon-soft">{openConnectionCount}</dd>
      </div>
      <div class="flex items-center gap-2">
        <dt class="text-faint">Nodos en el grafo</dt>
        <dd class="text-neon tabular-nums text-shadow-neon-soft">{graphNodeCount}</dd>
      </div>
    </dl>
  </div>
  {#if !panel.webSerialAvailable}
    <div class="border-t border-warn/40 bg-warn/10">
      <p class="mx-auto max-w-7xl px-4 py-2 text-sm text-warn">
        Este navegador no ofrece Web Serial, así que la conexión por USB no está disponible. Hace falta
        Chrome o Chromium 154 o posterior y una página servida por HTTPS o desde localhost. La conexión
        por WiFi sigue disponible.
      </p>
    </div>
  {/if}
</header>

<script lang="ts">
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();
</script>

<header class="sticky top-0 z-10 border-b border-line bg-canvas/85 backdrop-blur">
  <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
    <div class="flex items-center gap-3">
      <span class="panel-oled px-2 py-1 text-sm">J5</span>
      <h1 class="text-xl font-semibold">Panel de control</h1>
    </div>
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

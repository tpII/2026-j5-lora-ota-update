<script lang="ts">
  let { webSerialAvailable }: { webSerialAvailable: boolean } = $props();
</script>

<header class="sticky top-0 z-10 border-b border-line bg-canvas/85 backdrop-blur" data-testid="panel-header">
  <div class="mx-auto max-w-7xl px-4 py-3">
    <div class="flex items-center gap-3">
      <span class="panel-oled px-2 py-1 text-sm">J5</span>
      <h1 class="text-xl font-semibold">Panel de control</h1>
    </div>
  </div>
  {#if !webSerialAvailable}
    <div class="panel-banner">
      <p class="mx-auto max-w-7xl px-4 py-2">
        Este navegador no ofrece Web Serial, así que la conexión por USB no está disponible. Hace falta
        Chrome o Chromium 154 o posterior y una página servida por HTTPS o desde localhost. La conexión
        por WiFi sigue disponible.
      </p>
    </div>
  {/if}
</header>

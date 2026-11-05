<script lang="ts">
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  /** The fields of the measurement sheet, shared by every export of the panel. */
  let { panel }: { panel: ControlPanel } = $props();

  const sheet = $derived(panel.measurementSheet);
  const titleId = $props.id();
</script>

<section class="panel-card flex flex-col gap-3" aria-labelledby={titleId}>
  <div>
    <h3 id={titleId} class="panel-section-title">Ficha de la medición</h3>
    <p class="panel-hint">
      Una sola ficha para todas las exportaciones del panel: se completa una vez por salida al campo y
      se corrige cuando cambia el lugar, la distancia o las antenas.
    </p>
  </div>
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    <label class="panel-label">
      Lugar
      <input
        class="panel-input"
        type="text"
        placeholder="por ejemplo: Laboratorio de la facultad"
        bind:value={sheet.place}
      />
    </label>
    <label class="panel-label">
      Distancia entre los nodos (m)
      <input
        class="panel-input {sheet.distanceValid ? '' : 'panel-input-invalid'}"
        type="number"
        min="0"
        step="any"
        placeholder="vacío si no corresponde"
        bind:value={sheet.distance}
      />
    </label>
    <label class="panel-label">
      Antenas
      <input class="panel-input" type="text" placeholder="antenas o cargas usadas" bind:value={sheet.antennas} />
    </label>
    <label class="panel-label">
      Operadores
      <input class="panel-input" type="text" bind:value={sheet.operators} />
    </label>
    <label class="panel-label sm:col-span-2">
      Notas
      <textarea class="panel-input min-h-16" bind:value={sheet.notes}></textarea>
    </label>
  </div>
</section>

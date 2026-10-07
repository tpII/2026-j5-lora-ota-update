<script lang="ts">
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import RadioSettingsForm from "$lib/components/RadioSettingsForm.svelte";

  let { panel }: { panel: ControlPanel } = $props();

  const identifiedConnections = $derived(
    panel.connections.filter((connection) => connection.state.identifier !== null),
  );
</script>

<div class="flex flex-col gap-3">
  <div class="panel-note">
    <p>
      La banda de 915 a 928 MHz admite LoRa sin autorización individual solo como modulación de banda
      ancha, así que con antena se usan solo canales de 500 kHz, centrados entre 915,25 y 927,75 MHz y
      con unos 26 dBm como máximo en el conector de antena. Los canales de 125 y 250 kHz quedan para el
      banco, con cable coaxial y atenuadores o cargas de 50 Ω. El firmware no impone estos límites: la
      responsabilidad es del operador (ADR 0004).
    </p>
    <p class="mt-1">
      Nunca transmitir sin la antena conectada. Sobre la mesa, usar la potencia mínima y el LNA de la V4.3
      puenteado.
    </p>
  </div>

  {#if identifiedConnections.length === 0}
    <div class="panel-card text-sm text-slate-600">No hay nodos identificados.</div>
  {/if}

  <div class="grid gap-3 xl:grid-cols-2">
    {#each identifiedConnections as connection (connection.key)}
      <RadioSettingsForm {panel} {connection} />
    {/each}
  </div>
</div>

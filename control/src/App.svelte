<script lang="ts">
  import CapacityTestSection from "./lib/components/sections/CapacityTestSection.svelte";
  import EchoSection from "./lib/components/sections/EchoSection.svelte";
  import EventStreamSection from "./lib/components/sections/EventStreamSection.svelte";
  import ExportSection from "./lib/components/sections/ExportSection.svelte";
  import NeighborSection from "./lib/components/sections/NeighborSection.svelte";
  import NodeCard from "./lib/components/NodeCard.svelte";
  import NoticeList from "./lib/components/NoticeList.svelte";
  import PanelHeader from "./lib/components/PanelHeader.svelte";
  import RadioSection from "./lib/components/sections/RadioSection.svelte";
  import RunSection from "./lib/components/sections/RunSection.svelte";
  import { ControlPanel } from "./lib/state/control-panel.svelte.ts";

  type SectionKey = "events" | "neighbors" | "radio" | "echo" | "runs" | "capacity" | "export";

  const SECTIONS: readonly { readonly key: SectionKey; readonly label: string }[] = [
    { key: "events", label: "Flujo de eventos" },
    { key: "neighbors", label: "Vecinos" },
    { key: "radio", label: "Radio" },
    { key: "echo", label: "Eco" },
    { key: "runs", label: "Corridas" },
    { key: "capacity", label: "Prueba de capacidad" },
    { key: "export", label: "Exportar" },
  ];

  const panel = new ControlPanel();
  let activeSection = $state<SectionKey>("events");

  function selectAdjacentSection(event: KeyboardEvent): void {
    const index = SECTIONS.findIndex((section) => section.key === activeSection);
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (offset !== 0) {
      event.preventDefault();
      const next = SECTIONS[(index + offset + SECTIONS.length) % SECTIONS.length];
      if (next !== undefined) {
        activeSection = next.key;
        document.getElementById(`tab-${next.key}`)?.focus();
      }
    }
  }
</script>

<PanelHeader {panel} />

<main class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4">
  <NoticeList {panel} />

  <section aria-label="Nodos conectados">
    {#if panel.connections.length === 0}
      <div class="panel-card text-sm text-slate-600">
        No hay nodos conectados. Conectar un nodo por USB o por WiFi con los botones de arriba.
      </div>
    {:else}
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {#each panel.connections as connection (connection.key)}
          <NodeCard {panel} {connection} />
        {/each}
      </div>
    {/if}
  </section>

  <div
    class="flex flex-wrap gap-1 border-b border-slate-200"
    role="tablist"
    aria-label="Secciones del panel"
    tabindex="-1"
    onkeydown={selectAdjacentSection}
  >
    {#each SECTIONS as section (section.key)}
      <button
        id="tab-{section.key}"
        type="button"
        role="tab"
        aria-selected={activeSection === section.key}
        aria-controls="section-{section.key}"
        tabindex={activeSection === section.key ? 0 : -1}
        class="-mb-px rounded-t-md border px-3 py-2 text-sm font-medium transition-colors {activeSection ===
        section.key
          ? 'border-slate-200 border-b-white bg-white text-sky-800'
          : 'border-transparent text-slate-600 hover:text-slate-900'}"
        onclick={() => (activeSection = section.key)}
      >
        {section.label}
      </button>
    {/each}
  </div>

  <div id="section-events" role="tabpanel" aria-labelledby="tab-events" hidden={activeSection !== "events"}>
    <EventStreamSection {panel} active={activeSection === "events"} />
  </div>
  <div id="section-neighbors" role="tabpanel" aria-labelledby="tab-neighbors" hidden={activeSection !== "neighbors"}>
    <NeighborSection {panel} />
  </div>
  <div id="section-radio" role="tabpanel" aria-labelledby="tab-radio" hidden={activeSection !== "radio"}>
    <RadioSection {panel} />
  </div>
  <div id="section-echo" role="tabpanel" aria-labelledby="tab-echo" hidden={activeSection !== "echo"}>
    <EchoSection {panel} />
  </div>
  <div id="section-runs" role="tabpanel" aria-labelledby="tab-runs" hidden={activeSection !== "runs"}>
    <RunSection {panel} />
  </div>
  <div id="section-capacity" role="tabpanel" aria-labelledby="tab-capacity" hidden={activeSection !== "capacity"}>
    <CapacityTestSection {panel} />
  </div>
  <div id="section-export" role="tabpanel" aria-labelledby="tab-export" hidden={activeSection !== "export"}>
    <ExportSection {panel} />
  </div>
</main>

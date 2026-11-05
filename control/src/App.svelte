<script lang="ts">
  import ConnectionGraphView from "./lib/components/ConnectionGraphView.svelte";
  import NodeStrip from "./lib/components/NodeStrip.svelte";
  import NoticeList from "./lib/components/NoticeList.svelte";
  import PanelHeader from "./lib/components/PanelHeader.svelte";
  import SelectedNodeDetail from "./lib/components/SelectedNodeDetail.svelte";
  import EventStreamSection from "./lib/components/sections/EventStreamSection.svelte";
  import MeasurementSection from "./lib/components/sections/MeasurementSection.svelte";
  import NetworkSection from "./lib/components/sections/NetworkSection.svelte";
  import ProgramSection from "./lib/components/sections/ProgramSection.svelte";
  import UpdateSection from "./lib/components/sections/UpdateSection.svelte";
  import { ControlPanel } from "./lib/state/control-panel.svelte.ts";
  import { ProgramDraft } from "./lib/state/program-draft.svelte.ts";

  type SectionKey = "network" | "program" | "update" | "measurements" | "events";

  const SECTIONS: readonly { readonly key: SectionKey; readonly label: string }[] = [
    { key: "network", label: "Red" },
    { key: "program", label: "Programa" },
    { key: "update", label: "Actualización" },
    { key: "measurements", label: "Mediciones" },
    { key: "events", label: "Flujo de eventos" },
  ];

  const panel = new ControlPanel();
  const draft = new ProgramDraft();
  let activeSection = $state<SectionKey>("network");

  /** Opens a section from a link inside another one, and moves the focus to its tab. */
  function openSection(key: SectionKey): void {
    activeSection = key;
    document.getElementById(`tab-${key}`)?.focus();
  }

  function selectAdjacentSection(event: KeyboardEvent): void {
    const index = SECTIONS.findIndex((section) => section.key === activeSection);
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (offset !== 0) {
      event.preventDefault();
      const next = SECTIONS[(index + offset + SECTIONS.length) % SECTIONS.length];
      if (next !== undefined) {
        openSection(next.key);
      }
    }
  }
</script>

<PanelHeader {panel} />

<main class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4">
  <NoticeList {panel} />

  <NodeStrip {panel} />
  <ConnectionGraphView {panel} />
  {#if panel.selectedConnection !== null}
    <SelectedNodeDetail {panel} connection={panel.selectedConnection} />
  {/if}

  <div
    class="flex flex-wrap gap-1 border-b border-line"
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
        class="-mb-px border-b-2 px-3 py-2 font-display text-sm font-semibold tracking-wide uppercase {activeSection ===
        section.key
          ? 'border-neon text-neon text-shadow-neon'
          : 'border-transparent text-muted hover:border-line-strong hover:text-ink'}"
        onclick={() => (activeSection = section.key)}
      >
        {section.label}
      </button>
    {/each}
  </div>

  <div id="section-network" role="tabpanel" aria-labelledby="tab-network" hidden={activeSection !== "network"}>
    <NetworkSection {panel} />
  </div>
  <div id="section-program" role="tabpanel" aria-labelledby="tab-program" hidden={activeSection !== "program"}>
    <ProgramSection {panel} {draft} openUpdate={() => openSection("update")} />
  </div>
  <div id="section-update" role="tabpanel" aria-labelledby="tab-update" hidden={activeSection !== "update"}>
    <UpdateSection {panel} {draft} active={activeSection === "update"} openProgram={() => openSection("program")} />
  </div>
  <div
    id="section-measurements"
    role="tabpanel"
    aria-labelledby="tab-measurements"
    hidden={activeSection !== "measurements"}
  >
    <MeasurementSection {panel} />
  </div>
  <div id="section-events" role="tabpanel" aria-labelledby="tab-events" hidden={activeSection !== "events"}>
    <EventStreamSection {panel} active={activeSection === "events"} />
  </div>
</main>

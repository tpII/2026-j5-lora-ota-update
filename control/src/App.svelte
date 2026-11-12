<script lang="ts">
  import ConnectionGraphView from "./lib/components/connection-graph/ConnectionGraphView.svelte";
  import NodeStrip from "./lib/components/NodeStrip.svelte";
  import NoticeList from "./lib/components/NoticeList.svelte";
  import PanelHeader from "./lib/components/PanelHeader.svelte";
  import SelectedNodeDetail from "./lib/components/SelectedNodeDetail.svelte";
  import EventStreamSection from "./lib/components/sections/EventStreamSection.svelte";
  import MeasurementSection from "./lib/components/sections/MeasurementSection.svelte";
  import NetworkSection from "./lib/components/sections/NetworkSection.svelte";
  import ProgramSection from "./lib/components/sections/ProgramSection.svelte";
  import UpdateSection from "./lib/components/sections/UpdateSection.svelte";
  import TabPanels from "./lib/components/TabPanels.svelte";
  import Tabs from "./lib/components/Tabs.svelte";
  import { focusTab } from "./lib/components/tab-navigation.ts";
  import { ControlPanel } from "./lib/state/control-panel.svelte.ts";
  import { PANEL_SECTIONS, type PanelSection } from "./lib/state/panel-sections.ts";
  import { ProgramDraft } from "./lib/state/program-draft.svelte.ts";

  const panel = new ControlPanel();
  const draft = new ProgramDraft();
  /** The panel computes some snapshots only for the section on screen. */
  const activeSection = $derived(panel.visibleSection);

  const SECTION_IDS = { tabIdPrefix: "tab-", panelIdPrefix: "section-" } as const;

  function openSection(key: PanelSection): void {
    panel.visibleSection = key;
    focusTab(SECTION_IDS.tabIdPrefix, key);
  }

  function warnBeforeUnload(event: BeforeUnloadEvent): void {
    if (panel.hasActiveTest) {
      event.preventDefault();
    }
  }

</script>

<svelte:window onbeforeunload={warnBeforeUnload} />

<PanelHeader webSerialAvailable={panel.webSerialAvailable} />

<main class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4">
  <NoticeList {panel} />

  <NodeStrip {panel} />
  <ConnectionGraphView {panel} />
  {#if panel.nodes.selected !== null}
    <SelectedNodeDetail {panel} connection={panel.nodes.selected} />
  {/if}

  <Tabs
    tabs={PANEL_SECTIONS}
    bind:selected={panel.visibleSection}
    {...SECTION_IDS}
    label="Secciones del panel"
  />

  <TabPanels
    tabs={PANEL_SECTIONS}
    selected={activeSection}
    {...SECTION_IDS}
    panels={{
      network: networkSection,
      program: programSection,
      update: updateSection,
      measurements: measurementSection,
      events: eventStreamSection,
    }}
  />
</main>

{#snippet networkSection()}
  <NetworkSection {panel} />
{/snippet}

{#snippet programSection()}
  <ProgramSection {panel} {draft} openUpdate={() => openSection("update")} />
{/snippet}

{#snippet updateSection()}
  <UpdateSection {panel} {draft} openProgram={() => openSection("program")} />
{/snippet}

{#snippet measurementSection()}
  <MeasurementSection {panel} />
{/snippet}

{#snippet eventStreamSection()}
  <EventStreamSection {panel} />
{/snippet}

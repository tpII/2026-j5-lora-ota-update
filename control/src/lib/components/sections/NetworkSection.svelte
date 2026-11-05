<script lang="ts">
  import {
    channelsMatch,
    formatCodingRate,
    frequenciesMatch,
    type RadioSettings,
  } from "$lib/radio/radio-settings.ts";
  import { formatFrequency, formatModulation } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import RadioSettingsForm from "$lib/components/RadioSettingsForm.svelte";
  import RegulatoryChannelNote from "$lib/components/RegulatoryChannelNote.svelte";
  import TargetNodeLine from "$lib/components/TargetNodeLine.svelte";
  import EchoSection from "./EchoSection.svelte";
  import NeighborSection from "./NeighborSection.svelte";

  let { panel }: { panel: ControlPanel } = $props();

  const connection = $derived(panel.selectedIdentifiedConnection);
  const otherConnections = $derived(
    panel.identifiedConnections.filter((other) => other.key !== connection?.key),
  );

  let echoDestination = $state("");
  let echoSection = $state<ReturnType<typeof EchoSection>>();

  /** The channel fields in which `other` differs from `reference`, in the words of the form. */
  function describeChannelDifferences(reference: RadioSettings, other: RadioSettings): string[] {
    const differences: string[] = [];
    if (!frequenciesMatch(reference.freq, other.freq)) {
      differences.push(`frecuencia ${formatFrequency(other.freq)}`);
    }
    if (reference.sf !== other.sf) {
      differences.push(`SF${other.sf}`);
    }
    if (reference.bw !== other.bw) {
      differences.push(`${other.bw} kHz`);
    }
    if (reference.cr !== other.cr) {
      differences.push(`tasa de código ${formatCodingRate(other.cr)}`);
    }
    if (reference.preamble !== other.preamble) {
      differences.push(`preámbulo de ${other.preamble} símbolos`);
    }
    if (reference.sync !== other.sync) {
      differences.push(`palabra de sincronismo ${other.sync}`);
    }
    return differences;
  }

  function prepareEcho(identifier: string): void {
    echoDestination = identifier;
    echoSection?.focusDestination();
  }
</script>

<div class="flex flex-col gap-3">
  <section class="panel-card flex flex-col gap-3" aria-labelledby="network-radio-title">
    <h3 id="network-radio-title" class="panel-section-title">
      {connection === null ? "Radio del nodo elegido" : "Radio de "}<span class="font-mono"
        >{connection?.state.identifier ?? ""}</span
      >
    </h3>
    {#if connection === null}<TargetNodeLine {panel} />{/if}
    <RegulatoryChannelNote />

    {#if connection !== null}
      <!-- Keyed so that edits pending for one node never carry over to the next one chosen. -->
      {#key connection.key}
        <RadioSettingsForm {panel} {connection} />
      {/key}

      <div class="flex flex-col gap-1 border-t border-line pt-3">
        <p class="panel-caption">Canal de los demás nodos</p>
        {#if otherConnections.length === 0}
          <p class="text-sm text-muted">No hay otros nodos conectados e identificados.</p>
        {:else}
          <ul class="flex flex-col gap-1">
            {#each otherConnections as other (other.key)}
              {@const reference = connection.state.radio}
              {@const settings = other.state.radio}
              <li class="flex flex-wrap items-center gap-2 text-sm">
                <span class="font-mono font-semibold">{other.state.identifier}</span>
                <span class="text-xs text-faint">({other.state.model ?? "placa desconocida"})</span>
                {#if reference === null || settings === null}
                  <span class="panel-badge bg-raised text-muted">sin informar</span>
                  <span class="text-xs text-muted">
                    {reference === null ? connection.state.identifier : other.state.identifier} todavía no
                    informó sus parámetros de radio.
                  </span>
                {:else if channelsMatch(reference, settings)}
                  <span class="panel-badge bg-ok/10 text-ok">mismo canal</span>
                {:else}
                  <span class="panel-badge bg-warn/10 text-warn">canal distinto</span>
                  <span class="text-xs text-muted">
                    {describeChannelDifferences(reference, settings).join(", ")}
                    <span class="text-faint">
                      ({formatModulation(settings)} · {formatFrequency(settings.freq)})
                    </span>
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </section>

  <NeighborSection {panel} onEchoRequest={prepareEcho} />

  <EchoSection {panel} bind:this={echoSection} bind:destination={echoDestination} />
</div>

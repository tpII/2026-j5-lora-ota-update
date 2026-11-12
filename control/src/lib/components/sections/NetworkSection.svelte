<script lang="ts">
  import { CHANNEL_FIELDS, settingsMatch } from "$lib/radio/radio-settings.ts";
  import { describeChannelDifferences } from "$lib/radio/radio-settings-form.ts";
  import { formatFrequency, formatModulation } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import { DestinationChoice } from "$lib/state/destination-choice.svelte.ts";
  import RadioSettingsForm from "$lib/components/RadioSettingsForm.svelte";
  import RegulatoryChannelNote from "$lib/components/RegulatoryChannelNote.svelte";
  import TargetNodeLine from "$lib/components/TargetNodeLine.svelte";
  import EchoSection from "./EchoSection.svelte";
  import NeighborSection from "./NeighborSection.svelte";

  let { panel }: { panel: ControlPanel } = $props();

  const connection = $derived(panel.nodes.selectedIdentified);
  const otherConnections = $derived(
    panel.nodes.identified.filter((other) => other.key !== connection?.key),
  );

  const echoDestination = new DestinationChoice();
</script>

<div class="flex flex-col gap-3">
  <section class="panel-card flex flex-col gap-3" aria-labelledby="network-radio-title">
    <h3 id="network-radio-title" class="panel-section-title">
      {connection === null ? "Radio del nodo elegido" : "Radio de "}<span class="font-mono"
        >{connection?.state.identifier ?? ""}</span
      >
    </h3>
    {#if connection === null}<TargetNodeLine target={panel.testTarget()} />{/if}
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
                {:else if settingsMatch(reference, settings, CHANNEL_FIELDS)}
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

  <NeighborSection {panel} echoDestination={echoDestination} />

  <EchoSection {panel} destination={echoDestination} />
</div>

<script lang="ts">
  import ActivationCard from "../ActivationCard.svelte";
  import ImageLoadCard from "../ImageLoadCard.svelte";
  import OperatorKeyCard from "../OperatorKeyCard.svelte";
  import RollbackCard from "../RollbackCard.svelte";
  import TargetNodeLine from "../TargetNodeLine.svelte";
  import UpdateMetricsCard from "../UpdateMetricsCard.svelte";
  import UpdateProgress from "../UpdateProgress.svelte";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  let {
    panel,
    draft,
    openProgram,
  }: {
    panel: ControlPanel;
    draft: ProgramDraft;
    /** Switches the panel to the Programa tab, where the draft is edited. */
    openProgram: () => void;
  } = $props();
</script>

<div class="flex flex-col gap-3">
  <TargetNodeLine target={panel.testTarget()} role="Nodo origen" />

  <OperatorKeyCard update={panel.update} />
  <ImageLoadCard {panel} {draft} {openProgram} />
  <ActivationCard {panel} />
  <UpdateProgress {panel} />
  <RollbackCard {panel} {draft} {openProgram} />
  <UpdateMetricsCard {panel} />
</div>

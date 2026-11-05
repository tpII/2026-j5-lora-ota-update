<script lang="ts">
  import ActivationCard from "../ActivationCard.svelte";
  import ImageLoadCard from "../ImageLoadCard.svelte";
  import OperatorKeyCard from "../OperatorKeyCard.svelte";
  import RollbackCard from "../RollbackCard.svelte";
  import TargetNodeLine from "../TargetNodeLine.svelte";
  import UpdateMetricsCard from "../UpdateMetricsCard.svelte";
  import UpdateProgress from "../UpdateProgress.svelte";
  import { buildLoadImageCommand } from "$lib/console/console-command.ts";
  import {
    checkImageVersion,
    highestAvailableVersion,
    type ImageVersionCheck,
  } from "$lib/image/image-preparation.ts";
  import { ImageSigningSession } from "$lib/state/image-signing-session.svelte.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";
  import type { ProgramDraft } from "$lib/state/program-draft.svelte.ts";

  let {
    panel,
    draft,
    active,
    openProgram,
  }: {
    panel: ControlPanel;
    draft: ProgramDraft;
    active: boolean;
    /** Switches the panel to the Programa tab, where the draft is edited. */
    openProgram: () => void;
  } = $props();

  const session = new ImageSigningSession();

  /** The origin of every action of the section: the node chosen above, when it takes commands. */
  const target = $derived(panel.selectedIdentifiedConnection);
  const graph = $derived(panel.connectionGraph);
  const networkAvailableVersion = $derived(highestAvailableVersion(graph));

  /** How the node chosen and the rest of the graph would take an image of `version`. */
  function checkVersion(version: number): ImageVersionCheck {
    return checkImageVersion(version, {
      targetAvailableVersion: target?.state.availableVersion ?? null,
      networkAvailableVersion,
      nowMilliseconds: panel.now,
    });
  }

  /** Signs `program` with `version` and sends `load_image` to the node chosen. */
  async function signAndLoad(program: Uint8Array, version: number): Promise<string | null> {
    const connection = target;
    if (connection === null || connection.state.identifier === null) {
      return "No hay un nodo conectado e identificado elegido.";
    }
    const node = connection.state.identifier;
    let image: Uint8Array;
    try {
      image = (await session.sign(program, version)).image;
    } catch (error) {
      return `No se pudo firmar la imagen: ${error instanceof Error ? error.message : String(error)}`;
    }
    const result = buildLoadImageCommand(image);
    if (!result.valid) {
      return result.problems.map((problem) => problem.message).join(" ");
    }
    const hostTime = Date.now();
    if (!(await panel.sendCommand(connection.key, result.command))) {
      return "No se pudo enviar la imagen al nodo.";
    }
    session.recordLoad({ key: connection.key, node, version, imageSize: image.length, hostTime });
    return null;
  }
</script>

<div class="flex flex-col gap-3">
  <TargetNodeLine {panel} role="Nodo origen" />

  <OperatorKeyCard {session} {target} />
  <ImageLoadCard {panel} {draft} {session} {target} {checkVersion} {signAndLoad} {openProgram} />
  <ActivationCard {panel} {graph} {target} />
  <UpdateProgress {panel} {graph} />
  <RollbackCard {panel} {draft} {session} {target} {checkVersion} {signAndLoad} {openProgram} />
  <UpdateMetricsCard {panel} {active} />
</div>

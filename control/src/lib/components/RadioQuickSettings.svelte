<script lang="ts">
  import { buildRadioSetCommand } from "$lib/console/console-command.ts";
  import { isRunActive } from "$lib/nodes/node-state.ts";
  import { isQuickOptionCurrent, listQuickRadioGroups, type QuickRadioOption } from "$lib/radio/radio-presets.ts";
  import type { ConnectionView, ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel, connection }: { panel: ControlPanel; connection: ConnectionView } = $props();

  const node = $derived(connection.state);
  const groups = $derived(listQuickRadioGroups(node.model));
  // The node rejects radio changes while a test run is in progress.
  const enabled = $derived(connection.status === "open" && !isRunActive(node));

  function commandFor(option: QuickRadioOption): string | null {
    const result = buildRadioSetCommand(option.changes, node.model);
    return result.valid ? result.command : null;
  }

  async function apply(option: QuickRadioOption): Promise<void> {
    const result = buildRadioSetCommand(option.changes, node.model);
    if (!result.valid) {
      panel.notify("error", result.problems.map((problem) => problem.message).join(" "));
      return;
    }
    if (
      option.warning !== null &&
      !window.confirm(`${option.warning}\n\n¿Enviar «${result.command}» al nodo ${node.identifier}?`)
    ) {
      return;
    }
    await panel.sendCommand(connection.key, result.command);
  }
</script>

<div class="flex flex-col gap-2">
  <h4 class="text-sm font-semibold text-slate-800">Cambios rápidos</h4>
  {#each groups as group (group.label)}
    <div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
      <span class="text-xs font-medium text-slate-600 sm:w-36 sm:shrink-0">{group.label}</span>
      <div class="flex flex-col gap-1">
        <div class="flex flex-wrap gap-1.5" role="group" aria-label={group.label}>
          {#each group.options as option (option.label)}
            <button
              type="button"
              class="panel-choice"
              aria-pressed={isQuickOptionCurrent(option, node.radio)}
              title={commandFor(option)}
              disabled={!enabled || !option.enabled}
              onclick={() => apply(option)}
            >
              {option.label}
            </button>
          {/each}
        </div>
        {#if group.note !== null}
          <p class="panel-hint">{group.note}</p>
        {/if}
      </div>
    </div>
  {/each}
  <p class="panel-hint">
    Cada botón envía al nodo el comando radio con un solo valor; el resaltado es el que el nodo informó. Los anchos de
    125 y 250 kHz piden confirmación.
  </p>
</div>

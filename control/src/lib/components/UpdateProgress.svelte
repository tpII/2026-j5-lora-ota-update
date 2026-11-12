<script lang="ts">
  import { GRAPH_NODE_SOURCE_LABELS, hasVirtualMachineTrouble } from "$lib/node-session/connection-graph.ts";
  import {
    describeHearing,
    describeLastHeard,
    describeVirtualMachine,
  } from "$lib/node-session/connection-graph-descriptions.ts";
  import { hasActivationPending } from "$lib/update/activation.ts";
  import { buildTransferActivity, describeImageReception } from "$lib/update/transfer-activity.ts";
  import { formatImageVersion, formatShortClockTime } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  const graph = $derived(panel.connectionGraph);

  const MAXIMUM_ACTIVITY_ROWS = 15;

  const states = $derived(
    new Map(panel.nodes.identified.map((connection) => [connection.state.identifier, connection.state])),
  );

  const activity = $derived(buildTransferActivity(states, MAXIMUM_ACTIVITY_ROWS));
</script>

<div class="panel-card flex flex-col gap-3">
  <h3 class="panel-section-title">Estado de la actualización</h3>
  <p class="panel-hint">
    Un nodo que solo aparece en la lista de vecinos de otro bloquea la activación hasta que un nodo conectado escuche
    su HELLO. Las imágenes viven solo en la RAM: un nodo que se reinicia vuelve a la versión 0 y recibe de sus
    vecinos la imagen disponible.
  </p>

  {#if graph.nodes.length === 0}
    <p class="text-sm text-muted">El grafo todavía no tiene nodos.</p>
  {:else}
    <div class="overflow-x-auto">
      <table class="panel-table">
        <thead>
          <tr>
            <th>Nodo</th>
            <th>Placa</th>
            <th>Fuente</th>
            <th>Versión activa</th>
            <th>Versión disponible</th>
            <th>Recepción en curso</th>
            <th>VM</th>
            <th>Último dato</th>
          </tr>
        </thead>
        <tbody>
          {#each graph.nodes as node (node.id)}
            {@const state = states.get(node.id)}
            {@const pending = hasActivationPending(node)}
            <tr>
              <td class="font-mono font-semibold">
                {node.id}
              </td>
              <td>{node.model ?? "—"}</td>
              <td class="text-xs text-muted">{GRAPH_NODE_SOURCE_LABELS[node.source]}</td>
              <td class="font-mono">{formatImageVersion(node.activeVersion)}</td>
              <td class="font-mono">
                {formatImageVersion(node.availableVersion)}
                {#if pending}<span class="panel-badge ml-1 bg-warn/10 font-sans text-warn">sin activar</span>{/if}
              </td>
              <td class="text-xs">{node.connected && state !== undefined ? describeImageReception(state) : "—"}</td>
              <td class="text-xs {hasVirtualMachineTrouble(node) ? 'text-danger' : ''}">
                {describeVirtualMachine(node)}
              </td>
              <td class="text-xs whitespace-nowrap text-muted">{describeLastHeard(node, panel.now)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if graph.links.length > 0}
    <div class="overflow-x-auto">
      <table class="panel-table">
        <thead>
          <tr>
            <th>Enlace</th>
            <th>Cómo escucha el primero al segundo</th>
            <th>Cómo escucha el segundo al primero</th>
          </tr>
        </thead>
        <tbody>
          {#each graph.links as link (`${link.first}:${link.second}`)}
            <tr>
              <td class="font-mono font-semibold whitespace-nowrap">{link.first} – {link.second}</td>
              <td class="whitespace-nowrap">{describeHearing(link.firstHearsSecond)}</td>
              <td class="whitespace-nowrap">{describeHearing(link.secondHearsFirst)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="flex flex-col gap-2">
    <h4 class="panel-caption">Actividad de la transferencia en los nodos conectados</h4>
    {#if activity.length === 0}
      <p class="text-sm text-muted">Todavía no hay ráfagas, reportes ni imágenes.</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="panel-table">
          <thead>
            <tr>
              <th>Hora</th>
              <th>Nodo</th>
              <th>Hecho</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {#each activity as row (row.key)}
              <tr>
                <td class="font-mono text-xs">{formatShortClockTime(row.hostTime)}</td>
                <td class="font-mono">{row.node}</td>
                <td class="whitespace-nowrap">{row.kind}</td>
                <td class="text-xs">{row.detail}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>

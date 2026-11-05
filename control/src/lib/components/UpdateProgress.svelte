<script lang="ts">
  import type { ConnectionGraph, GraphNode, LinkQuality } from "$lib/nodes/connection-graph.ts";
  import { imageReceptionFraction, type NodeState } from "$lib/nodes/node-state.ts";
  import {
    formatDuration,
    formatImageVersion,
    formatNumber,
    formatRssi,
    formatShortClockTime,
    formatSnr,
  } from "$lib/utils/format.ts";
  import {
    ACTIVATION_CAUSE_LABELS,
    BURST_CAUSE_LABELS,
    GRAPH_NODE_SOURCE_LABELS,
    IMAGE_REJECTION_LABELS,
    VM_FAULT_LABELS,
  } from "$lib/utils/labels.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel, graph }: { panel: ControlPanel; graph: ConnectionGraph } = $props();

  const MAXIMUM_ACTIVITY_ROWS = 15;

  interface ActivityRow {
    readonly key: string;
    readonly hostTime: number;
    readonly node: string;
    readonly kind: string;
    readonly detail: string;
  }

  /** Console state of each connected node, by identifier. */
  const states = $derived(
    new Map(
      panel.connections
        .filter((connection) => connection.status === "open" && connection.state.identifier !== null)
        .map((connection) => [connection.state.identifier ?? "", connection.state]),
    ),
  );

  function describeReception(state: NodeState | undefined): string {
    if (state === undefined) {
      return "—";
    }
    const reception = state.imageReception;
    const transfer = state.transfer;
    if (reception !== null) {
      const percent = Math.round(100 * imageReceptionFraction(reception));
      const missing =
        transfer !== null && transfer.receivingVersion === reception.version && transfer.missingBytes !== null
          ? `, faltan ${formatNumber(transfer.missingBytes)} bytes`
          : "";
      return `${reception.version}: ${reception.heldFragments.length} de ${reception.fragmentCount} fragmentos de ${reception.fragmentSize} bytes (${percent} %)${missing}`;
    }
    if (transfer !== null && transfer.receivingVersion !== null) {
      return `${transfer.receivingVersion}: faltan ${formatNumber(transfer.missingBytes)} bytes`;
    }
    return "ninguna";
  }

  function describeMachine(node: GraphNode): string {
    const fault = node.vmFault === null ? "sin fallas desde la activación" : `última falla: ${VM_FAULT_LABELS[node.vmFault]}`;
    return node.vmFailing === true ? `${fault}; el último tick terminó en falla` : fault;
  }

  function describeHearing(quality: LinkQuality | null): string {
    return quality === null ? "—" : `${formatRssi(quality.rssi)} · ${formatSnr(quality.snr)}`;
  }

  /** Bursts, reports, images and activations of the connected nodes, newest first. */
  const activity = $derived.by(() => {
    const rows: ActivityRow[] = [];
    for (const [id, state] of states) {
      for (const [index, burst] of state.bursts.entries()) {
        const sent = burst.completion === null ? `${burst.transmitted} enviados hasta ahora` : `${burst.completion.sent} enviados`;
        rows.push({
          key: `${id}:burst:${index}`,
          hostTime: burst.startHostTime,
          node: id,
          kind: "Ráfaga",
          detail:
            `${burst.version}: ${burst.count} fragmentos de ${burst.fragmentSize} bytes, ${sent}; ` +
            `${BURST_CAUSE_LABELS[burst.cause]}${burst.trigger === null ? "" : ` (${burst.trigger})`}`,
        });
      }
      for (const [index, report] of state.reportsReceived.entries()) {
        rows.push({
          key: `${id}:report:${index}`,
          hostTime: report.hostTime,
          node: id,
          kind: "Reporte recibido",
          detail: `de ${report.peer}, versión ${report.version}: faltan ${report.missing.length} de ${report.fragmentCount} fragmentos (${report.missing.join(", ")})`,
        });
      }
      const reception = state.imageReception;
      if (reception?.lastReport != null) {
        const report = reception.lastReport;
        rows.push({
          key: `${id}:sent:${report.hostTime}`,
          hostTime: report.hostTime,
          node: id,
          kind: "Reporte enviado",
          detail: `a ${report.peer}, versión ${report.version}, ronda ${report.round ?? "—"}: faltan ${report.missing.length} de ${report.fragmentCount} fragmentos`,
        });
      }
      for (const [index, image] of state.images.entries()) {
        rows.push({
          key: `${id}:image:${index}`,
          hostTime: image.hostTime,
          node: id,
          kind: "Imagen disponible",
          detail:
            image.via === "console"
              ? `${image.version}, cargada por la consola (${formatNumber(image.imageSize)} bytes)`
              : `${image.version}, completada por la radio desde ${image.source ?? "—"}: ${image.fragments} fragmentos, ${image.reports} reportes, ${formatNumber(image.durationMilliseconds)} ms`,
        });
      }
      for (const [index, rejection] of state.imageRejections.entries()) {
        rows.push({
          key: `${id}:rejection:${index}`,
          hostTime: rejection.hostTime,
          node: id,
          kind: "Imagen rechazada",
          detail: `${rejection.version} desde ${rejection.source}: ${IMAGE_REJECTION_LABELS[rejection.reason]}`,
        });
      }
      for (const [index, activation] of state.activations.entries()) {
        rows.push({
          key: `${id}:activation:${index}`,
          hostTime: activation.hostTime,
          node: id,
          kind: "Activación",
          detail:
            `${activation.version} (antes ${formatImageVersion(activation.previous)}): ` +
            `${ACTIVATION_CAUSE_LABELS[activation.cause]}${activation.source === null ? "" : ` (${activation.source})`}`,
        });
      }
    }
    return rows.sort((first, second) => second.hostTime - first.hostTime).slice(0, MAXIMUM_ACTIVITY_ROWS);
  });
</script>

<div class="panel-card flex flex-col gap-3">
  <h3 class="panel-section-title">Estado de la actualización</h3>
  <p class="panel-hint">
    Los nodos conectados informan sus versiones por la consola; de los demás, el panel sabe lo que anuncian sus
    HELLO a los nodos conectados. Un nodo que solo aparece en la lista de vecinos de otro no tiene versiones
    conocidas y bloquea la activación hasta que algún nodo conectado lo escuche. La recepción en curso solo se conoce
    en los nodos conectados.
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
            {@const pending = node.availableVersion !== null && node.activeVersion !== null && node.availableVersion > node.activeVersion}
            <tr>
              <td class="font-mono font-semibold">
                {node.id}
                {#if node.connected}<span class="panel-badge ml-1 bg-neon/10 font-sans text-neon">conectado</span>{/if}
              </td>
              <td>{node.model ?? "—"}</td>
              <td class="text-xs text-muted">{GRAPH_NODE_SOURCE_LABELS[node.source]}</td>
              <td class="font-mono">{formatImageVersion(node.activeVersion)}</td>
              <td class="font-mono">
                {formatImageVersion(node.availableVersion)}
                {#if pending}<span class="panel-badge ml-1 bg-warn/10 font-sans text-warn">sin activar</span>{/if}
              </td>
              <td class="text-xs">{node.connected ? describeReception(state) : "—"}</td>
              <td class="text-xs {node.vmFault !== null || node.vmFailing === true ? 'text-danger' : ''}">
                {node.source === "neighbor_list" ? "—" : describeMachine(node)}
              </td>
              <td class="text-xs whitespace-nowrap text-muted">
                {node.connected
                  ? "consola abierta"
                  : node.lastHeardHostTime === null
                    ? "—"
                    : `hace ${formatDuration(panel.now - node.lastHeardHostTime)}`}
              </td>
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
    <h4 class="text-sm font-semibold">Actividad de la transferencia en los nodos conectados</h4>
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

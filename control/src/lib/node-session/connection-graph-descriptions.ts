/**
 * How the panel writes, in Spanish, what the connection graph knows about a node and a link: the
 * graph tooltips and the tables of the update section use the same words.
 */
import { formatDuration, formatRssi, formatSnr } from "$lib/utils/format.ts";
import { VM_FAULT_LABELS } from "$lib/vm/fault-descriptions.ts";
import type { GraphNode, LinkQuality } from "./connection-graph.ts";

/** The VM of a node: its last fault since the activation and whether its last tick failed. */
export function describeVirtualMachine(node: GraphNode): string {
  // Only the neighbor list of another node names it, and that list carries no VM state.
  if (node.source === "neighbor_list") {
    return "—";
  }
  // Short enough for one line of the graph tooltip when the VM has not failed.
  const fault =
    node.vmFault === null ? "sin fallas" : `última falla: ${VM_FAULT_LABELS[node.vmFault]}`;
  return node.vmFailing === true ? `${fault}; el último tick falló` : fault;
}

/** How one end of a link hears the other: "-71,5 dBm · 6,25 dB". */
export function describeHearing(quality: LinkQuality | null): string {
  return quality === null ? "sin datos" : `${formatRssi(quality.rssi)} · ${formatSnr(quality.snr)}`;
}

/** Since when the panel knows nothing newer about a node, at host time `now`. */
export function describeLastHeard(node: GraphNode, now: number): string {
  if (node.connected) {
    return "consola abierta";
  }
  return node.lastHeardHostTime === null
    ? "—"
    : `hace ${formatDuration(now - node.lastHeardHostTime)}`;
}

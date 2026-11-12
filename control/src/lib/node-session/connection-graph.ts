/**
 * Connection graph (es: grafo de conexiones): the nodes of the network and the links between
 * neighbors, with how each end hears the other, as the panel assembles them from the HELLO and
 * `neighbor` events of every connected node. Only the panel holds it; each node knows only its own
 * neighbors. The update feature reads the versions it announces (update/activation.ts).
 */
import type { BoardModel, NodeIdentifier } from "$lib/console/console-event.ts";
import type { VmFault } from "$lib/vm/virtual-machine.ts";
import { isNeighborExpired, type NeighborRecord } from "$lib/nodes/neighbor-table.ts";
import type { NodeState } from "./node-state.ts";

/**
 * Where the panel learned the versions of a node: its own console, a HELLO or `neighbor` event
 * heard by a connected node, or only the neighbor list of another node's HELLO, which carries no
 * versions.
 */
export type GraphNodeSource = "console" | "neighbor" | "neighbor_list";

export const GRAPH_NODE_SOURCE_LABELS: { readonly [Source in GraphNodeSource]: string } = {
  console: "consola",
  neighbor: "HELLO de un vecino",
  neighbor_list: "lista de vecinos de otro nodo",
};

export interface GraphNode {
  readonly id: NodeIdentifier;
  readonly model: BoardModel | null;
  /** True when the panel has a console open with the node. */
  readonly connected: boolean;
  readonly source: GraphNodeSource;
  /** Null when unknown. */
  readonly activeVersion: number | null;
  /** Null when unknown. */
  readonly availableVersion: number | null;
  /** Last VM fault since the activation; null when there was none or it is unknown. */
  readonly vmFault: VmFault | null;
  /** Null when unknown. */
  readonly vmFailing: boolean | null;
  /** Host time of the freshest information about the node; null for a connected node. */
  readonly lastHeardHostTime: number | null;
}

/** How one end of a link hears the other, from its neighbor table or its HELLO. */
export interface LinkQuality {
  readonly rssi: number;
  readonly snr: number;
  /** Host time at which the panel learned it. */
  readonly hostTime: number;
}

/** A link between two neighbors; `first` sorts before `second`. */
export interface GraphLink {
  readonly first: NodeIdentifier;
  readonly second: NodeIdentifier;
  /** Null when the panel does not know how `first` hears `second`. */
  readonly firstHearsSecond: LinkQuality | null;
  readonly secondHearsFirst: LinkQuality | null;
}

export interface ConnectionGraph {
  /** Sorted by identifier. */
  readonly nodes: readonly GraphNode[];
  /** Sorted by `first`, then `second`. */
  readonly links: readonly GraphLink[];
}

/**
 * True when the VM of a node failed since its activation or since its last HELLO, as a graph node or a
 * neighbor record tells it.
 */
export function hasVirtualMachineTrouble(node: {
  readonly vmFault: VmFault | null;
  readonly vmFailing: boolean | null;
}): boolean {
  return node.vmFault !== null || node.vmFailing === true;
}

export function graphLinkKey(link: GraphLink): string {
  return linkKey(link.first, link.second);
}

/** The weaker direction of a link, which limits it; null when neither end reported it. */
export function weakerRssi(link: GraphLink): number | null {
  const values = [link.firstHearsSecond?.rssi, link.secondHearsFirst?.rssi].filter(
    (value): value is number => value !== undefined,
  );
  return values.length === 0 ? null : Math.min(...values);
}

interface NodeAccumulator {
  model: BoardModel | null;
  connected: boolean;
  source: GraphNodeSource;
  activeVersion: number | null;
  availableVersion: number | null;
  vmFault: VmFault | null;
  vmFailing: boolean | null;
  lastHeardHostTime: number | null;
}

const SOURCE_RANK: { readonly [Source in GraphNodeSource]: number } = {
  neighbor_list: 0,
  neighbor: 1,
  console: 2,
};

function linkKey(first: NodeIdentifier, second: NodeIdentifier): string {
  return `${first}:${second}`;
}

/** Keeps the freshest quality of each direction, keyed by "listener:speaker". */
function recordHearing(
  hearings: Map<string, LinkQuality>,
  listener: NodeIdentifier,
  speaker: NodeIdentifier,
  quality: LinkQuality,
): void {
  const key = linkKey(listener, speaker);
  const previous = hearings.get(key);
  if (previous === undefined || previous.hostTime <= quality.hostTime) {
    hearings.set(key, quality);
  }
}

function mergeNeighbor(
  nodes: Map<NodeIdentifier, NodeAccumulator>,
  neighbor: NeighborRecord,
): void {
  const previous = nodes.get(neighbor.id);
  if (previous !== undefined && SOURCE_RANK[previous.source] > SOURCE_RANK.neighbor) {
    previous.model ??= neighbor.model;
    return;
  }
  if (
    previous !== undefined &&
    previous.source === "neighbor" &&
    (previous.lastHeardHostTime ?? 0) > neighbor.lastHeardHostTime
  ) {
    return;
  }
  nodes.set(neighbor.id, {
    model: neighbor.model,
    connected: false,
    source: "neighbor",
    activeVersion: neighbor.version,
    availableVersion: neighbor.availableVersion,
    vmFault: neighbor.vmFault,
    vmFailing: neighbor.vmFailing,
    lastHeardHostTime: neighbor.lastHeardHostTime,
  });
}

function addListedNode(nodes: Map<NodeIdentifier, NodeAccumulator>, id: NodeIdentifier): void {
  if (!nodes.has(id)) {
    nodes.set(id, {
      model: null,
      connected: false,
      source: "neighbor_list",
      activeVersion: null,
      availableVersion: null,
      vmFault: null,
      vmFailing: null,
      lastHeardHostTime: null,
    });
  }
}

/**
 * Builds the graph from the states of the connected nodes at host time `now`. Neighbors that the
 * node would have dropped from its table (NEIGHBOR_EXPIRY_MILLISECONDS without packets) are left
 * out, with the links and the nodes they alone brought in.
 */
export function buildConnectionGraph(
  connectedStates: readonly NodeState[],
  now: number,
): ConnectionGraph {
  const nodes = new Map<NodeIdentifier, NodeAccumulator>();
  const hearings = new Map<string, LinkQuality>();
  const identified = connectedStates.filter(
    (state): state is NodeState & { identifier: NodeIdentifier } => state.identifier !== null,
  );
  for (const state of identified) {
    nodes.set(state.identifier, {
      model: state.model,
      connected: true,
      source: "console",
      activeVersion: state.activeVersion,
      availableVersion: state.availableVersion,
      vmFault: state.faultSinceActivation,
      // The node does not report on its console whether it faulted since its last HELLO.
      vmFailing: null,
      lastHeardHostTime: null,
    });
  }
  for (const state of identified) {
    for (const neighbor of state.neighbors) {
      if (isNeighborExpired(neighbor, now) || neighbor.id === state.identifier) {
        continue;
      }
      mergeNeighbor(nodes, neighbor);
      recordHearing(hearings, state.identifier, neighbor.id, {
        rssi: neighbor.rssi,
        snr: neighbor.snr,
        hostTime: neighbor.lastHeardHostTime,
      });
      for (const report of neighbor.reportedNeighbors ?? []) {
        if (report.id === neighbor.id) {
          continue;
        }
        addListedNode(nodes, report.id);
        recordHearing(hearings, neighbor.id, report.id, {
          rssi: report.rssi,
          snr: report.snr,
          hostTime: neighbor.lastHeardHostTime,
        });
      }
    }
  }
  const links = new Map<string, GraphLink>();
  for (const key of hearings.keys()) {
    const [listener = "", speaker = ""] = key.split(":");
    const [first, second] = listener < speaker ? [listener, speaker] : [speaker, listener];
    if (links.has(linkKey(first, second))) {
      continue;
    }
    links.set(linkKey(first, second), {
      first,
      second,
      firstHearsSecond: hearings.get(linkKey(first, second)) ?? null,
      secondHearsFirst: hearings.get(linkKey(second, first)) ?? null,
    });
  }
  return {
    nodes: [...nodes.entries()]
      .map(([id, node]) => ({ id, ...node }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    links: [...links.values()].sort(
      (left, right) =>
        left.first.localeCompare(right.first) || left.second.localeCompare(right.second),
    ),
  };
}

/** Highest available version that some node of the graph announces; null when none is known. */
export function highestAvailableVersion(graph: ConnectionGraph): number | null {
  let highest: number | null = null;
  for (const node of graph.nodes) {
    if (node.availableVersion !== null) {
      highest = highest === null ? node.availableVersion : Math.max(highest, node.availableVersion);
    }
  }
  return highest;
}

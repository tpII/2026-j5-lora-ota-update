/**
 * Connection graph (es: grafo de conexiones): the nodes of the network and the links between
 * neighbors, with how each end hears the other, as the panel assembles them from the HELLO and
 * `neighbor` events of every connected node. Only the panel holds it; each node knows only its own
 * neighbors. The panel also uses it to enable the activation order (ADR 0011).
 */
import type { BoardModel, NodeIdentifier } from "$lib/console/console-event.ts";
import type { VmFault } from "$lib/vm/virtual-machine.ts";
import { isNeighborExpired, type NeighborRecord, type NodeState } from "./node-state.ts";

/**
 * Where the panel learned the versions of a node: its own console, a HELLO or `neighbor` event
 * heard by a connected node, or only the neighbor list of another node's HELLO, which carries no
 * versions.
 */
export type GraphNodeSource = "console" | "neighbor" | "neighbor_list";

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

/** Why a node keeps the activation order disabled. */
export type ActivationBlockReason =
  /** The panel does not know its available version. */
  | "unknown"
  /** It does not hold the image of the version yet. */
  | "missing"
  /** It holds a newer version, so it cannot activate this one. */
  | "newer";

export interface ActivationBlocker {
  readonly id: NodeIdentifier;
  readonly reason: ActivationBlockReason;
  readonly availableVersion: number | null;
}

export interface ActivationReadiness {
  readonly version: number;
  /** True only if the graph has nodes and every one announces `version` as available. */
  readonly ready: boolean;
  /** Nodes that keep the order disabled, sorted by identifier. */
  readonly blockers: readonly ActivationBlocker[];
  /** Nodes that already run `version`. */
  readonly activeCount: number;
  readonly nodeCount: number;
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
 * node would have dropped from its table (60 s without packets) are left out, with the links and
 * the nodes they alone brought in.
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
      // The node does not report on its console whether its last tick failed.
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

/**
 * Whether the operator may order the activation of `version`: only when every node of the graph
 * announces it as its available version. A node whose version is unknown keeps the order
 * disabled, and so does an empty graph.
 */
export function activationReadiness(graph: ConnectionGraph, version: number): ActivationReadiness {
  const blockers: ActivationBlocker[] = [];
  for (const node of graph.nodes) {
    const available = node.availableVersion;
    if (available === null) {
      blockers.push({ id: node.id, reason: "unknown", availableVersion: null });
    } else if (available < version) {
      blockers.push({ id: node.id, reason: "missing", availableVersion: available });
    } else if (available > version) {
      blockers.push({ id: node.id, reason: "newer", availableVersion: available });
    }
  }
  return {
    version,
    ready: graph.nodes.length > 0 && blockers.length === 0,
    blockers,
    activeCount: graph.nodes.filter((node) => node.activeVersion === version).length,
    nodeCount: graph.nodes.length,
  };
}

/**
 * The highest available version that some node of the graph announces and that is newer than its
 * active version somewhere: the version an activation would order. Null when there is none.
 */
export function pendingActivationVersion(graph: ConnectionGraph): number | null {
  let pending: number | null = null;
  for (const node of graph.nodes) {
    const { activeVersion, availableVersion } = node;
    if (availableVersion !== null && (activeVersion === null || availableVersion > activeVersion)) {
      pending = pending === null ? availableVersion : Math.max(pending, availableVersion);
    }
  }
  return pending;
}

/**
 * The activation order of an update (ADR 0011): when the panel enables it, from the versions the
 * connection graph announces, why the node chosen would refuse it and what a forced activation
 * leaves behind.
 */
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import { isImageVersion } from "$lib/image/image-format.ts";
import type { ConnectionGraph, GraphNode } from "$lib/node-session/connection-graph.ts";
import type { NodeState } from "$lib/node-session/node-state.ts";
import { MAXIMUM_IMAGE_VERSION, MINIMUM_IMAGE_VERSION } from "$lib/protocol/protocol-contract.ts";
import { formatImageVersion, formatLimit } from "$lib/utils/format.ts";

/**
 * True when a node holds a newer version than the one it executes, waiting for activation. A node
 * whose active or available version is unknown has none.
 */
export function hasActivationPending(
  node: GraphNode,
): node is GraphNode & { readonly availableVersion: number; readonly activeVersion: number } {
  return (
    node.availableVersion !== null &&
    node.activeVersion !== null &&
    node.availableVersion > node.activeVersion
  );
}

/** Why a node keeps the activation order disabled. */
export type ActivationBlockReason =
  /** The panel does not know its available version. */
  | "unknown"
  /** It does not hold the image of the version yet. */
  | "missing"
  /** It holds a newer version, so it cannot activate this one. */
  | "newer";

export const ACTIVATION_BLOCK_REASON_LABELS: {
  readonly [Reason in ActivationBlockReason]: string;
} = {
  unknown: "no se conoce su versión disponible",
  missing: "todavía no tiene la imagen",
  newer: "tiene disponible una versión mayor",
};

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
    if (hasActivationPending(node)) {
      pending = Math.max(pending ?? 0, node.availableVersion);
    }
  }
  return pending;
}

/** Why a version cannot be activated anywhere: it is not an image version. */
export const ACTIVATION_VERSION_RANGE_PROBLEM = `La versión es un entero de ${formatLimit(MINIMUM_IMAGE_VERSION)} a ${formatLimit(MAXIMUM_IMAGE_VERSION)}.`;

/**
 * Why the node of `state` would answer `activate <version>` with an error, in Spanish; null when it
 * would accept it. It mirrors the checks of `activate` in
 * firmware/src/application/console_commands.cpp (`not_available`, then `version_not_newer`), and
 * must change with them; it also names the version the node already runs.
 */
export function activationProblem(
  state: NodeState & { readonly identifier: NodeIdentifier },
  version: number,
): string | null {
  if (!isImageVersion(version)) {
    return ACTIVATION_VERSION_RANGE_PROBLEM;
  }
  if (state.activeVersion === version) {
    return `${state.identifier} ya ejecuta la versión ${version}.`;
  }
  if (state.availableVersion !== version) {
    return `${state.identifier} tiene disponible la versión ${formatImageVersion(state.availableVersion)}: solo puede activar esa.`;
  }
  if (state.activeVersion !== null && version <= state.activeVersion) {
    return `La versión no es mayor que la activa de ${state.identifier}.`;
  }
  return null;
}

/**
 * The confirmation a forced activation asks for, in Spanish: what each node that blocks the order
 * will do, grouped by the reason it blocks it.
 */
export function describeForcedActivation(readiness: ActivationReadiness): string {
  const { version } = readiness;
  const blockersWith = (reason: ActivationBlockReason) =>
    readiness.blockers.filter((blocker) => blocker.reason === reason);
  const missing = blockersWith("missing").map((blocker) => blocker.id);
  const newer = blockersWith("newer").map(
    (blocker) => `${blocker.id} (versión ${formatImageVersion(blocker.availableVersion)})`,
  );
  const unknown = blockersWith("unknown").map((blocker) => blocker.id);
  const sentences = [`Activación forzada de la versión ${version}.`];
  if (missing.length > 0) {
    sentences.push(
      (missing.length === 1
        ? `Este nodo todavía no la tiene disponible: ${missing[0]}. La activa recién `
        : `Estos nodos todavía no la tienen disponible: ${missing.join(", ")}. Cada uno la activa recién `) +
        "cuando complete la imagen y escuche a un vecino que la anuncie como activa; mientras tanto " +
        "ejecuta su programa activo.",
    );
  }
  if (newer.length > 0) {
    sentences.push(
      newer.length === 1
        ? `Este nodo tiene disponible una versión mayor: ${newer[0]}. Nunca va a recibir ni ` +
            `activar la versión ${version} y sigue con su programa activo; para unificar la red hay ` +
            "que cargar una imagen con una versión mayor que la suya."
        : `Estos nodos tienen disponible una versión mayor: ${newer.join(", ")}. Nunca van a recibir ni ` +
            `activar la versión ${version} y siguen con su programa activo; para unificar la red hay ` +
            "que cargar una imagen con una versión mayor que la de ellos.",
    );
  }
  if (unknown.length > 0) {
    sentences.push(
      unknown.length === 1
        ? `De este nodo no se conoce la versión disponible: ${unknown[0]}. Puede activarla más ` +
            "adelante o nunca, si ya tiene una versión mayor."
        : `De estos nodos no se conoce la versión disponible: ${unknown.join(", ")}. Pueden activarla más ` +
            "adelante o nunca, si ya tienen una versión mayor.",
    );
  }
  sentences.push("¿Forzar la activación?");
  return sentences.join(" ");
}

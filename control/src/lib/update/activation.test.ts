import { describe, expect, it } from "vite-plus/test";
import {
  RECEIVER_BOOT_HOST_TIME,
  SENDER_BOOT_HOST_TIME,
  UPDATE_ORIGIN_LOG,
  UPDATE_RECEIVER_LOG,
  UPDATE_VERSION,
  readFixtureEvents,
  type TimedConsoleEvent,
} from "$lib/testing/console-fixtures.ts";
import { buildConnectionGraph, type ConnectionGraph } from "$lib/node-session/connection-graph.ts";
import {
  INITIAL_NODE_STATE,
  applyConsoleEvent,
  type NodeState,
} from "$lib/node-session/node-state.ts";
import {
  activationProblem,
  activationReadiness,
  describeForcedActivation,
  hasActivationPending,
  pendingActivationVersion,
} from "./activation.ts";

function replayUntil(events: readonly TimedConsoleEvent[], hostTime: number): NodeState {
  return events
    .filter((entry) => entry.hostTime <= hostTime)
    .reduce(
      (state, { event, hostTime: time }) => applyConsoleEvent(state, event, time),
      INITIAL_NODE_STATE,
    );
}

const originEvents = readFixtureEvents(UPDATE_ORIGIN_LOG, SENDER_BOOT_HOST_TIME);
const receiverEvents = readFixtureEvents(UPDATE_RECEIVER_LOG, RECEIVER_BOOT_HOST_TIME);

/** The update of the fixtures, `relativeTime` milliseconds after node 5C21 booted. */
function graphAt(relativeTime: number): ConnectionGraph {
  const hostTime = SENDER_BOOT_HOST_TIME + relativeTime;
  return buildConnectionGraph(
    [replayUntil(originEvents, hostTime), replayUntil(receiverEvents, hostTime)],
    hostTime,
  );
}

function originAt(relativeTime: number): NodeState & { readonly identifier: string } {
  const state = replayUntil(originEvents, SENDER_BOOT_HOST_TIME + relativeTime);
  return { ...state, identifier: state.identifier ?? "" };
}

describe("activationReadiness", () => {
  it("blocks the order until every node holds the version", () => {
    const loading = activationReadiness(graphAt(50_100), UPDATE_VERSION);
    expect(loading).toMatchObject({
      ready: false,
      blockers: [{ id: "3A7F", reason: "missing", availableVersion: 0 }],
      activeCount: 0,
      nodeCount: 2,
    });
    expect(activationReadiness(graphAt(60_000), UPDATE_VERSION)).toMatchObject({
      ready: true,
      blockers: [],
    });
    expect(activationReadiness(graphAt(70_100), UPDATE_VERSION)).toMatchObject({
      ready: true,
      activeCount: 2,
    });
  });

  it("blocks an older version once a newer one is available", () => {
    expect(activationReadiness(graphAt(60_000), UPDATE_VERSION - 1).blockers).toEqual([
      { id: "3A7F", reason: "newer", availableVersion: UPDATE_VERSION },
      { id: "5C21", reason: "newer", availableVersion: UPDATE_VERSION },
    ]);
  });

  it("blocks the order while the version of a node is unknown", () => {
    const graph = graphAt(60_000);
    const withUnknown: ConnectionGraph = {
      ...graph,
      nodes: [...graph.nodes, { ...graph.nodes[0]!, id: "9B04", availableVersion: null }],
    };
    expect(activationReadiness(withUnknown, UPDATE_VERSION)).toMatchObject({
      ready: false,
      blockers: [{ id: "9B04", reason: "unknown", availableVersion: null }],
    });
  });

  it("is never ready on an empty graph", () => {
    expect(activationReadiness({ nodes: [], links: [] }, 1)).toMatchObject({
      ready: false,
      blockers: [],
    });
  });
});

describe("pendingActivationVersion", () => {
  it("names the available version that waits for the order", () => {
    expect(pendingActivationVersion(graphAt(47_000))).toBeNull();
    expect(pendingActivationVersion(graphAt(60_000))).toBe(UPDATE_VERSION);
    expect(pendingActivationVersion(graphAt(70_100))).toBeNull();
  });

  it("finds no pending activation on a node whose active version is unknown", () => {
    const graph = graphAt(60_000);
    const unknownActive: ConnectionGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, activeVersion: null })),
    };
    expect(unknownActive.nodes.some(hasActivationPending)).toBe(false);
    expect(pendingActivationVersion(unknownActive)).toBeNull();
  });
});

describe("activationProblem", () => {
  it("refuses what the firmware refuses, as `activate` checks it", () => {
    expect(activationProblem(originAt(47_000), UPDATE_VERSION)).toBe(
      "5C21 tiene disponible la versión 0 (fábrica): solo puede activar esa.",
    );
    expect(activationProblem(originAt(60_000), UPDATE_VERSION)).toBeNull();
    expect(activationProblem(originAt(60_000), UPDATE_VERSION + 1)).toBe(
      "5C21 tiene disponible la versión 1762300800: solo puede activar esa.",
    );
    expect(activationProblem(originAt(80_000), UPDATE_VERSION)).toBe(
      "5C21 ya ejecuta la versión 1762300800.",
    );
    expect(activationProblem(originAt(60_000), 0)).toBe(
      "La versión es un entero de 1 a 4.294.967.295.",
    );
  });
});

describe("describeForcedActivation", () => {
  it("says what each node that blocks the order will do", () => {
    expect(
      describeForcedActivation({
        version: 9,
        ready: false,
        blockers: [
          { id: "3A7F", reason: "missing", availableVersion: 0 },
          { id: "5C21", reason: "newer", availableVersion: 12 },
          { id: "7D10", reason: "newer", availableVersion: 10 },
          { id: "9B04", reason: "unknown", availableVersion: null },
        ],
        activeCount: 0,
        nodeCount: 4,
      }),
    ).toBe(
      "Activación forzada de la versión 9. " +
        "Este nodo todavía no la tiene disponible: 3A7F. La activa recién cuando complete la imagen y " +
        "escuche a un vecino que la anuncie como activa; mientras tanto ejecuta su programa activo. " +
        "Estos nodos tienen disponible una versión mayor: 5C21 (versión 12), 7D10 (versión 10). Nunca " +
        "van a recibir ni activar la versión 9 y siguen con su programa activo; para unificar la red hay " +
        "que cargar una imagen con una versión mayor que la de ellos. " +
        "De este nodo no se conoce la versión disponible: 9B04. Puede activarla más adelante o nunca, si " +
        "ya tiene una versión mayor. ¿Forzar la activación?",
    );
  });
});

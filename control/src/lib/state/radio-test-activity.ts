/**
 * The radio tests in progress and the rule that says whether a test, or a change of radio
 * settings, may start now. Every `start` method of the panel and every button that starts a test or
 * changes the radio of a node asks `findRefusal`.
 *
 * The rule, with the reason behind each part:
 * - One radio test at a time in the panel: capacity test, echo series (a single echo too),
 *   communication test, receiver mode or manual run of the power sweep. The nodes share the air,
 *   so a second test on any node disturbs the packets the first one counts.
 * - The radio settings of a node that a test uses are left to that test, which applies its own and
 *   puts the previous ones back; the radio of the other nodes stays free.
 * - A node with a run in progress, sending or receiving, refuses radio changes and other runs as
 *   busy (firmware rule), so the panel refuses them first.
 * - Each test needs its nodes open and identified, and with known radio settings when the test
 *   derives its timing from them.
 */
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import type { MeasurementSectionTest } from "$lib/state/panel-sections.ts";
import { activeSenderRun, isRunActive } from "$lib/measurements/test-run-progress.ts";
import {
  isIdentified,
  type ConnectionView,
  type IdentifiedConnection,
} from "$lib/node-session/connection-view.ts";

/** What the panel knows about one kind of radio test. */
export interface RadioTestDefinition {
  /** Nodes the test runs on: the node it is named after first, then the others. */
  readonly nodeCount: 1 | 2;
  /** The test derives its timing from the radio settings of its nodes, which must be known. */
  readonly needsRadioSettings: boolean;
  /**
   * The panel starts the test and follows it in a RadioTestSession; without one, the panel finds
   * the test in the state of the nodes.
   */
  readonly hasSession: boolean;
  /** The test of the measurement section that shows it, or null. */
  readonly sectionTest: MeasurementSectionTest | null;
  /** Why no other test starts while this one runs, in Spanish. */
  readonly inProgressMessage: string;
  /** Why the radio of its nodes does not change while it runs; null when it stays free. */
  readonly radioHeldMessage: string | null;
  /** Why it cannot start on nodes that are not ready for it. */
  readonly unreadyMessage: string;
  /** Where it runs, for the tab of its section test: "en curso en 3A7F". */
  readonly describeProgress: (nodes: readonly NodeIdentifier[]) => string;
}

/** Every radio test of the panel, in the order the views look for one in progress. */
export const RADIO_TESTS = {
  "capacity-test": {
    nodeCount: 2,
    needsRadioSettings: false,
    hasSession: true,
    sectionTest: "capacity-test",
    inProgressMessage: "Hay una prueba de capacidad en curso: hay que esperar a que termine.",
    radioHeldMessage:
      "El nodo participa de la prueba de capacidad en curso: sus parámetros de radio no se cambian hasta que termine.",
    unreadyMessage: "La prueba necesita dos nodos distintos, conectados e identificados.",
    describeProgress: (nodes) => `en curso en ${nodes[0]}`,
  },
  "echo-series": {
    nodeCount: 1,
    needsRadioSettings: true,
    hasSession: true,
    sectionTest: null,
    inProgressMessage: "Hay una serie de ecos en curso: hay que esperar a que termine.",
    radioHeldMessage:
      "El nodo pide la serie de ecos en curso: sus parámetros de radio no se cambian hasta que termine.",
    unreadyMessage:
      "El nodo que pide los ecos tiene que estar conectado, identificado y con sus parámetros de radio conocidos.",
    describeProgress: (nodes) => `en curso en ${nodes[0]}`,
  },
  "communication-test": {
    nodeCount: 1,
    needsRadioSettings: true,
    hasSession: true,
    sectionTest: "communication-test",
    inProgressMessage: "Hay una prueba de comunicación en curso: hay que esperar a que termine.",
    radioHeldMessage:
      "El nodo participa de la prueba de comunicación en curso: sus parámetros de radio no se cambian hasta que termine.",
    unreadyMessage:
      "El nodo tiene que estar conectado, identificado y con sus parámetros de radio conocidos.",
    describeProgress: (nodes) => `en curso en ${nodes[0]}`,
  },
  "receiver-mode": {
    nodeCount: 1,
    needsRadioSettings: true,
    hasSession: true,
    sectionTest: "communication-test",
    inProgressMessage: "El modo receptor está activo en este panel: hay que desactivarlo antes.",
    radioHeldMessage:
      "El nodo está en modo receptor: sus parámetros de radio no se cambian hasta desactivarlo.",
    unreadyMessage:
      "El nodo tiene que estar conectado, identificado y con sus parámetros de radio conocidos.",
    describeProgress: (nodes) => `modo receptor en ${nodes[0]}`,
  },
  "manual-run": {
    nodeCount: 1,
    needsRadioSettings: false,
    hasSession: false,
    sectionTest: "power-sweep",
    inProgressMessage: "Hay una corrida en curso: hay que esperar a que termine.",
    radioHeldMessage: null,
    unreadyMessage: "El nodo tiene que estar conectado e identificado.",
    describeProgress: (nodes) => `en curso en ${nodes.join(", ")}`,
  },
} as const satisfies { readonly [kind: string]: RadioTestDefinition };

export type RadioTestKind = keyof typeof RADIO_TESTS;

/** The tests that a RadioTestSession of the panel follows. */
export type SessionTestKind = {
  [Kind in RadioTestKind]: (typeof RADIO_TESTS)[Kind]["hasSession"] extends true ? Kind : never;
}[RadioTestKind];

/** The tests that start on one node, from the radio settings it reported. */
export type SingleNodeRadioTestKind = {
  [Kind in SessionTestKind]: (typeof RADIO_TESTS)[Kind] extends {
    readonly nodeCount: 1;
    readonly needsRadioSettings: true;
  }
    ? Kind
    : never;
}[SessionTestKind];

/** What may be refused: starting a radio test, or changing the radio settings of a node. */
export type RadioAction = RadioTestKind | "radio-settings";

export interface RadioTestActivity {
  readonly kind: RadioTestKind;
  /** Connections the test commands, the node it is named after first. */
  readonly keys: readonly string[];
  /** Identifiers of those nodes, in the same order. */
  readonly nodes: readonly NodeIdentifier[];
}

/** Why an action cannot start now: a test in progress, a busy node or a node not ready. */
export type RefusalCause = "activity" | "busy" | "unready";

export interface RadioTestRefusal {
  readonly cause: RefusalCause;
  /** The test in progress, for a refusal caused by one. */
  readonly activity: RadioTestKind | null;
  /** In Spanish, for the operator. */
  readonly message: string;
}

/** The node of a test: pinned to the test while it runs, else the node chosen above. */
export interface TestTarget {
  readonly pinned: boolean;
  /** Null when pinned and the connection of the test closed, or when no node takes commands. */
  readonly connection: IdentifiedConnection | null;
}

const BUSY_NODE_MESSAGE =
  "El nodo tiene una corrida en curso: rechaza los cambios de radio hasta que termine.";

const RADIO_SETTINGS_UNREADY_MESSAGE = "El nodo tiene que estar conectado e identificado.";

/**
 * For each test of the measurement section, where a test shown there runs, in Spanish; a section
 * test with none running has no entry.
 */
export function describeSectionProgress(
  activities: readonly RadioTestActivity[],
): ReadonlyMap<MeasurementSectionTest, string> {
  const notes = new Map<MeasurementSectionTest, string>();
  for (const [kind, definition] of Object.entries(RADIO_TESTS) as [
    RadioTestKind,
    RadioTestDefinition,
  ][]) {
    const activity = activities.find((candidate) => candidate.kind === kind);
    const test = definition.sectionTest;
    if (activity !== undefined && test !== null && !notes.has(test)) {
      notes.set(test, definition.describeProgress(activity.nodes));
    }
  }
  return notes;
}

/**
 * The tests in progress: those of the sessions, then the manual runs that identified nodes
 * transmit. A run of a node that a session uses belongs to that session (the capacity test), and
 * a node connected twice counts once.
 */
export function listRadioTestActivities(
  sessions: readonly RadioTestActivity[],
  connections: readonly ConnectionView[],
): RadioTestActivity[] {
  const sessionNodes = new Set(sessions.flatMap((activity) => activity.nodes));
  const keys: string[] = [];
  const nodes: NodeIdentifier[] = [];
  for (const connection of connections) {
    if (
      isIdentified(connection) &&
      activeSenderRun(connection.state) !== null &&
      !sessionNodes.has(connection.state.identifier) &&
      !nodes.includes(connection.state.identifier)
    ) {
      keys.push(connection.key);
      nodes.push(connection.state.identifier);
    }
  }
  return nodes.length === 0 ? [...sessions] : [...sessions, { kind: "manual-run", keys, nodes }];
}

/**
 * Why `action` cannot start now on the nodes of `keys` (for a capacity test, the sender and then
 * the receiver), or null when it can.
 */
export function findRefusal(
  action: RadioAction,
  keys: readonly string[],
  activities: readonly RadioTestActivity[],
  lookup: (key: string) => ConnectionView | null,
): RadioTestRefusal | null {
  const connections = keys.map(lookup);
  if (action === "radio-settings") {
    const identifiers = connections.map((connection) => connection?.state.identifier ?? null);
    for (const activity of activities) {
      const message = RADIO_TESTS[activity.kind].radioHeldMessage;
      if (
        message !== null &&
        identifiers.some((identifier) => identifier !== null && activity.nodes.includes(identifier))
      ) {
        return { cause: "activity", activity: activity.kind, message };
      }
    }
  } else {
    const activity = activities[0];
    if (activity !== undefined) {
      return {
        cause: "activity",
        activity: activity.kind,
        message: RADIO_TESTS[activity.kind].inProgressMessage,
      };
    }
  }
  if (
    (action === "radio-settings" || action === "manual-run") &&
    connections.some((connection) => connection !== null && isRunActive(connection.state))
  ) {
    return { cause: "busy", activity: null, message: BUSY_NODE_MESSAGE };
  }
  if (action === "radio-settings") {
    return isReady(connections, 1, false)
      ? null
      : { cause: "unready", activity: null, message: RADIO_SETTINGS_UNREADY_MESSAGE };
  }
  const definition: RadioTestDefinition = RADIO_TESTS[action];
  return isReady(connections, definition.nodeCount, definition.needsRadioSettings)
    ? null
    : { cause: "unready", activity: null, message: definition.unreadyMessage };
}

function isReady(
  connections: readonly (ConnectionView | null)[],
  nodeCount: number,
  needsRadioSettings: boolean,
): boolean {
  if (connections.length !== nodeCount) {
    return false;
  }
  const identifiers = new Set<NodeIdentifier>();
  for (const connection of connections) {
    if (connection === null || !isIdentified(connection)) {
      return false;
    }
    if (needsRadioSettings && connection.state.radio === null) {
      return false;
    }
    identifiers.add(connection.state.identifier);
  }
  return identifiers.size === nodeCount;
}

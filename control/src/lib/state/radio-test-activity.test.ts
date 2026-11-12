import { describe, expect, it } from "vite-plus/test";
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import { INITIAL_NODE_STATE, type NodeState } from "$lib/node-session/node-state.ts";
import type { ConnectionStatus } from "$lib/node-session/node-connection.ts";
import { DEFAULT_RADIO_SETTINGS } from "$lib/protocol/protocol-contract.ts";
import type { ConnectionView } from "$lib/node-session/connection-view.ts";
import {
  describeSectionProgress,
  findRefusal,
  listRadioTestActivities,
  type RadioAction,
  type RadioTestActivity,
  type RadioTestKind,
} from "./radio-test-activity.ts";

const RADIO = { ...DEFAULT_RADIO_SETTINGS, chip: DEFAULT_RADIO_SETTINGS.power };

const SENDER_RUN = {
  run: 1,
  count: 10,
  size: 8,
  interval: 0,
  transmitted: 3,
  startHostTime: 0,
  completion: null,
} as const;

function view(
  key: string,
  identifier: NodeIdentifier | null,
  overrides: Partial<NodeState> = {},
  status: ConnectionStatus = "open",
): ConnectionView {
  return {
    key,
    transportKind: "serial",
    transportDescription: key,
    status,
    closureMessage: null,
    state: { ...INITIAL_NODE_STATE, identifier, radio: RADIO, ...overrides },
    duplicated: false,
  };
}

/** Three identified nodes with known radio settings, A and B in the tests, C a bystander. */
const CONNECTIONS = [view("usb-1", "AAAA"), view("usb-2", "BBBB"), view("wifi-3", "CCCC")];

function lookupIn(connections: readonly ConnectionView[]) {
  return (key: string): ConnectionView | null =>
    connections.find((connection) => connection.key === key) ?? null;
}

const lookup = lookupIn(CONNECTIONS);

/** The activity of each test kind when it runs on node A (with B as the receiver of the campaign). */
const ACTIVITIES: { readonly [Kind in RadioTestKind]: RadioTestActivity } = {
  "capacity-test": { kind: "capacity-test", keys: ["usb-1", "usb-2"], nodes: ["AAAA", "BBBB"] },
  "echo-series": { kind: "echo-series", keys: ["usb-1"], nodes: ["AAAA"] },
  "communication-test": { kind: "communication-test", keys: ["usb-1"], nodes: ["AAAA"] },
  "receiver-mode": { kind: "receiver-mode", keys: ["usb-1"], nodes: ["AAAA"] },
  "manual-run": { kind: "manual-run", keys: ["usb-1"], nodes: ["AAAA"] },
};

/** The keys each action starts on, away from the nodes of the tests in progress where it can. */
const ACTION_KEYS: { readonly [Action in RadioAction]: readonly string[] } = {
  "capacity-test": ["wifi-3", "usb-2"],
  "echo-series": ["wifi-3"],
  "communication-test": ["wifi-3"],
  "receiver-mode": ["wifi-3"],
  "manual-run": ["wifi-3"],
  "radio-settings": ["wifi-3"],
};

const ACTIONS = Object.keys(ACTION_KEYS) as RadioAction[];
const KINDS = Object.keys(ACTIVITIES) as RadioTestKind[];

describe("findRefusal", () => {
  it("lets every action start when no test runs", () => {
    for (const action of ACTIONS) {
      expect(findRefusal(action, ACTION_KEYS[action], [], lookup), action).toBeNull();
    }
  });

  it("allows one radio test at a time in the panel, on any node", () => {
    for (const kind of KINDS) {
      for (const action of KINDS) {
        const refusal = findRefusal(action, ACTION_KEYS[action], [ACTIVITIES[kind]], lookup);
        expect(refusal, `${action} during ${kind}`).toMatchObject({
          cause: "activity",
          activity: kind,
        });
      }
    }
  });

  it("leaves the radio of the nodes outside the test free", () => {
    for (const kind of KINDS) {
      expect(
        findRefusal("radio-settings", ["wifi-3"], [ACTIVITIES[kind]], lookup),
        kind,
      ).toBeNull();
    }
  });

  it("leaves the radio of the nodes of a test to the test", () => {
    for (const kind of [
      "capacity-test",
      "echo-series",
      "communication-test",
      "receiver-mode",
    ] as const) {
      expect(
        findRefusal("radio-settings", ["usb-1"], [ACTIVITIES[kind]], lookup),
        kind,
      ).toMatchObject({
        cause: "activity",
        activity: kind,
      });
    }
    // The receiver of a capacity test too.
    expect(
      findRefusal("radio-settings", ["usb-2"], [ACTIVITIES["capacity-test"]], lookup),
    ).toMatchObject({ activity: "capacity-test" });
  });

  it("refuses radio changes and runs on a node with a run in progress, sending or receiving", () => {
    const reception = {
      source: "DDDD",
      run: 4,
      count: 10,
      received: 2,
      lastIndex: 1,
      lastRssi: -60,
      lastSnr: 9,
      startHostTime: 0,
      end: null,
    };
    const connections = [
      view("usb-1", "AAAA", { senderRun: SENDER_RUN }),
      view("usb-2", "BBBB", { receptions: [reception] }),
    ];
    for (const key of ["usb-1", "usb-2"]) {
      for (const action of ["radio-settings", "manual-run"] as const) {
        expect(
          findRefusal(action, [key], [], lookupIn(connections)),
          `${action} on ${key}`,
        ).toEqual({
          cause: "busy",
          activity: null,
          message:
            "El nodo tiene una corrida en curso: rechaza los cambios de radio hasta que termine.",
        });
      }
    }
  });

  it("needs open and identified nodes, with radio settings for the tests that time echoes", () => {
    const connections = [
      view("usb-1", null),
      view("usb-2", "BBBB", {}, "closed"),
      view("usb-3", "CCCC", { radio: null }),
      view("usb-4", "DDDD"),
    ];
    const refusalOf = (action: RadioAction, ...keys: string[]) =>
      findRefusal(action, keys, [], lookupIn(connections))?.cause ?? null;
    for (const action of ACTIONS.filter((candidate) => candidate !== "capacity-test")) {
      expect(refusalOf(action, "usb-1"), action).toBe("unready");
      expect(refusalOf(action, "usb-2"), action).toBe("unready");
      expect(refusalOf(action, "gone"), action).toBe("unready");
    }
    expect(refusalOf("echo-series", "usb-3")).toBe("unready");
    expect(refusalOf("communication-test", "usb-3")).toBe("unready");
    expect(refusalOf("receiver-mode", "usb-3")).toBe("unready");
    expect(refusalOf("manual-run", "usb-3")).toBeNull();
    expect(refusalOf("radio-settings", "usb-3")).toBeNull();
    expect(refusalOf("capacity-test", "usb-4", "usb-3")).toBeNull();
    expect(refusalOf("capacity-test", "usb-4", "usb-4")).toBe("unready");
    expect(refusalOf("capacity-test", "usb-4")).toBe("unready");
  });
});

describe("listRadioTestActivities", () => {
  it("adds the manual runs that identified nodes transmit, once per node", () => {
    const connections = [
      view("usb-1", "AAAA", { senderRun: SENDER_RUN }),
      view("wifi-2", "AAAA", { senderRun: SENDER_RUN }),
      view("usb-3", "BBBB", {
        senderRun: {
          ...SENDER_RUN,
          completion: { sent: 10, duration: 1, aborted: false, hostTime: 0 },
        },
      }),
      view("usb-4", null, { senderRun: SENDER_RUN }),
    ];
    expect(listRadioTestActivities([], connections)).toEqual([
      { kind: "manual-run", keys: ["usb-1"], nodes: ["AAAA"] },
    ]);
  });

  it("leaves the runs of a session node to the session", () => {
    const campaign = ACTIVITIES["capacity-test"];
    const connections = [view("usb-1", "AAAA", { senderRun: SENDER_RUN })];
    expect(listRadioTestActivities([campaign], connections)).toEqual([campaign]);
  });
});

describe("describeSectionProgress", () => {
  it("notes on the tab of each measurement test where a test shown there runs", () => {
    expect(describeSectionProgress([ACTIVITIES["capacity-test"]])).toEqual(
      new Map([["capacity-test", "en curso en AAAA"]]),
    );
    expect(describeSectionProgress([ACTIVITIES["receiver-mode"]])).toEqual(
      new Map([["communication-test", "modo receptor en AAAA"]]),
    );
    expect(
      describeSectionProgress([
        ACTIVITIES["echo-series"],
        { kind: "manual-run", keys: ["usb-1", "usb-2"], nodes: ["AAAA", "BBBB"] },
      ]),
    ).toEqual(new Map([["power-sweep", "en curso en AAAA, BBBB"]]));
  });
});

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
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import { buildConnectionGraph } from "./connection-graph.ts";
import { INITIAL_NODE_STATE, applyConsoleEvent, type NodeState } from "./node-state.ts";

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

function graphAt(relativeTime: number, connected: "both" | "origin" = "both") {
  const hostTime = SENDER_BOOT_HOST_TIME + relativeTime;
  const states = [replayUntil(originEvents, hostTime)];
  if (connected === "both") {
    states.push(replayUntil(receiverEvents, hostTime));
  }
  return buildConnectionGraph(states, hostTime);
}

function hello(
  source: string,
  available: number,
  neighbors: { id: string; rssi: number; snr: number }[],
): ConsoleEvent {
  return {
    t: 1000,
    ev: "hello",
    src: source,
    epoch: 1,
    seq: 1,
    model: "V2",
    version: 0,
    available,
    vm_fault: null,
    vm_failing: false,
    tx: 1,
    rssi: -60,
    snr: 5,
    ferr: 0,
    neighbors,
  };
}

describe("buildConnectionGraph", () => {
  it("joins two connected nodes with how each one hears the other", () => {
    const graph = graphAt(47_000);
    expect(graph.nodes.map((node) => [node.id, node.connected, node.source])).toEqual([
      ["3A7F", true, "console"],
      ["5C21", true, "console"],
    ]);
    expect(graph.links).toEqual([
      {
        first: "3A7F",
        second: "5C21",
        // The HELLO of 3A7F at 46 s is fresher than its own table entry of 44 s.
        firstHearsSecond: { rssi: -47, snr: 9.75, hostTime: SENDER_BOOT_HOST_TIME + 46_000 },
        secondHearsFirst: { rssi: -41.5, snr: 9.5, hostTime: SENDER_BOOT_HOST_TIME + 46_000 },
      },
    ]);
  });

  it("takes the versions of a connected node from its console", () => {
    const graph = graphAt(50_100);
    expect(graph.nodes.find((node) => node.id === "5C21")).toMatchObject({
      activeVersion: 0,
      availableVersion: UPDATE_VERSION,
    });
    expect(graph.nodes.find((node) => node.id === "3A7F")).toMatchObject({
      activeVersion: 0,
      availableVersion: 0,
    });
  });

  it("takes the versions of a node it does not reach from the HELLO heard by another", () => {
    const graph = graphAt(60_000, "origin");
    expect(graph.nodes.find((node) => node.id === "3A7F")).toMatchObject({
      connected: false,
      source: "neighbor",
      model: "V4.3",
      activeVersion: 0,
      availableVersion: UPDATE_VERSION,
      vmFault: null,
      vmFailing: false,
      lastHeardHostTime: SENDER_BOOT_HOST_TIME + 59_000,
    });
  });

  it("adds the nodes known only from neighbor lists, with unknown versions", () => {
    let state = INITIAL_NODE_STATE;
    for (const event of readFixtureEvents(UPDATE_ORIGIN_LOG, SENDER_BOOT_HOST_TIME).slice(0, 3)) {
      state = applyConsoleEvent(state, event.event, event.hostTime);
    }
    const now = SENDER_BOOT_HOST_TIME + 1000;
    state = applyConsoleEvent(
      state,
      hello("3A7F", 0, [
        { id: "5C21", rssi: -47, snr: 9 },
        { id: "9B04", rssi: -101, snr: -7.25 },
      ]),
      now,
    );
    const graph = buildConnectionGraph([state], now);
    expect(graph.nodes.map((node) => [node.id, node.source, node.availableVersion])).toEqual([
      ["3A7F", "neighbor", 0],
      ["5C21", "console", 0],
      ["9B04", "neighbor_list", null],
    ]);
    expect(graph.links.find((link) => link.second === "9B04")).toEqual({
      first: "3A7F",
      second: "9B04",
      firstHearsSecond: { rssi: -101, snr: -7.25, hostTime: now },
      secondHearsFirst: null,
    });
  });

  it("leaves out the neighbors the node would have dropped", () => {
    const graph = buildConnectionGraph(
      [replayUntil(originEvents, SENDER_BOOT_HOST_TIME + 47_000)],
      SENDER_BOOT_HOST_TIME + 47_000 + 61_000,
    );
    expect(graph.nodes.map((node) => node.id)).toEqual(["5C21"]);
    expect(graph.links).toEqual([]);
  });

  it("ignores connections whose node is not identified yet", () => {
    expect(buildConnectionGraph([INITIAL_NODE_STATE], 0)).toEqual({ nodes: [], links: [] });
  });
});

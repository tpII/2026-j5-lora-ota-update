import { describe, expect, it } from "vite-plus/test";
import type { ConnectionGraph, GraphLink, GraphNode } from "./connection-graph.ts";
import { GraphForceModel, type GraphPlacements } from "./graph-force-model.ts";
import {
  GRAPH_PINS_STORAGE_KEY,
  loadPinnedPositions,
  savePinnedPositions,
  type PinnedPositions,
} from "./graph-pins.ts";

function node(id: string): GraphNode {
  return {
    id,
    model: "V2",
    connected: false,
    source: "neighbor",
    activeVersion: 0,
    availableVersion: 0,
    vmFault: null,
    vmFailing: null,
    lastHeardHostTime: null,
  };
}

function link(first: string, second: string, rssi: number | null = -70): GraphLink {
  const quality = rssi === null ? null : { rssi, snr: 5, hostTime: 0 };
  return { first, second, firstHearsSecond: quality, secondHearsFirst: quality };
}

function harness(pins: PinnedPositions = new Map()) {
  const state: { placements: GraphPlacements; pins: PinnedPositions | null } = {
    placements: new Map(),
    pins: null,
  };
  const model = new GraphForceModel({
    pins,
    running: false,
    onChange: (placements) => (state.placements = placements),
    onPinsChange: (changed) => (state.pins = changed),
  });
  model.setSize(800, 400);
  return { model, state };
}

function at(placements: GraphPlacements, id: string) {
  const placement = placements.get(id);
  if (placement === undefined) {
    throw new Error(`no placement for ${id}`);
  }
  return placement;
}

const CHAIN: ConnectionGraph = {
  nodes: [node("AAAA"), node("BBBB"), node("CCCC")],
  links: [link("AAAA", "BBBB", -50), link("BBBB", "CCCC", -110)],
};

describe("GraphForceModel", () => {
  it("places every node inside the drawing, apart from each other", () => {
    const { model, state } = harness();
    model.update(CHAIN);
    model.step(300);
    const points = CHAIN.nodes.map((entry) => at(state.placements, entry.id));
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(36);
      expect(point.x).toBeLessThanOrEqual(800 - 36);
      expect(point.y).toBeGreaterThanOrEqual(36);
      expect(point.y).toBeLessThanOrEqual(400 - 36);
    }
    for (const [index, first] of points.entries()) {
      for (const second of points.slice(index + 1)) {
        expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeGreaterThan(60);
      }
    }
  });

  it("makes a weak link longer than a strong one", () => {
    const { model, state } = harness();
    model.update(CHAIN);
    model.step(400);
    const a = at(state.placements, "AAAA");
    const b = at(state.placements, "BBBB");
    const c = at(state.placements, "CCCC");
    expect(Math.hypot(b.x - c.x, b.y - c.y)).toBeGreaterThan(Math.hypot(a.x - b.x, a.y - b.y));
  });

  it("keeps the positions when the same graph arrives again", () => {
    const { model, state } = harness();
    model.update(CHAIN);
    model.step(300);
    const before = at(state.placements, "BBBB");
    model.update({ ...CHAIN, links: CHAIN.links.map((entry) => ({ ...entry })) });
    expect(at(state.placements, "BBBB")).toEqual(before);
  });

  it("pins a moved node where it is dropped and reports the pin normalized", () => {
    const { model, state } = harness();
    model.update(CHAIN);
    model.step(100);
    model.moveTo("CCCC", 600, 100);
    model.endMove();
    model.step(200);
    expect(at(state.placements, "CCCC")).toEqual({ x: 600, y: 100, pinned: true });
    expect(state.pins?.get("CCCC")).toEqual({ x: 0.75, y: 0.25 });
  });

  it("starts a pinned node at its pin, scaled to the size of the drawing", () => {
    const { model, state } = harness(new Map([["AAAA", { x: 0.25, y: 0.5 }]]));
    model.update(CHAIN);
    model.step(50);
    expect(at(state.placements, "AAAA")).toEqual({ x: 200, y: 200, pinned: true });
    model.setSize(400, 400);
    model.step(1);
    expect(at(state.placements, "AAAA")).toMatchObject({ x: 100, y: 200 });
  });

  it("frees a pinned node and every node", () => {
    const { model, state } = harness(new Map([["AAAA", { x: 0.1, y: 0.1 }]]));
    model.update(CHAIN);
    model.moveTo("BBBB", 400, 200);
    model.endMove();
    model.release("AAAA");
    expect(state.pins?.has("AAAA")).toBe(false);
    expect(state.pins?.has("BBBB")).toBe(true);
    model.releaseAll();
    expect(state.pins?.size).toBe(0);
    model.step(1);
    expect(at(state.placements, "BBBB").pinned).toBe(false);
  });

  it("lengthens a link whose RSSI weakens while the topology stays", () => {
    const { model, state } = harness();
    model.update(CHAIN);
    model.step(400);
    const distance = (first: string, second: string) => {
      const a = at(state.placements, first);
      const b = at(state.placements, second);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    expect(distance("AAAA", "BBBB")).toBeLessThan(distance("BBBB", "CCCC"));
    model.update({ ...CHAIN, links: [link("AAAA", "BBBB", -110), link("BBBB", "CCCC", -50)] });
    model.step(400);
    expect(distance("AAAA", "BBBB")).toBeGreaterThan(distance("BBBB", "CCCC"));
  });

  it("ends a drag when the dragged node leaves the graph", () => {
    const { model } = harness();
    model.update(CHAIN);
    model.moveTo("CCCC", 600, 100);
    expect(model.isMoving).toBe(true);
    model.update({ nodes: [node("AAAA"), node("BBBB")], links: [link("AAAA", "BBBB", -50)] });
    expect(model.isMoving).toBe(false);
  });

  it("drops the nodes that leave the graph", () => {
    const { model, state } = harness();
    model.update(CHAIN);
    model.update({ nodes: [node("AAAA")], links: [] });
    expect([...state.placements.keys()]).toEqual(["AAAA"]);
  });
});

describe("pinned positions storage", () => {
  it("writes and reads the pins", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    savePinnedPositions(storage, new Map([["AAAA", { x: 0.5, y: 0.25 }]]));
    expect(store.has(GRAPH_PINS_STORAGE_KEY)).toBe(true);
    expect(loadPinnedPositions(storage)).toEqual(new Map([["AAAA", { x: 0.5, y: 0.25 }]]));
  });

  it("ignores damaged or out of range entries", () => {
    const storage = {
      getItem: () => '{"AAAA":{"x":2,"y":0.5},"BBBB":{"x":0.5,"y":0.5},"CCCC":"x"}',
    };
    expect(loadPinnedPositions(storage)).toEqual(new Map([["BBBB", { x: 0.5, y: 0.5 }]]));
    expect(loadPinnedPositions({ getItem: () => "not json" })).toEqual(new Map());
  });
});

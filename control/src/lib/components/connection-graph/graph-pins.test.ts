import { describe, expect, it } from "vite-plus/test";
import { GRAPH_PINS_STORAGE_KEY, loadPinnedPositions, savePinnedPositions } from "./graph-pins.ts";

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

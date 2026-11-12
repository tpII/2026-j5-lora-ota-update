import { describe, expect, it } from "vite-plus/test";
import { adjacentTabIndex } from "./tab-navigation.ts";

describe("adjacentTabIndex", () => {
  it("moves with the arrows and wraps around", () => {
    expect(adjacentTabIndex("ArrowRight", 0, 3)).toBe(1);
    expect(adjacentTabIndex("ArrowDown", 2, 3)).toBe(0);
    expect(adjacentTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(adjacentTabIndex("ArrowUp", 1, 3)).toBe(0);
  });

  it("goes to the ends with Home and End", () => {
    expect(adjacentTabIndex("Home", 2, 5)).toBe(0);
    expect(adjacentTabIndex("End", 0, 5)).toBe(4);
  });

  it("ignores any other key", () => {
    expect(adjacentTabIndex("Enter", 1, 3)).toBeNull();
    expect(adjacentTabIndex("a", 1, 3)).toBeNull();
  });
});

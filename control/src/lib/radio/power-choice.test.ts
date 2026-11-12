import { describe, expect, it } from "vite-plus/test";
import { choosePower, pendingPowerOf } from "./power-choice.ts";

describe("pendingPowerOf", () => {
  it("keeps the power picked while the node reports the power it had", () => {
    expect(pendingPowerOf(choosePower("usb-1", 10, 4), "usb-1", 4)).toBe(10);
  });

  it("forgets the choice once the node reports another power", () => {
    const choice = choosePower("usb-1", 10, 4);
    expect(pendingPowerOf(choice, "usb-1", 10)).toBeNull();
    expect(pendingPowerOf(choice, "usb-1", 7)).toBeNull();
  });

  it("applies only to the node it was picked for", () => {
    expect(pendingPowerOf(choosePower("usb-1", 10, 4), "usb-2", 4)).toBeNull();
  });

  it("has nothing pending when the operator picks the power the node has", () => {
    expect(pendingPowerOf(choosePower("usb-1", 4, 4), "usb-1", 4)).toBeNull();
    expect(pendingPowerOf(null, "usb-1", 4)).toBeNull();
  });

  it("waits for the first report of a node that had reported no power", () => {
    expect(pendingPowerOf(choosePower("usb-1", 10, null), "usb-1", null)).toBe(10);
  });
});

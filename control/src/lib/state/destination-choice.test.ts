import { describe, expect, it } from "vite-plus/test";
import { DestinationChoice } from "./destination-choice.svelte.ts";

describe("DestinationChoice", () => {
  it("takes the first neighbor of the first node that requests", () => {
    const choice = new DestinationChoice();
    expect(choice.follow("usb-1", ["5C21", "9B04"])).toBe(true);
    expect(choice.text).toBe("5C21");
  });

  it("keeps a destination that is a neighbor of the next node, typed in any case", () => {
    const choice = new DestinationChoice();
    choice.follow("usb-1", ["5C21", "9B04"]);
    choice.text = " 9b04";
    expect(choice.follow("usb-2", ["3A7F", "9B04"])).toBe(false);
    expect(choice.text).toBe(" 9b04");
  });

  it("drops a destination that is not a neighbor of the next node", () => {
    const choice = new DestinationChoice();
    choice.follow("usb-1", ["5C21"]);
    expect(choice.follow("usb-2", ["3A7F"])).toBe(true);
    expect(choice.text).toBe("3A7F");
    expect(choice.follow("usb-3", [])).toBe(true);
    expect(choice.text).toBe("");
  });

  it("leaves what the operator types while the node stays, until it is empty", () => {
    const choice = new DestinationChoice();
    choice.follow("usb-1", []);
    choice.text = "ABCD";
    expect(choice.follow("usb-1", ["5C21"])).toBe(false);
    expect(choice.text).toBe("ABCD");
    choice.text = "";
    expect(choice.follow("usb-1", ["5C21"])).toBe(true);
    expect(choice.text).toBe("5C21");
  });

  it("changes nothing without a node", () => {
    const choice = new DestinationChoice();
    choice.follow("usb-1", ["5C21"]);
    expect(choice.follow(null, [])).toBe(false);
    expect(choice.text).toBe("5C21");
  });

  it("counts the destinations other components fill in", () => {
    const choice = new DestinationChoice();
    choice.prepare("9B04");
    choice.prepare("5C21");
    expect(choice.text).toBe("5C21");
    expect(choice.preparations).toBe(2);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { describeProgramFault } from "./fault-descriptions.ts";

describe("describeProgramFault", () => {
  it("names the fault and its address", () => {
    expect(describeProgramFault("division_by_zero", 12)).toBe(
      "división por cero en la dirección 12",
    );
  });
});

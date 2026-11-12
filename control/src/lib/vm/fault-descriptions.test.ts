import { describe, expect, it } from "vite-plus/test";
import { describeProgramDefect } from "./fault-descriptions.ts";

describe("describeProgramDefect", () => {
  it("names the defect and its address", () => {
    expect(describeProgramDefect("invalid_jump_target", 12)).toBe(
      "salto o llamada a una dirección que no es el comienzo de una instrucción en la dirección 12",
    );
  });
});

import { describe, expect, it } from "vite-plus/test";
import { VirtualMachine, runUntilStop } from "$lib/vm/virtual-machine.ts";
import { EXAMPLE_PROGRAM, ProgramDraft } from "./program-draft.svelte.ts";

describe("EXAMPLE_PROGRAM", () => {
  it("assembles and counts down from 8 to 0 before HALT", () => {
    const assembly = new ProgramDraft().assembly;
    if (!assembly.valid) {
      throw new Error(assembly.problems.map((problem) => problem.message).join(" "));
    }
    expect(assembly.instructions.flatMap((instruction) => instruction.labels)).toEqual([
      "loop",
      "end",
      "show",
    ]);
    const machine = new VirtualMachine();
    expect(machine.load(assembly.code).valid).toBe(true);
    const outcome = runUntilStop(machine, 1000);
    expect(outcome.step).toBe("halted");
    expect(outcome.prints.map((print) => print.value)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(machine.stackDepth).toBe(0);
  });

  it("is the program a new draft starts with", () => {
    expect(new ProgramDraft().source).toBe(EXAMPLE_PROGRAM);
  });
});

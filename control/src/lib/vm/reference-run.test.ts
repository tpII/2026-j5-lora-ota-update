import { describe, expect, it } from "vite-plus/test";
import { ReferenceRun, isStaleRun } from "./reference-run.ts";

function codeOf(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** LOAD R1, 7; PRINT R1; HALT. */
const PRINT_SEVEN = codeOf("020107000000" + "0101" + "00");
/** PRINT R2; DIVI R2, 0. */
const DIVIDE_BY_ZERO = codeOf("0102" + "160200000000");
const REGISTERS = [0, 5, 0, 0];

describe("ReferenceRun", () => {
  it("loads the program on the first tick and records what it prints", () => {
    const run = new ReferenceRun();
    run.tick(PRINT_SEVEN, REGISTERS);
    expect(run.snapshot.prints).toEqual([{ tick: 1, register: 1, value: 7 }]);
    expect(run.snapshot.haltedTick).toBe(1);
    expect(run.snapshot.machine).toMatchObject({ tick: 1, running: false, fault: null });
  });

  it("steps one instruction at a time with the same outputs as a tick", () => {
    const run = new ReferenceRun();
    run.step(PRINT_SEVEN, REGISTERS);
    expect(run.snapshot.machine).toMatchObject({ programCounter: 6, running: true });
    run.step(PRINT_SEVEN, REGISTERS);
    expect(run.snapshot.prints).toEqual([{ tick: 1, register: 1, value: 7 }]);
    expect(run.snapshot.haltedTick).toBeNull();
    run.step(PRINT_SEVEN, REGISTERS);
    expect(run.snapshot.haltedTick).toBe(1);
  });

  it("finishes the tick in progress instead of starting another one", () => {
    const run = new ReferenceRun();
    run.step(PRINT_SEVEN, REGISTERS);
    run.tick(PRINT_SEVEN, REGISTERS);
    expect(run.snapshot.machine?.tick).toBe(1);
    expect(run.snapshot.prints).toHaveLength(1);
  });

  it("keeps the last fault through the next ticks until a reset", () => {
    const run = new ReferenceRun();
    run.tick(DIVIDE_BY_ZERO, REGISTERS);
    run.tick(DIVIDE_BY_ZERO, REGISTERS);
    expect(run.snapshot.lastFault).toEqual({ tick: 2, address: 2, reason: "division_by_zero" });
    expect(run.snapshot.prints.map((print) => print.value)).toEqual([5, 5]);
    run.reset(DIVIDE_BY_ZERO, REGISTERS);
    expect(run.snapshot.lastFault).toBeNull();
    expect(run.snapshot.prints).toEqual([]);
  });

  it("starts over when the program changes", () => {
    const run = new ReferenceRun();
    run.tick(PRINT_SEVEN, REGISTERS);
    expect(isStaleRun(run.snapshot, PRINT_SEVEN)).toBe(false);
    expect(isStaleRun(run.snapshot, DIVIDE_BY_ZERO)).toBe(true);
    expect(isStaleRun(run.snapshot, null)).toBe(true);
    run.tick(DIVIDE_BY_ZERO, REGISTERS);
    expect(run.snapshot.machine?.tick).toBe(1);
    expect(run.snapshot.prints).toEqual([{ tick: 1, register: 2, value: 5 }]);
  });

  it("keeps the newest hundred outputs", () => {
    const run = new ReferenceRun();
    for (let tick = 0; tick < 101; tick += 1) {
      run.tick(PRINT_SEVEN, REGISTERS);
    }
    expect(run.snapshot.prints).toHaveLength(100);
    expect(run.snapshot.prints[0]?.tick).toBe(2);
  });

  it("is not stale before the first run", () => {
    expect(isStaleRun(new ReferenceRun().snapshot, null)).toBe(false);
  });
});

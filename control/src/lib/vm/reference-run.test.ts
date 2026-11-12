import { describe, expect, it } from "vite-plus/test";
import {
  VM_MINIMUM_PRINT_INTERVAL_MILLISECONDS,
  VM_RESTART_DELAY_MILLISECONDS,
} from "$lib/protocol/protocol-contract.ts";
import { ReferenceRun, isStaleRun } from "./reference-run.ts";

function codeOf(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** LOAD R1, 7; PRINT R1; HALT. */
const PRINT_SEVEN = codeOf("020107000000" + "0101" + "00");
/** PRINT R2; DIVI R2, 0. */
const DIVIDE_BY_ZERO = codeOf("0102" + "160200000000");
/** SLEEP 50; PRINT R2; HALT. */
const SLEEP_THEN_PRINT = codeOf("0332000000" + "0102" + "00");
/** loop: PRINT R1; JMP loop. */
const PRINT_FOREVER = codeOf("0101" + "300000");
/** loop: JMP loop. */
const SPIN_FOREVER = codeOf("300000");
const REGISTERS = [0, 5, 0, 0];

const PRINT_WAIT = VM_MINIMUM_PRINT_INTERVAL_MILLISECONDS;
const RESTART_DELAY = VM_RESTART_DELAY_MILLISECONDS;

describe("ReferenceRun", () => {
  it("runs without end, with the wait after each PRINT and the restart after HALT", () => {
    const run = new ReferenceRun();
    run.start(PRINT_SEVEN, REGISTERS, 0);
    run.run(PRINT_SEVEN, REGISTERS, 0);
    expect(run.snapshot.prints).toEqual([{ number: 1, register: 1, value: 7 }]);
    expect(run.snapshot.resumeAt).toBe(PRINT_WAIT);
    run.run(PRINT_SEVEN, REGISTERS, PRINT_WAIT - 1);
    expect(run.snapshot.machine).toMatchObject({ programCounter: 8, running: true });
    run.run(PRINT_SEVEN, REGISTERS, PRINT_WAIT);
    expect(run.snapshot.stopCause).toBe("halt");
    expect(run.snapshot.machine).toMatchObject({ starts: 1, running: false, fault: null });
    run.run(PRINT_SEVEN, REGISTERS, PRINT_WAIT + RESTART_DELAY - 1);
    expect(run.snapshot.prints).toHaveLength(1);
    run.run(PRINT_SEVEN, REGISTERS, PRINT_WAIT + RESTART_DELAY);
    expect(run.snapshot.prints.at(-1)).toEqual({ number: 2, register: 1, value: 7 });
    expect(run.snapshot.machine?.starts).toBe(2);
    expect(run.snapshot.stopCause).toBeNull();
  });

  it("waits what each SLEEP asks", () => {
    const run = new ReferenceRun();
    run.start(SLEEP_THEN_PRINT, REGISTERS, 0);
    run.run(SLEEP_THEN_PRINT, REGISTERS, 0);
    expect(run.snapshot.resumeAt).toBe(50);
    run.run(SLEEP_THEN_PRINT, REGISTERS, 49);
    expect(run.snapshot.prints).toEqual([]);
    run.run(SLEEP_THEN_PRINT, REGISTERS, 50);
    expect(run.snapshot.prints).toEqual([{ number: 1, register: 2, value: 5 }]);
  });

  it("steps one instruction at a time without waits", () => {
    const run = new ReferenceRun();
    run.step(PRINT_SEVEN, REGISTERS, 0);
    expect(run.snapshot.machine).toMatchObject({ programCounter: 6, running: true });
    run.step(PRINT_SEVEN, REGISTERS, 0);
    expect(run.snapshot.prints).toEqual([{ number: 1, register: 1, value: 7 }]);
    run.step(PRINT_SEVEN, REGISTERS, 0);
    expect(run.snapshot.stopCause).toBe("halt");
    run.step(PRINT_SEVEN, REGISTERS, 0);
    expect(run.snapshot.machine).toMatchObject({ starts: 2, running: true });
    expect(run.snapshot.stopCause).toBeNull();
  });

  it("keeps the last fault through the next starts until a reset", () => {
    const run = new ReferenceRun();
    run.start(DIVIDE_BY_ZERO, REGISTERS, 0);
    run.run(DIVIDE_BY_ZERO, REGISTERS, 0);
    run.run(DIVIDE_BY_ZERO, REGISTERS, PRINT_WAIT);
    expect(run.snapshot.stopCause).toBe("fault");
    run.run(DIVIDE_BY_ZERO, REGISTERS, PRINT_WAIT + RESTART_DELAY);
    run.run(DIVIDE_BY_ZERO, REGISTERS, 2 * PRINT_WAIT + RESTART_DELAY);
    expect(run.snapshot.lastFault).toEqual({ starts: 2, address: 2, reason: "division_by_zero" });
    expect(run.snapshot.prints.map((print) => print.value)).toEqual([5, 5]);
    run.reset(DIVIDE_BY_ZERO, REGISTERS);
    expect(run.snapshot.lastFault).toBeNull();
    expect(run.snapshot.prints).toEqual([]);
  });

  it("starts over when the program changes", () => {
    const run = new ReferenceRun();
    run.start(PRINT_SEVEN, REGISTERS, 0);
    run.run(PRINT_SEVEN, REGISTERS, 0);
    expect(isStaleRun(run.snapshot, PRINT_SEVEN)).toBe(false);
    expect(isStaleRun(run.snapshot, DIVIDE_BY_ZERO)).toBe(true);
    expect(isStaleRun(run.snapshot, null)).toBe(true);
    run.run(DIVIDE_BY_ZERO, REGISTERS, 0);
    expect(run.snapshot.machine?.starts).toBe(1);
    expect(run.snapshot.prints).toEqual([{ number: 1, register: 2, value: 5 }]);
  });

  it("keeps the newest hundred outputs", () => {
    const run = new ReferenceRun();
    run.start(PRINT_FOREVER, REGISTERS, 0);
    for (let output = 0; output < 101; output += 1) {
      run.run(PRINT_FOREVER, REGISTERS, output * PRINT_WAIT);
    }
    expect(run.snapshot.prints).toHaveLength(100);
    expect(run.snapshot.prints[0]?.number).toBe(2);
  });

  it("returns from a loop without waits after a bounded number of blocks", () => {
    const run = new ReferenceRun();
    run.start(SPIN_FOREVER, REGISTERS, 0);
    run.run(SPIN_FOREVER, REGISTERS, 0);
    expect(run.snapshot.machine).toMatchObject({ running: true, starts: 1 });
  });

  it("is not stale before the first run", () => {
    expect(isStaleRun(new ReferenceRun().snapshot, null)).toBe(false);
  });
});

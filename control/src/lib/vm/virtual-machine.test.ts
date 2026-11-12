// The shared cases come from firmware/protocol/test-vectors/virtual-machine.json, which the firmware host
// tests read too; the cases below them check what only the panel interpreter offers.
import { describe, expect, it } from "vite-plus/test";
import virtualMachineVectors from "../../../../firmware/protocol/test-vectors/virtual-machine.json";
import {
  VirtualMachine,
  checkProgram,
  finishTick,
  runTick,
  stepInstruction,
  type TickOutcome,
} from "./virtual-machine.ts";

function codeOf(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function loaded(
  hex: string,
  registers: readonly number[] = [0, 0, 0, 0],
  limit?: number,
): VirtualMachine {
  const machine = new VirtualMachine(limit);
  expect(machine.load(codeOf(hex)).valid).toBe(true);
  machine.setRegisters(registers);
  return machine;
}

describe("VirtualMachine with the shared vectors", () => {
  it.each(virtualMachineVectors.runs)("$name", (vector) => {
    const machine = loaded(vector.program, vector.registers, vector.instructionLimit);
    let outcome: TickOutcome | null = null;
    const prints: { register: number; value: number }[] = [];
    for (let tick = 0; tick < vector.ticks; ++tick) {
      outcome = runTick(machine);
      prints.push(...outcome.prints.map(({ register, value }) => ({ register, value })));
    }
    const { expected } = vector;
    expect(outcome?.step).toBe(expected.step);
    expect(prints).toEqual(expected.prints);
    expect(machine.registers).toEqual(expected.registers);
    expect(machine.fault).toBe(expected.fault);
    if (expected.faultAddress !== null) {
      expect(machine.faultAddress).toBe(expected.faultAddress);
    }
    expect(machine.tickNumber).toBe(expected.tickNumber);
  });
});

describe("checkProgram with the shared vectors", () => {
  it.each(virtualMachineVectors.checks)("$name", (vector) => {
    expect(checkProgram(codeOf(vector.program))).toEqual(
      vector.valid
        ? { valid: true }
        : { valid: false, address: vector.address, fault: vector.fault },
    );
  });
});

describe("VirtualMachine", () => {
  it("runs one instruction at a time and finishes the tick later", () => {
    const machine = loaded("020107000000" + "0101" + "00");
    machine.startTick();
    expect(machine.execute(1)).toBe("running");
    expect(machine.programCounter).toBe(6);
    expect(machine.execute(1)).toBe("printed");
    expect(finishTick(machine).step).toBe("halted");
  });
});

describe("stepInstruction", () => {
  it("starts a tick and reads the value of each PRINT, as finishTick does", () => {
    const machine = loaded("020107000000" + "0101" + "00");
    expect(stepInstruction(machine)).toEqual({ step: "running", print: null });
    expect(stepInstruction(machine)).toEqual({
      step: "printed",
      print: { tick: 1, register: 1, value: 7 },
    });
    expect(stepInstruction(machine)).toEqual({ step: "halted", print: null });
    expect(stepInstruction(machine).step).toBe("running");
    expect(machine.tickNumber).toBe(2);
  });
});

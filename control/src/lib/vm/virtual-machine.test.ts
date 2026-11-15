// The shared cases come from firmware/protocol/test-vectors/virtual-machine.json, which the firmware host
// tests read too; the cases below them check what only the panel interpreter offers.
import { describe, expect, it } from "vite-plus/test";
import virtualMachineVectors from "../../../../firmware/protocol/test-vectors/virtual-machine.json";
import { SimulatedPinBank } from "./simulated-pins.ts";
import {
  VirtualMachine,
  advance,
  checkProgram,
  runUntilStop,
  stepInstruction,
  type VmStep,
} from "./virtual-machine.ts";

function codeOf(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function loaded(
  hex: string,
  registers: readonly number[] = [0, 0, 0, 0],
  pins: SimulatedPinBank = new SimulatedPinBank(),
): VirtualMachine {
  const machine = new VirtualMachine(pins);
  expect(machine.load(codeOf(hex)).valid).toBe(true);
  machine.setRegisters(registers);
  return machine;
}

function stepName(step: VmStep): "halted" | "faulted" | "running" {
  return step === "halted" || step === "faulted" ? step : "running";
}

describe("VirtualMachine with the shared vectors", () => {
  it.each(virtualMachineVectors.runs)("$name", (vector) => {
    const circuitLevels = new Map(
      Object.entries(vector.pinLevels ?? {}).map(([pin, level]) => [Number(pin), level !== 0]),
    );
    const pins = new SimulatedPinBank(circuitLevels);
    const machine = loaded(vector.program, vector.registers, pins);
    const limit = vector.maximumInstructions ?? virtualMachineVectors.defaultMaximumInstructions;
    const prints: { register: number; value: number }[] = [];
    const sleeps: number[] = [];
    let step: VmStep = "idle";
    // Each start runs to HALT, to a fault or to the instruction limit of the vector, one
    // instruction at a time so that the limit is exact, as the firmware host tests do.
    for (let start = 0; start < vector.starts; ++start) {
      machine.startVM();
      for (let executed = 0; executed < limit; ++executed) {
        const outcome = advance(machine, 1);
        step = outcome.step;
        if (outcome.print !== null) {
          prints.push({ register: outcome.print.register, value: outcome.print.value });
        } else if (step === "sleeping") {
          sleeps.push(machine.sleepMilliseconds);
        } else if (step === "halted" || step === "faulted") {
          break;
        }
      }
    }
    const { expected } = vector;
    expect(stepName(step)).toBe(expected.step);
    expect(prints).toEqual(expected.prints);
    expect(machine.printCount).toBe(expected.prints.length);
    expect(sleeps).toEqual(expected.sleeps ?? []);
    expect(machine.registers).toEqual(expected.registers);
    expect(machine.fault).toBe(expected.fault);
    if (expected.faultAddress !== null) {
      expect(machine.faultAddress).toBe(expected.faultAddress);
    }
    expect(machine.startCount).toBe(expected.startCount);
    expect(machine.stackDepth).toBe(expected.stackDepth ?? 0);
    const outputs = Object.fromEntries(
      pins.states
        .filter((state) => state.direction === "output")
        .map((state) => [String(state.pin), state.level ? 1 : 0]),
    );
    expect(outputs).toEqual(expected.pinOutputs ?? {});
  });
});

describe("checkProgram with the shared vectors", () => {
  it.each(virtualMachineVectors.checks)("$name", (vector) => {
    expect(checkProgram(codeOf(vector.program))).toEqual(
      vector.valid
        ? { valid: true }
        : { valid: false, address: vector.address, defect: vector.reason },
    );
  });
});

describe("VirtualMachine", () => {
  it("runs one instruction at a time and goes on later", () => {
    const machine = loaded("020107000000" + "0101" + "00");
    machine.startVM();
    expect(machine.execute(1)).toBe("running");
    expect(machine.programCounter).toBe(6);
    expect(machine.execute(1)).toBe("printed");
    expect(runUntilStop(machine, 10).step).toBe("halted");
  });

  it("returns after each block of a program without end", () => {
    // loop: ADDI R1, 1; JMP loop.
    const machine = loaded("100101000000" + "300000");
    machine.startVM();
    for (let block = 0; block < 3; ++block) {
      expect(machine.execute(64)).toBe("running");
    }
    expect(machine.registers[0]).toBe(96);
    expect(runUntilStop(machine, 1000).step).toBe("running");
  });

  it("empties the return stack when the program starts again", () => {
    // CALL 6; JMP 0; loop: ADDI R1, 1; JMP loop.
    const machine = loaded("340600" + "300000" + "100101000000" + "300600");
    machine.startVM();
    machine.execute(10);
    expect(machine.stackDepth).toBe(1);
    machine.startVM();
    expect([machine.stackDepth, machine.startCount]).toEqual([0, 2]);
  });
});

describe("stepInstruction", () => {
  it("starts the program and reads the value of each PRINT, as runUntilStop does", () => {
    const machine = loaded("020107000000" + "0101" + "00");
    expect(stepInstruction(machine)).toEqual({ step: "running", print: null });
    expect(stepInstruction(machine)).toEqual({
      step: "printed",
      print: { number: 1, register: 1, value: 7 },
    });
    expect(stepInstruction(machine)).toEqual({ step: "halted", print: null });
    expect(stepInstruction(machine).step).toBe("running");
    expect(machine.startCount).toBe(2);
  });
});

describe("VirtualMachine pins", () => {
  it("releases the pins when the program starts again or another one loads", () => {
    const pins = new SimulatedPinBank();
    // LOAD R1, 1; LOAD R2, 0; PINM R1, R2; PINW R1, R2; HALT: the white LED, pin 0, lights.
    const machine = loaded(
      "020101000000" + "020200000000" + "400102" + "420102" + "00",
      undefined,
      pins,
    );
    expect(runUntilStop(machine, 100).step).toBe("halted");
    expect(pins.states[0]).toMatchObject({
      gpio: { V2: 25, "V4.3": 35 },
      direction: "output",
      level: true,
    });
    machine.startVM();
    expect(pins.states[0]?.direction).toBeNull();
    runUntilStop(machine, 100);
    machine.load(codeOf("00"));
    expect(pins.states.every((state) => state.direction === null)).toBe(true);
  });

  it("never calls the bank for a number past the pins of the VM", () => {
    const pins = new SimulatedPinBank();
    // LOAD R2, 35; PINM R1, R2: a GPIO number is no pin of the VM.
    const machine = loaded("020223000000" + "400102", undefined, pins);
    expect(runUntilStop(machine, 10).step).toBe("faulted");
    expect(machine.fault).toBe("invalid_pin");
    expect(pins.states.every((state) => state.direction === null)).toBe(true);
  });
});

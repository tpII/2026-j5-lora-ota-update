/**
 * Reference interpreter of the node's virtual machine. It follows firmware/src/vm/virtual_machine.cpp
 * step by step, so that a program can be tried on the computer and the output of a node can be
 * checked against it: the same program with the same registers gives the same values.
 */
import {
  MAXIMUM_INSTRUCTIONS_PER_TICK,
  REGISTER_COUNT,
  instructionLength,
} from "./instruction-set.ts";

export const VM_FAULTS = [
  "division_by_zero",
  "instruction_limit",
  "end_of_program",
  "invalid_opcode",
  "invalid_register",
  "truncated_instruction",
] as const;
export type VmFault = (typeof VM_FAULTS)[number];

/** How a call to execute() ended. */
export type VmStep = "idle" | "running" | "printed" | "halted" | "faulted";

export type ProgramCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly address: number; readonly fault: VmFault };

export interface PrintedValue {
  readonly tick: number;
  /** From 1 to 4. */
  readonly register: number;
  readonly value: number;
}

export interface TickOutcome {
  readonly step: "halted" | "faulted";
  readonly prints: readonly PrintedValue[];
}

const REGISTER_FORM_BIT = 0x01;
const DIVIDE_IMMEDIATE = 0x16;
const MODULO_IMMEDIATE = 0x18;

function isRegisterOperand(operand: number | undefined): boolean {
  return operand !== undefined && operand >= 1 && operand <= REGISTER_COUNT;
}

/** Checks the instruction at `address` without running it. */
function checkInstruction(code: Uint8Array, address: number): VmFault | null {
  const length = instructionLength(code[address] ?? 0xff);
  if (length === 0) {
    return "invalid_opcode";
  }
  if (address + length > code.length) {
    return "truncated_instruction";
  }
  if (length >= 2 && !isRegisterOperand(code[address + 1])) {
    return "invalid_register";
  }
  if (length === 3 && !isRegisterOperand(code[address + 2])) {
    return "invalid_register";
  }
  return null;
}

/** Checks a whole program as the node does before accepting it. */
export function checkProgram(code: Uint8Array): ProgramCheck {
  for (let address = 0; address < code.length; ) {
    const fault = checkInstruction(code, address);
    if (fault !== null) {
      return { valid: false, address, fault };
    }
    address += instructionLength(code[address] ?? 0);
  }
  return { valid: true };
}

/** Wraps around in two's complement, as the firmware does. The divisor is never zero here. */
function applyOperation(operation: number, left: number, right: number): number {
  switch (operation) {
    case 0x10:
      return (left + right) | 0;
    case 0x12:
      return (left - right) | 0;
    case 0x14:
      return Math.imul(left, right);
    case 0x16:
      return Math.trunc(left / right) | 0;
    case 0x18:
      return left % right | 0;
    case 0x20:
      return left & right;
    case 0x22:
      return left | right;
    case 0x24:
      return left ^ right;
    case 0x26:
      return left << (right & 31);
    case 0x28:
      return left >> (right & 31);
    default:
      return left;
  }
}

export class VirtualMachine {
  readonly #instructionLimit: number;
  #program = new Uint8Array(0);
  readonly #registers = new Int32Array(REGISTER_COUNT);
  #programCounter = 0;
  #tickNumber = 0;
  #instructionCount = 0;
  #running = false;
  #printedRegister = 0;
  #fault: VmFault | null = null;
  #faultAddress = 0;

  constructor(instructionLimit = MAXIMUM_INSTRUCTIONS_PER_TICK) {
    this.#instructionLimit = instructionLimit;
  }

  /** Replaces the program, stops the tick in progress and restarts the tick count. */
  load(code: Uint8Array): ProgramCheck {
    const check = checkProgram(code);
    if (check.valid) {
      this.#program = code.slice();
      this.#programCounter = 0;
      this.#tickNumber = 0;
      this.#running = false;
      this.#fault = null;
    }
    return check;
  }

  setRegisters(values: readonly number[]): void {
    for (let index = 0; index < REGISTER_COUNT; ++index) {
      this.#registers[index] = values[index] ?? 0;
    }
  }

  get registers(): readonly number[] {
    return Array.from(this.#registers);
  }

  get programCounter(): number {
    return this.#programCounter;
  }

  get tickNumber(): number {
    return this.#tickNumber;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /** Register written by the last PRINT, from 1 to 4. */
  get printedRegister(): number {
    return this.#printedRegister;
  }

  get fault(): VmFault | null {
    return this.#fault;
  }

  get faultAddress(): number {
    return this.#faultAddress;
  }

  startTick(): void {
    if (this.#program.length === 0) {
      return;
    }
    this.#programCounter = 0;
    this.#instructionCount = 0;
    this.#fault = null;
    this.#tickNumber += 1;
    this.#running = true;
  }

  /** Runs at most `budget` instructions and stops early after a PRINT, at HALT or on a fault. */
  execute(budget: number): VmStep {
    if (!this.#running) {
      return "idle";
    }
    for (let step = 0; step < budget; ++step) {
      if (this.#instructionCount >= this.#instructionLimit) {
        return this.#stop("instruction_limit");
      }
      if (this.#programCounter >= this.#program.length) {
        return this.#stop("end_of_program");
      }
      const check = checkInstruction(this.#program, this.#programCounter);
      if (check !== null) {
        return this.#stop(check);
      }
      this.#instructionCount += 1;
      const address = this.#programCounter;
      const opcode = this.#program[address] ?? 0;
      const target = (this.#program[address + 1] ?? 1) - 1;
      const length = instructionLength(opcode);

      if (opcode === 0x00) {
        this.#running = false;
        return "halted";
      }
      if (opcode === 0x01) {
        this.#printedRegister = target + 1;
        this.#programCounter += length;
        return "printed";
      }
      const view = new DataView(this.#program.buffer, this.#program.byteOffset);
      if (opcode === 0x02) {
        this.#registers[target] = view.getInt32(address + 2, true);
      } else if (opcode === 0x2a) {
        this.#registers[target] = ~(this.#registers[target] ?? 0);
      } else {
        const registerForm = (opcode & REGISTER_FORM_BIT) !== 0;
        const source = registerForm
          ? (this.#registers[(this.#program[address + 2] ?? 1) - 1] ?? 0)
          : view.getInt32(address + 2, true);
        const operation = opcode & ~REGISTER_FORM_BIT;
        if (source === 0 && (operation === DIVIDE_IMMEDIATE || operation === MODULO_IMMEDIATE)) {
          return this.#stop("division_by_zero");
        }
        this.#registers[target] = applyOperation(operation, this.#registers[target] ?? 0, source);
      }
      this.#programCounter += length;
    }
    return "running";
  }

  #stop(fault: VmFault): VmStep {
    this.#running = false;
    this.#fault = fault;
    this.#faultAddress = this.#programCounter;
    return "faulted";
  }
}

/** Runs a whole tick, from a new start, and collects what it printed. */
export function runTick(machine: VirtualMachine): TickOutcome {
  machine.startTick();
  return finishTick(machine);
}

/** Runs the tick in progress to its end. */
export function finishTick(machine: VirtualMachine): TickOutcome {
  const prints: PrintedValue[] = [];
  for (;;) {
    const step = machine.execute(MAXIMUM_INSTRUCTIONS_PER_TICK + 1);
    if (step === "printed") {
      const register = machine.printedRegister;
      prints.push({
        tick: machine.tickNumber,
        register,
        value: machine.registers[register - 1] ?? 0,
      });
    } else if (step === "halted" || step === "faulted") {
      return { step, prints };
    } else if (step === "idle") {
      return { step: "halted", prints };
    }
  }
}

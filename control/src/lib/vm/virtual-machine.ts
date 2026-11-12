/**
 * Reference interpreter of the node's virtual machine. It follows firmware/src/vm/virtual_machine.cpp
 * step by step, so that a program can be tried on the computer and the output of a node can be
 * checked against it: the same program with the same registers gives the same values.
 */
import {
  REGISTER_COUNT,
  VM_MAXIMUM_INSTRUCTIONS_PER_TICK,
  type VM_FAULTS,
} from "$lib/protocol/protocol-contract.ts";
import { INSTRUCTION_BY_OPCODE, instructionLength, type Mnemonic } from "./instruction-set.ts";

/** Fault that ends a tick, with the names of the `vm_fault` event. */
export type VmFault = (typeof VM_FAULTS)[number];

/** How a call to execute() ended. */
export type VmStep = "idle" | "running" | "printed" | "halted" | "faulted";

export type ProgramCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly address: number; readonly fault: VmFault };

export interface PrintedValue {
  readonly tick: number;
  /** From 1 to REGISTER_COUNT. */
  readonly register: number;
  readonly value: number;
}

export interface TickOutcome {
  readonly step: "halted" | "faulted";
  readonly prints: readonly PrintedValue[];
}

type BinaryMnemonic = Exclude<Mnemonic, "HALT" | "PRINT" | "LOAD" | "NOT">;

type BinaryOperation = (left: number, right: number) => number;

/** Wraps around in two's complement, as the firmware does. The divisor is never zero here. */
const add: BinaryOperation = (left, right) => (left + right) | 0;
const subtract: BinaryOperation = (left, right) => (left - right) | 0;
const multiply: BinaryOperation = (left, right) => Math.imul(left, right);
const divide: BinaryOperation = (left, right) => Math.trunc(left / right) | 0;
const modulo: BinaryOperation = (left, right) => (left % right) | 0;
const and: BinaryOperation = (left, right) => left & right;
const or: BinaryOperation = (left, right) => left | right;
const exclusiveOr: BinaryOperation = (left, right) => left ^ right;
const shiftLeft: BinaryOperation = (left, right) => left << (right & 31);
const shiftRight: BinaryOperation = (left, right) => left >> (right & 31);

/**
 * The operation of every instruction that combines a register with an immediate or with another
 * register. An instruction added to the contract fails to compile here until it is given one.
 */
const BINARY_OPERATIONS: { readonly [Instruction in BinaryMnemonic]: BinaryOperation } = {
  ADDI: add,
  ADDR: add,
  SUBI: subtract,
  SUBR: subtract,
  MULI: multiply,
  MULR: multiply,
  DIVI: divide,
  DIVR: divide,
  MODI: modulo,
  MODR: modulo,
  ANDI: and,
  ANDR: and,
  ORI: or,
  ORR: or,
  XORI: exclusiveOr,
  XORR: exclusiveOr,
  SHLI: shiftLeft,
  SHLR: shiftLeft,
  SHRI: shiftRight,
  SHRR: shiftRight,
};

const DIVIDING_OPERATIONS: ReadonlySet<BinaryOperation> = new Set([divide, modulo]);

function isRegisterOperand(operand: number | undefined): boolean {
  return operand !== undefined && operand >= 1 && operand <= REGISTER_COUNT;
}

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
  for (let address = 0; address < code.length;) {
    const fault = checkInstruction(code, address);
    if (fault !== null) {
      return { valid: false, address, fault };
    }
    address += instructionLength(code[address] ?? 0);
  }
  return { valid: true };
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

  constructor(instructionLimit = VM_MAXIMUM_INSTRUCTIONS_PER_TICK) {
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

  /** Register written by the last PRINT, from 1 to REGISTER_COUNT. */
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
      // checkInstruction() has accepted the opcode.
      const instruction = INSTRUCTION_BY_OPCODE.get(this.#program[address] ?? 0);
      if (instruction === undefined) {
        return this.#stop("invalid_opcode");
      }
      const target = (this.#program[address + 1] ?? 1) - 1;
      const view = new DataView(this.#program.buffer, this.#program.byteOffset);
      switch (instruction.mnemonic) {
        case "HALT":
          this.#running = false;
          return "halted";
        case "PRINT":
          this.#printedRegister = target + 1;
          this.#programCounter += instructionLength(instruction.opcode);
          return "printed";
        case "LOAD":
          this.#registers[target] = view.getInt32(address + 2, true);
          break;
        case "NOT":
          this.#registers[target] = ~(this.#registers[target] ?? 0);
          break;
        default: {
          const operation = BINARY_OPERATIONS[instruction.mnemonic];
          const source =
            instruction.form === "register-register"
              ? (this.#registers[(this.#program[address + 2] ?? 1) - 1] ?? 0)
              : view.getInt32(address + 2, true);
          if (source === 0 && DIVIDING_OPERATIONS.has(operation)) {
            return this.#stop("division_by_zero");
          }
          this.#registers[target] = operation(this.#registers[target] ?? 0, source);
        }
      }
      this.#programCounter += instructionLength(instruction.opcode);
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

/** How a call to advance() ended, with the value of the register a PRINT wrote. */
export interface StepOutcome {
  readonly step: VmStep;
  readonly print: PrintedValue | null;
}

/** Runs at most `budget` instructions, as execute() does, and reads what a PRINT wrote. */
export function advance(machine: VirtualMachine, budget: number): StepOutcome {
  const step = machine.execute(budget);
  if (step !== "printed") {
    return { step, print: null };
  }
  const register = machine.printedRegister;
  return {
    step,
    print: { tick: machine.tickNumber, register, value: machine.registers[register - 1] ?? 0 },
  };
}

/** Runs one instruction, starting a new tick when none is in progress. */
export function stepInstruction(machine: VirtualMachine): StepOutcome {
  if (!machine.isRunning) {
    machine.startTick();
  }
  return advance(machine, 1);
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
    const { step, print } = advance(machine, VM_MAXIMUM_INSTRUCTIONS_PER_TICK + 1);
    if (print !== null) {
      prints.push(print);
    } else if (step === "halted" || step === "faulted") {
      return { step, prints };
    } else if (step === "idle") {
      return { step: "halted", prints };
    }
  }
}

/**
 * Reference interpreter of the node's virtual machine. It follows firmware/src/vm/virtual_machine.cpp
 * step by step, so that a program can be tried on the computer and the output of a node can be
 * checked against it: the same program with the same registers gives the same sequence of outputs.
 */
import {
  REGISTER_COUNT,
  RETURN_STACK_DEPTH,
  type PROGRAM_DEFECT_REASONS,
  type VM_FAULTS,
} from "$lib/protocol/protocol-contract.ts";
import {
  INSTRUCTION_BY_OPCODE,
  addressOffsetOfForm,
  instructionLength,
  registerCountOfForm,
  type Mnemonic,
} from "./instruction-set.ts";

/** Fault that stops the program, with the names of the `vm_fault` event. */
export type VmFault = (typeof VM_FAULTS)[number];

/** Why the node rejects a program before running it. */
export type ProgramDefect = (typeof PROGRAM_DEFECT_REASONS)[number];

/** How a call to execute() ended. */
export type VmStep = "idle" | "running" | "printed" | "sleeping" | "halted" | "faulted";

export type ProgramCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly address: number; readonly defect: ProgramDefect };

export interface PrintedValue {
  /** Number of the output since the program was loaded, from 1. */
  readonly number: number;
  /** From 1 to REGISTER_COUNT. */
  readonly register: number;
  readonly value: number;
}

export interface RunOutcome {
  /** "running" when the program reached the instruction limit of the call without stopping. */
  readonly step: "halted" | "faulted" | "running";
  readonly prints: readonly PrintedValue[];
}

type BinaryMnemonic = Exclude<
  Mnemonic,
  "HALT" | "PRINT" | "LOAD" | "SLEEP" | "NOT" | "JMP" | "JZ" | "JNZ" | "JNEG" | "CALL" | "RET"
>;

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

/** Checks the instruction at `address` without running it. */
function checkInstruction(code: Uint8Array, address: number): ProgramDefect | null {
  const instruction = INSTRUCTION_BY_OPCODE.get(code[address] ?? 0xff);
  if (instruction === undefined) {
    return "invalid_opcode";
  }
  if (address + instructionLength(instruction.opcode) > code.length) {
    return "truncated_instruction";
  }
  for (let operand = 1; operand <= registerCountOfForm(instruction.form); ++operand) {
    if (!isRegisterOperand(code[address + operand])) {
      return "invalid_register";
    }
  }
  return null;
}

/** Target address of the jump or call at `address`, or null for other instructions. */
function targetOf(code: Uint8Array, address: number): number | null {
  const instruction = INSTRUCTION_BY_OPCODE.get(code[address] ?? 0xff);
  const offset = instruction === undefined ? null : addressOffsetOfForm(instruction.form);
  if (offset === null) {
    return null;
  }
  return (code[address + offset] ?? 0) | ((code[address + offset + 1] ?? 0) << 8);
}

/**
 * Checks a whole program as the node does before accepting it: every instruction well formed and
 * every jump or call aimed at the start of an instruction.
 */
export function checkProgram(code: Uint8Array): ProgramCheck {
  const starts = new Set<number>();
  for (let address = 0; address < code.length;) {
    const defect = checkInstruction(code, address);
    if (defect !== null) {
      return { valid: false, address, defect };
    }
    starts.add(address);
    address += instructionLength(code[address] ?? 0);
  }
  for (const address of starts) {
    const target = targetOf(code, address);
    if (target !== null && !starts.has(target)) {
      return { valid: false, address, defect: "invalid_jump_target" };
    }
  }
  return { valid: true };
}

export class VirtualMachine {
  #program = new Uint8Array(0);
  readonly #registers = new Int32Array(REGISTER_COUNT);
  #programCounter = 0;
  readonly #returnStack: number[] = [];
  #startCount = 0;
  #printCount = 0;
  #running = false;
  #printedRegister = 0;
  #sleepMilliseconds = 0;
  #fault: VmFault | null = null;
  #faultAddress = 0;

  /** Replaces the program, stops it and restarts the start and output counts. */
  load(code: Uint8Array): ProgramCheck {
    const check = checkProgram(code);
    if (check.valid) {
      this.#program = code.slice();
      this.#programCounter = 0;
      this.#returnStack.length = 0;
      this.#startCount = 0;
      this.#printCount = 0;
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

  get stackDepth(): number {
    return this.#returnStack.length;
  }

  /** Times the program started from address 0 since it was loaded. */
  get startCount(): number {
    return this.#startCount;
  }

  /** Outputs since the program was loaded; after a PRINT, the number of that output. */
  get printCount(): number {
    return this.#printCount;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /** Register written by the last PRINT, from 1 to REGISTER_COUNT. */
  get printedRegister(): number {
    return this.#printedRegister;
  }

  /** Milliseconds that the last SLEEP asks to wait. */
  get sleepMilliseconds(): number {
    return this.#sleepMilliseconds;
  }

  get fault(): VmFault | null {
    return this.#fault;
  }

  get faultAddress(): number {
    return this.#faultAddress;
  }

  /** Starts the program from address 0 with an empty return stack. */
  startVM(): void {
    if (this.#program.length === 0) {
      return;
    }
    this.#programCounter = 0;
    this.#returnStack.length = 0;
    this.#fault = null;
    this.#startCount += 1;
    this.#running = true;
  }

  /**
   * Runs at most `budget` instructions and stops early after a PRINT or a SLEEP, at HALT or on a
   * fault. After a SLEEP the caller waits `sleepMilliseconds` before it calls execute() again.
   */
  execute(budget: number): VmStep {
    if (!this.#running) {
      return "idle";
    }
    for (let step = 0; step < budget; ++step) {
      if (this.#programCounter >= this.#program.length) {
        return this.#stop("end_of_program");
      }
      const address = this.#programCounter;
      // load() has accepted every instruction of the program.
      const instruction = INSTRUCTION_BY_OPCODE.get(this.#program[address] ?? 0);
      if (instruction === undefined) {
        return this.#stop("end_of_program");
      }
      const target = (this.#program[address + 1] ?? 1) - 1;
      const next = address + instructionLength(instruction.opcode);
      const view = new DataView(this.#program.buffer, this.#program.byteOffset);
      switch (instruction.mnemonic) {
        case "HALT":
          this.#running = false;
          return "halted";
        case "PRINT":
          this.#printedRegister = target + 1;
          this.#printCount += 1;
          this.#programCounter = next;
          return "printed";
        case "SLEEP":
          this.#sleepMilliseconds = view.getUint32(address + 1, true);
          this.#programCounter = next;
          return "sleeping";
        case "LOAD":
          this.#registers[target] = view.getInt32(address + 2, true);
          break;
        case "NOT":
          this.#registers[target] = ~(this.#registers[target] ?? 0);
          break;
        case "JMP":
          this.#programCounter = view.getUint16(address + 1, true);
          continue;
        case "JZ":
        case "JNZ":
        case "JNEG": {
          const value = this.#registers[target] ?? 0;
          const taken =
            instruction.mnemonic === "JZ"
              ? value === 0
              : instruction.mnemonic === "JNZ"
                ? value !== 0
                : value < 0;
          this.#programCounter = taken ? view.getUint16(address + 2, true) : next;
          continue;
        }
        case "CALL":
          if (this.#returnStack.length >= RETURN_STACK_DEPTH) {
            return this.#stop("stack_overflow");
          }
          this.#returnStack.push(next);
          this.#programCounter = view.getUint16(address + 1, true);
          continue;
        case "RET": {
          const returnAddress = this.#returnStack.pop();
          if (returnAddress === undefined) {
            return this.#stop("stack_underflow");
          }
          this.#programCounter = returnAddress;
          continue;
        }
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
      this.#programCounter = next;
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
    print: {
      number: machine.printCount,
      register,
      value: machine.registers[register - 1] ?? 0,
    },
  };
}

/** Runs one instruction, starting the program when it is stopped. */
export function stepInstruction(machine: VirtualMachine): StepOutcome {
  if (!machine.isRunning) {
    machine.startVM();
  }
  return advance(machine, 1);
}

/**
 * Runs the program until HALT or a fault, starting it first when it is stopped, and collects what
 * it printed; the waits of SLEEP pass at once. A program that runs on forever is cut after
 * `maximumInstructions`, so that a test or a simulated node never hangs; the node itself has no
 * such limit.
 */
export function runUntilStop(machine: VirtualMachine, maximumInstructions: number): RunOutcome {
  if (!machine.isRunning) {
    machine.startVM();
  }
  const prints: PrintedValue[] = [];
  for (let executed = 0; executed < maximumInstructions; ++executed) {
    const { step, print } = advance(machine, 1);
    if (print !== null) {
      prints.push(print);
    } else if (step === "halted" || step === "faulted") {
      return { step, prints };
    } else if (step === "idle") {
      return { step: "halted", prints };
    }
  }
  return { step: "running", prints };
}

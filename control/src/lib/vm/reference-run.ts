/**
 * A run of the reference interpreter over the program of the editor, driven tick by tick or
 * instruction by instruction: what the node is expected to print when it runs the same program from
 * the same registers. A change of program restarts the run, as a node does when it activates an
 * image.
 */
import { formatHex } from "$lib/utils/hex.ts";
import {
  VirtualMachine,
  finishTick,
  runTick,
  stepInstruction,
  type PrintedValue,
  type VmFault,
} from "./virtual-machine.ts";

const MAXIMUM_RECORDED_PRINTS = 100;

export interface ReferenceMachineState {
  readonly registers: readonly number[];
  readonly programCounter: number;
  readonly tick: number;
  readonly running: boolean;
  readonly fault: VmFault | null;
}

export interface ReferenceFault {
  readonly tick: number;
  readonly address: number;
  readonly reason: VmFault;
}

export interface ReferenceRunSnapshot {
  /** The program loaded, as the hexadecimal text of its code; null before the first run. */
  readonly loadedProgram: string | null;
  /** The machine after the last action; null before the first run. */
  readonly machine: ReferenceMachineState | null;
  /** Outputs in the order they happened, at most MAXIMUM_RECORDED_PRINTS. */
  readonly prints: readonly PrintedValue[];
  /** Kept until the next reset, as a node keeps its last fault while it runs the next ticks. */
  readonly lastFault: ReferenceFault | null;
  /** The tick that the last action ended at HALT, or null when it did not. */
  readonly haltedTick: number | null;
}

/**
 * True when the run has loaded a program and `code` is another one, or null because the editor
 * holds no valid program now.
 */
export function isStaleRun(snapshot: ReferenceRunSnapshot, code: Uint8Array | null): boolean {
  return (
    snapshot.loadedProgram !== null && (code === null || snapshot.loadedProgram !== formatHex(code))
  );
}

export class ReferenceRun {
  #machine = new VirtualMachine();
  #snapshot: ReferenceRunSnapshot = {
    loadedProgram: null,
    machine: null,
    prints: [],
    lastFault: null,
    haltedTick: null,
  };

  get snapshot(): ReferenceRunSnapshot {
    return this.#snapshot;
  }

  /** Loads `code` and the initial `registers` and forgets the outputs and the last fault. */
  reset(code: Uint8Array, registers: readonly number[]): void {
    this.#machine = new VirtualMachine();
    this.#machine.load(code);
    this.#machine.setRegisters(registers);
    this.#snapshot = {
      loadedProgram: formatHex(code),
      machine: null,
      prints: [],
      lastFault: null,
      haltedTick: null,
    };
    this.#record([], false);
  }

  /** Runs the tick in progress to its end, or a whole new tick. */
  tick(code: Uint8Array, registers: readonly number[]): void {
    this.#prepare(code, registers);
    const outcome = this.#machine.isRunning ? finishTick(this.#machine) : runTick(this.#machine);
    this.#record(outcome.prints, outcome.step === "halted");
  }

  /** Runs one instruction, starting a new tick when none is in progress. */
  step(code: Uint8Array, registers: readonly number[]): void {
    this.#prepare(code, registers);
    const outcome = stepInstruction(this.#machine);
    this.#record(outcome.print === null ? [] : [outcome.print], outcome.step === "halted");
  }

  #prepare(code: Uint8Array, registers: readonly number[]): void {
    if (this.#snapshot.loadedProgram === null || isStaleRun(this.#snapshot, code)) {
      this.reset(code, registers);
    }
  }

  #record(prints: readonly PrintedValue[], halted: boolean): void {
    const machine = this.#machine;
    this.#snapshot = {
      loadedProgram: this.#snapshot.loadedProgram,
      machine: {
        registers: machine.registers,
        programCounter: machine.programCounter,
        tick: machine.tickNumber,
        running: machine.isRunning,
        fault: machine.fault,
      },
      prints: [...this.#snapshot.prints, ...prints].slice(-MAXIMUM_RECORDED_PRINTS),
      lastFault:
        machine.fault === null
          ? this.#snapshot.lastFault
          : { tick: machine.tickNumber, address: machine.faultAddress, reason: machine.fault },
      haltedTick: halted ? machine.tickNumber : null,
    };
  }
}

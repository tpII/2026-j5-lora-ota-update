/**
 * A run of the reference interpreter over the program of the editor: what the node is expected to
 * print when it runs the same program from the same registers. It runs as the node does, without
 * end and in blocks, with the wait that follows each PRINT, the waits of SLEEP and the restart from
 * address 0 after HALT or a fault, or one instruction at a time without waits. The caller gives the
 * time, so the run has no clock of its own. A change of program restarts the run, as a node does
 * when it activates an image.
 */
import {
  VM_INSTRUCTIONS_PER_POLL,
  VM_MINIMUM_PRINT_INTERVAL_MILLISECONDS,
  VM_RESTART_DELAY_MILLISECONDS,
} from "$lib/protocol/protocol-contract.ts";
import { formatHex } from "$lib/utils/hex.ts";
import {
  VirtualMachine,
  advance,
  stepInstruction,
  type PrintedValue,
  type StepOutcome,
  type VmFault,
} from "./virtual-machine.ts";

const MAXIMUM_RECORDED_PRINTS = 100;

/** Blocks that one call to run() executes at most, so that a loop without waits leaves the page alive. */
const MAXIMUM_BLOCKS_PER_CALL = 300;

/** Why the program is stopped: at HALT or on a fault. */
export type StopCause = "halt" | "fault";

export interface ReferenceMachineState {
  readonly registers: readonly number[];
  readonly programCounter: number;
  /** Times the program started from address 0 since it was loaded. */
  readonly starts: number;
  /** Outputs since the program was loaded. */
  readonly outputs: number;
  readonly stackDepth: number;
  readonly running: boolean;
  readonly fault: VmFault | null;
}

export interface ReferenceFault {
  /** Start of the program that ended in the fault. */
  readonly starts: number;
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
  /** Kept until the next reset, as a node keeps its last fault while the program starts again. */
  readonly lastFault: ReferenceFault | null;
  /** Why the program is stopped, or null while it runs or before it first starts. */
  readonly stopCause: StopCause | null;
  /** Time until which run() executes nothing: after a PRINT, during a SLEEP or before a restart. */
  readonly resumeAt: number;
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

const EMPTY_SNAPSHOT: ReferenceRunSnapshot = {
  loadedProgram: null,
  machine: null,
  prints: [],
  lastFault: null,
  stopCause: null,
  resumeAt: 0,
};

export class ReferenceRun {
  #machine = new VirtualMachine();
  #snapshot: ReferenceRunSnapshot = EMPTY_SNAPSHOT;

  get snapshot(): ReferenceRunSnapshot {
    return this.#snapshot;
  }

  /** Loads `code` and the initial `registers` and forgets the outputs and the last fault. */
  reset(code: Uint8Array, registers: readonly number[]): void {
    this.#machine = new VirtualMachine();
    this.#machine.load(code);
    this.#machine.setRegisters(registers);
    this.#snapshot = { ...EMPTY_SNAPSHOT, loadedProgram: formatHex(code) };
    this.#record([], null, 0);
  }

  /**
   * Prepares a continuous run at `now`: a stopped program starts at once, since the operator asks
   * for it, and no earlier wait holds it back.
   */
  start(code: Uint8Array, registers: readonly number[], now: number): void {
    this.#prepare(code, registers);
    if (!this.#machine.isRunning) {
      this.#machine.startVM();
    }
    this.#record([], null, now);
  }

  /**
   * Runs the program as the node would up to `now`: blocks of VM_INSTRUCTIONS_PER_POLL
   * instructions until a wait begins, and a new start once the restart delay after HALT or a fault
   * has passed.
   */
  run(code: Uint8Array, registers: readonly number[], now: number): void {
    this.#prepare(code, registers);
    const prints: PrintedValue[] = [];
    let stopCause = this.#snapshot.stopCause;
    let resumeAt = this.#snapshot.resumeAt;
    for (let block = 0; block < MAXIMUM_BLOCKS_PER_CALL && now >= resumeAt; block += 1) {
      if (!this.#machine.isRunning) {
        this.#machine.startVM();
        stopCause = null;
      }
      const outcome = advance(this.#machine, VM_INSTRUCTIONS_PER_POLL);
      if (outcome.print !== null) {
        prints.push(outcome.print);
      }
      ({ stopCause, resumeAt } = this.#waitAfter(outcome, now, stopCause, resumeAt));
    }
    this.#record(prints, stopCause, resumeAt);
  }

  /** Runs one instruction without waits, starting the program when it is stopped. */
  step(code: Uint8Array, registers: readonly number[], now: number): void {
    this.#prepare(code, registers);
    const outcome = stepInstruction(this.#machine);
    const after = this.#waitAfter(outcome, now, null, now);
    this.#record(outcome.print === null ? [] : [outcome.print], after.stopCause, after.resumeAt);
  }

  #prepare(code: Uint8Array, registers: readonly number[]): void {
    if (this.#snapshot.loadedProgram === null || isStaleRun(this.#snapshot, code)) {
      this.reset(code, registers);
    }
  }

  /** The wait that the node takes after the step, and why the program stopped, if it did. */
  #waitAfter(
    outcome: StepOutcome,
    now: number,
    stopCause: StopCause | null,
    resumeAt: number,
  ): { readonly stopCause: StopCause | null; readonly resumeAt: number } {
    switch (outcome.step) {
      case "printed":
        return { stopCause, resumeAt: now + VM_MINIMUM_PRINT_INTERVAL_MILLISECONDS };
      case "sleeping":
        return { stopCause, resumeAt: now + this.#machine.sleepMilliseconds };
      case "halted":
        return { stopCause: "halt", resumeAt: now + VM_RESTART_DELAY_MILLISECONDS };
      case "faulted":
        return { stopCause: "fault", resumeAt: now + VM_RESTART_DELAY_MILLISECONDS };
      case "idle":
      case "running":
        return { stopCause, resumeAt };
    }
  }

  #record(prints: readonly PrintedValue[], stopCause: StopCause | null, resumeAt: number): void {
    const machine = this.#machine;
    this.#snapshot = {
      loadedProgram: this.#snapshot.loadedProgram,
      machine: {
        registers: machine.registers,
        programCounter: machine.programCounter,
        starts: machine.startCount,
        outputs: machine.printCount,
        stackDepth: machine.stackDepth,
        running: machine.isRunning,
        fault: machine.fault,
      },
      prints: [...this.#snapshot.prints, ...prints].slice(-MAXIMUM_RECORDED_PRINTS),
      lastFault:
        machine.fault === null
          ? this.#snapshot.lastFault
          : { starts: machine.startCount, address: machine.faultAddress, reason: machine.fault },
      stopCause: machine.isRunning ? null : stopCause,
      resumeAt,
    };
  }
}

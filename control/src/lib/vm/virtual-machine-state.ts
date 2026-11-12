/**
 * The virtual machine of a node as its console reports it: the program it runs (`vm`, `program`),
 * the values it prints (`vm_print`) and its faults (`vm_fault`). The active version itself is kept
 * by the update state (nodes/node-update-state.ts).
 */
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import { REGISTER_COUNT } from "$lib/protocol/protocol-contract.ts";
import { appendBounded } from "$lib/utils/bounded-log.ts";
import type { VmFault } from "./virtual-machine.ts";

const MAXIMUM_VM_PRINTS = 100;

/** The node's virtual machine, from its `vm` events and the values printed since. */
export interface VirtualMachineStatus {
  readonly size: number;
  /** Times the program started from address 0 since its activation. */
  readonly starts: number;
  /** R1 to R(REGISTER_COUNT). A PRINT updates the register it shows. */
  readonly registers: readonly number[];
  readonly hostTime: number;
}

export interface VirtualMachinePrintRecord {
  readonly hostTime: number;
  /** Number of the output since the activation, from 1. */
  readonly number: number;
  readonly register: number;
  readonly value: number;
}

export interface VirtualMachineFaultRecord {
  readonly hostTime: number;
  /** Start of the program that ended in the fault. */
  readonly starts: number;
  readonly address: number;
  readonly reason: VmFault;
}

/** The active program, as the `program` command returned it. */
export interface ProgramRecord {
  readonly hostTime: number;
  /** Version of the program when the node returned it; the active version may have changed since. */
  readonly version: number;
  readonly size: number;
  /** Two lowercase hexadecimal digits per byte; empty with version 0. */
  readonly code: string;
}

export interface VirtualMachineState {
  /** Null until the node boots or reports it with `vm`, after `status` or a load. */
  readonly virtualMachine: VirtualMachineStatus | null;
  /** Newest last. */
  readonly virtualMachinePrints: readonly VirtualMachinePrintRecord[];
  readonly lastVirtualMachineFault: VirtualMachineFaultRecord | null;
  /** Reason of the last fault since the last activation, as the HELLO byte `vm` carries it. */
  readonly faultSinceActivation: VmFault | null;
  readonly program: ProgramRecord | null;
}

export const INITIAL_VIRTUAL_MACHINE_STATE: VirtualMachineState = {
  virtualMachine: null,
  virtualMachinePrints: [],
  lastVirtualMachineFault: null,
  faultSinceActivation: null,
  program: null,
};

export function reduceVirtualMachine<State extends VirtualMachineState>(
  state: State,
  event: ConsoleEvent,
  hostTime: number,
): State {
  switch (event.ev) {
    case "boot":
      // The active program is not kept across reboots: the node returns to the factory program.
      return {
        ...state,
        virtualMachine: {
          size: 0,
          starts: 0,
          registers: Array.from({ length: REGISTER_COUNT }, () => 0),
          hostTime,
        },
        lastVirtualMachineFault: null,
        faultSinceActivation: null,
        program: null,
      };
    case "vm":
      return {
        ...state,
        virtualMachine: {
          size: event.size,
          starts: event.starts,
          registers: [...event.registers],
          hostTime,
        },
      };
    case "vm_print": {
      const record: VirtualMachinePrintRecord = {
        hostTime,
        number: event.n,
        register: event.reg,
        value: event.value,
      };
      const previous = state.virtualMachine;
      return {
        ...state,
        virtualMachine:
          previous === null
            ? null
            : {
                ...previous,
                registers: previous.registers.map((value, index) =>
                  index === event.reg - 1 ? event.value : value,
                ),
                hostTime,
              },
        virtualMachinePrints: appendBounded(state.virtualMachinePrints, record, MAXIMUM_VM_PRINTS),
      };
    }
    case "vm_fault":
      return {
        ...state,
        lastVirtualMachineFault: {
          hostTime,
          starts: event.starts,
          address: event.pc,
          reason: event.reason,
        },
        faultSinceActivation: event.reason,
      };
    case "activation":
      return { ...state, faultSinceActivation: null };
    case "program":
      return {
        ...state,
        program: { hostTime, version: event.version, size: event.size, code: event.code },
      };
    default:
      return state;
  }
}

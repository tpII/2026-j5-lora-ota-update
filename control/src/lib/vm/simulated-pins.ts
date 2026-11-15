/**
 * GPIO pins for the VM on the computer, for the reference interpreter and the simulated nodes. The
 * pins are those of the VM, from 0, the same on every board model; the contract gives the GPIO of
 * each one on each board. The operator, or a test, sets what the circuit puts on each pin; the bank
 * keeps how the program configured each pin and the level it wrote on each output.
 */
import { VM_PIN_COUNT, VM_PINS, type BOARD_MODELS } from "$lib/protocol/protocol-contract.ts";
import type { PinBank, PinDirection } from "./virtual-machine.ts";

export type VmBoardModel = (typeof BOARD_MODELS)[number];

export interface PinState {
  /** Number of the pin in the VM, from 0. */
  readonly pin: number;
  /** GPIO of the pin on each board model. */
  readonly gpio: Readonly<Record<VmBoardModel, number>>;
  /** How the program configured the pin, or null while it is unconfigured. */
  readonly direction: PinDirection | null;
  /** What PINR reads: the circuit on an input or an unconfigured pin, the program on an output. */
  readonly level: boolean;
  /** What the circuit puts on the pin. */
  readonly circuitLevel: boolean;
}

/** GPIO of the pin of the VM on each board model. */
function gpioOf(pin: number): Readonly<Record<VmBoardModel, number>> {
  return { V2: VM_PINS.V2[pin] ?? 0, "V4.3": VM_PINS["V4.3"][pin] ?? 0 };
}

export class SimulatedPinBank implements PinBank {
  readonly #circuitLevels: Map<number, boolean>;
  readonly #directions = new Map<number, PinDirection>();
  readonly #outputLevels = new Map<number, boolean>();

  /** `circuitLevels` gives what the circuit puts on each pin of the VM, low otherwise. */
  constructor(circuitLevels: ReadonlyMap<number, boolean> = new Map()) {
    this.#circuitLevels = new Map(circuitLevels);
  }

  setCircuitLevel(pin: number, high: boolean): void {
    this.#circuitLevels.set(pin, high);
  }

  configure(pin: number, direction: PinDirection): void {
    this.#directions.set(pin, direction);
  }

  read(pin: number): boolean {
    return this.#directions.get(pin) === "output"
      ? (this.#outputLevels.get(pin) ?? false)
      : (this.#circuitLevels.get(pin) ?? false);
  }

  write(pin: number, high: boolean): void {
    this.#outputLevels.set(pin, high);
  }

  release(pin: number): void {
    this.#directions.delete(pin);
    this.#outputLevels.delete(pin);
  }

  /** Every pin of the VM, from 0. */
  get states(): readonly PinState[] {
    return Array.from({ length: VM_PIN_COUNT }, (_, pin) => ({
      pin,
      gpio: gpioOf(pin),
      direction: this.#directions.get(pin) ?? null,
      level: this.read(pin),
      circuitLevel: this.#circuitLevels.get(pin) ?? false,
    }));
  }
}

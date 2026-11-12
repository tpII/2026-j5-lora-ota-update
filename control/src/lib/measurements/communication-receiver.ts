/**
 * Communication test, receiver side: the operator of the neighbor activates it before the sender
 * starts and deactivates it after the sender ends. While active, the node keeps its HELLO messages
 * held and uses the agreed modulation; it answers the echoes on its own, as every node does, and
 * the panel records each `echo_served`. Deactivating puts the radio settings and the HELLO
 * messages back as they were.
 */
import { CommunicationTestSession } from "./communication-test-session.ts";
import type { ConsoleEvent, NodeIdentifier } from "$lib/console/console-event.ts";
import { servedEchoOf, type ServedEcho } from "$lib/nodes/echo-records.ts";
import type { NodePort } from "$lib/nodes/node-port.ts";
import { MAXIMUM_PRESENCE_HOLD_SECONDS } from "$lib/protocol/protocol-contract.ts";
import type { Modulation, RadioSettings } from "$lib/radio/radio-settings.ts";
import { SYSTEM_TIME_SOURCE, type TimeSource } from "$lib/utils/time-source.ts";

/** The longest hold the firmware accepts; the panel renews it halfway through. */
export const RECEIVER_PRESENCE_HOLD_SECONDS = MAXIMUM_PRESENCE_HOLD_SECONDS;
export const HOLD_RENEWAL_INTERVAL_MILLISECONDS = (RECEIVER_PRESENCE_HOLD_SECONDS * 1000) / 2;

export type ReceiverModeStatus = "activating" | "active" | "deactivating" | "inactive" | "failed";

export const RECEIVER_MODE_STATUS_LABELS: { readonly [Status in ReceiverModeStatus]: string } = {
  activating: "Suspendiendo los HELLO y aplicando la modulación",
  active: "Activo: responde ecos",
  deactivating: "Restableciendo la radio y los HELLO",
  inactive: "Desactivado",
  failed: "No se pudo activar",
};

/** True from the activation of receiver mode until its deactivation ends. */
export function isReceiverModeActive(snapshot: { readonly status: ReceiverModeStatus }): boolean {
  const status = snapshot.status;
  return status === "activating" || status === "active" || status === "deactivating";
}

export interface ReceiverModeSnapshot {
  readonly status: ReceiverModeStatus;
  readonly node: NodeIdentifier;
  readonly modulation: Modulation;
  /** Radio settings of the node before activating, which deactivating puts back. */
  readonly previousRadio: RadioSettings;
  readonly servedEchoes: readonly ServedEcho[];
  readonly activationHostTime: number;
  readonly deactivationHostTime: number | null;
  /** Explanation of a failed activation or of a failed hold renewal, in Spanish. */
  readonly failure: string | null;
  /** Whether the node confirmed its radio settings and HELLO back; null before trying. */
  readonly restored: boolean | null;
  readonly restorationProblems: readonly string[];
}

export interface CommunicationReceiverOptions {
  readonly node: NodePort;
  /** Radio settings the node reported before activating. */
  readonly radio: RadioSettings;
  readonly modulation: Modulation;
  readonly timeSource?: TimeSource;
  readonly onChange?: (snapshot: ReceiverModeSnapshot) => void;
}

export class CommunicationReceiver {
  readonly #node: NodePort;
  readonly #radio: RadioSettings;
  readonly #modulation: Modulation;
  readonly #timeSource: TimeSource;
  readonly #session: CommunicationTestSession;
  readonly #onChange: ((snapshot: ReceiverModeSnapshot) => void) | undefined;
  readonly #activationHostTime: number;
  #status: ReceiverModeStatus = "inactive";
  #servedEchoes: ServedEcho[] = [];
  #deactivationHostTime: number | null = null;
  #failure: string | null = null;
  #restored: boolean | null = null;
  #restorationProblems: string[] = [];
  #unsubscribe: (() => void) | null = null;
  #cancelRenewal: (() => void) | null = null;
  #snapshot: ReceiverModeSnapshot;

  constructor(options: CommunicationReceiverOptions) {
    this.#node = options.node;
    this.#radio = options.radio;
    this.#modulation = options.modulation;
    this.#timeSource = options.timeSource ?? SYSTEM_TIME_SOURCE;
    this.#session = new CommunicationTestSession(options.node, options.radio, this.#timeSource);
    this.#onChange = options.onChange;
    this.#activationHostTime = this.#timeSource.now();
    this.#snapshot = this.#buildSnapshot();
  }

  get snapshot(): ReceiverModeSnapshot {
    return this.#snapshot;
  }

  /** Holds the HELLO and applies the modulation; on failure, puts the node back as it was. */
  async activate(): Promise<ReceiverModeSnapshot> {
    if (this.#status !== "inactive" || this.#deactivationHostTime !== null) {
      throw new Error(`receiver mode cannot activate from status ${this.#status}`);
    }
    this.#status = "activating";
    this.#publish();
    const failure = await this.#session.prepare(this.#modulation, RECEIVER_PRESENCE_HOLD_SECONDS);
    if (failure !== null) {
      this.#failure = failure;
      await this.#restore();
      this.#status = "failed";
      this.#publish();
      return this.#snapshot;
    }
    this.#unsubscribe = this.#node.subscribe((event, hostTime) =>
      this.#acceptEvent(event, hostTime),
    );
    this.#scheduleRenewal();
    this.#status = "active";
    this.#publish();
    return this.#snapshot;
  }

  /** Puts back the radio settings and the HELLO messages of the node. */
  async deactivate(): Promise<ReceiverModeSnapshot> {
    if (this.#status !== "active") {
      return this.#snapshot;
    }
    this.#status = "deactivating";
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#cancelRenewal?.();
    this.#cancelRenewal = null;
    this.#publish();
    await this.#restore();
    this.#status = "inactive";
    this.#publish();
    return this.#snapshot;
  }

  async #restore(): Promise<void> {
    this.#restorationProblems = await this.#session.restore();
    this.#restored = this.#restorationProblems.length === 0;
    this.#deactivationHostTime = this.#timeSource.now();
  }

  /** Renews the hold, so that a long session does not bring the HELLO back on its own. */
  #scheduleRenewal(): void {
    this.#cancelRenewal = this.#timeSource.schedule(() => {
      void this.#session.renewHold(RECEIVER_PRESENCE_HOLD_SECONDS).then((problem) => {
        if (this.#status !== "active") {
          return;
        }
        this.#failure = problem === null ? null : `No se pudo renovar la suspensión: ${problem}`;
        this.#publish();
      });
      this.#scheduleRenewal();
    }, HOLD_RENEWAL_INTERVAL_MILLISECONDS);
  }

  #acceptEvent(event: ConsoleEvent, hostTime: number): void {
    if (this.#status !== "active" || event.ev !== "echo_served") {
      return;
    }
    this.#servedEchoes.push(servedEchoOf(event, hostTime));
    this.#publish();
  }

  #publish(): void {
    this.#snapshot = this.#buildSnapshot();
    this.#onChange?.(this.#snapshot);
  }

  #buildSnapshot(): ReceiverModeSnapshot {
    return {
      status: this.#status,
      node: this.#node.identifier,
      modulation: this.#modulation,
      previousRadio: this.#radio,
      servedEchoes: [...this.#servedEchoes],
      activationHostTime: this.#activationHostTime,
      deactivationHostTime: this.#deactivationHostTime,
      failure: this.#failure,
      restored: this.#restored,
      restorationProblems: [...this.#restorationProblems],
    };
  }
}

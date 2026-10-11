/**
 * Communication test, receiver side: the operator of the neighbor activates it before the sender
 * starts and deactivates it after the sender ends. While active, the node keeps its HELLO messages
 * held and uses the agreed modulation; it answers the echoes on its own, as every node does, and
 * the panel records each `echo_served`. Deactivating puts the radio settings and the HELLO
 * messages back as they were.
 */
import type { CampaignNode } from "./capacity-test-campaign.ts";
import {
  DEFAULT_CONFIRMATION_TIMEOUT_MILLISECONDS,
  applyModulation,
  holdPresence,
  restoreNode,
  type Modulation,
} from "./command-confirmation.ts";
import { MAXIMUM_PRESENCE_HOLD_SECONDS } from "$lib/console/console-command.ts";
import type { ConsoleEvent, NodeIdentifier } from "$lib/console/console-event.ts";
import type { RadioSettings } from "$lib/radio/radio-settings.ts";
import { SYSTEM_TIME_SOURCE, type TimeSource } from "$lib/utils/time-source.ts";

/** The longest hold the firmware accepts; the panel renews it well before it expires. */
export const RECEIVER_PRESENCE_HOLD_SECONDS = MAXIMUM_PRESENCE_HOLD_SECONDS;
export const HOLD_RENEWAL_INTERVAL_MILLISECONDS = 30 * 60_000;

export type ReceiverModeStatus = "activating" | "active" | "deactivating" | "inactive" | "failed";

/** One echo the node answered while in receiver mode. */
export interface ServedEcho {
  readonly source: NodeIdentifier;
  readonly number: number;
  readonly size: number;
  /** Quality of the request as this node received it. */
  readonly rssi: number;
  readonly snr: number;
  readonly hostTime: number;
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
  readonly node: CampaignNode;
  /** Radio settings the node reported before activating. */
  readonly radio: RadioSettings;
  readonly modulation: Modulation;
  readonly timeSource?: TimeSource;
  readonly confirmationTimeoutMilliseconds?: number;
  readonly onChange?: (snapshot: ReceiverModeSnapshot) => void;
}

export class CommunicationReceiver {
  readonly #node: CampaignNode;
  readonly #radio: RadioSettings;
  readonly #modulation: Modulation;
  readonly #timeSource: TimeSource;
  readonly #confirmationTimeout: number;
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
    this.#confirmationTimeout =
      options.confirmationTimeoutMilliseconds ?? DEFAULT_CONFIRMATION_TIMEOUT_MILLISECONDS;
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
    const held = await holdPresence(
      this.#node,
      RECEIVER_PRESENCE_HOLD_SECONDS,
      this.#timeSource,
      this.#confirmationTimeout,
    );
    const modulated =
      held === null
        ? await applyModulation(
            this.#node,
            this.#modulation,
            this.#timeSource,
            this.#confirmationTimeout,
          )
        : null;
    if (held !== null || modulated !== null) {
      this.#failure =
        held !== null
          ? `No se pudieron suspender los HELLO: ${held}`
          : `No se pudo aplicar la modulación de la prueba: ${modulated}`;
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
    const { sf, bw, cr } = this.#radio;
    this.#restorationProblems = await restoreNode(
      this.#node,
      { sf, bw, cr },
      this.#timeSource,
      this.#confirmationTimeout,
    );
    this.#restored = this.#restorationProblems.length === 0;
    this.#deactivationHostTime = this.#timeSource.now();
  }

  /** Renews the hold, so that a long session does not bring the HELLO back on its own. */
  #scheduleRenewal(): void {
    this.#cancelRenewal = this.#timeSource.schedule(() => {
      void holdPresence(
        this.#node,
        RECEIVER_PRESENCE_HOLD_SECONDS,
        this.#timeSource,
        this.#confirmationTimeout,
      ).then((problem) => {
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
    this.#servedEchoes.push({
      source: event.src,
      number: event.n,
      size: event.size,
      rssi: event.rssi,
      snr: event.snr,
      hostTime,
    });
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

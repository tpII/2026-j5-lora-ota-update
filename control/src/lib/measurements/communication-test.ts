/**
 * Communication test, sender side: on the one node the panel reaches, holds the HELLO messages,
 * sets the modulation agreed with the operator of the neighbor, asks the neighbor for a series of
 * echoes of the minimum length and then puts the radio settings and the HELLO messages back as
 * they were. The neighbor answers in receiver mode (communication-receiver.ts). Every echo yields
 * the link quality in both directions; the metrics are in communication-test-metrics.ts.
 */
import type { CampaignNode } from "./capacity-test-campaign.ts";
import {
  DEFAULT_CONFIRMATION_TIMEOUT_MILLISECONDS,
  applyModulation,
  holdPresence,
  restoreNode,
} from "./command-confirmation.ts";
import { EchoSeries } from "./echo-series.ts";
import { MAXIMUM_PRESENCE_HOLD_SECONDS, MINIMUM_ECHO_SIZE } from "$lib/console/console-command.ts";
import type { ConsoleEvent, NodeIdentifier } from "$lib/console/console-event.ts";
import {
  BANDWIDTHS_KILOHERTZ,
  CODING_RATE_DENOMINATORS,
  SPREADING_FACTORS,
  timeOnAirFor,
  type BandwidthKilohertz,
  type RadioSettings,
} from "$lib/radio/radio-settings.ts";
import { computeFrameLength } from "$lib/radio/time-on-air.ts";
import { SYSTEM_TIME_SOURCE, type TimeSource } from "$lib/utils/time-source.ts";

/** Echoes carry the shortest body the firmware accepts. */
export const COMMUNICATION_TEST_PAYLOAD_SIZE = MINIMUM_ECHO_SIZE;
export const DEFAULT_COMMUNICATION_TEST_COUNT = 100;
export const MAXIMUM_COMMUNICATION_TEST_COUNT = 1000;

/** Pause of the panel between the result of one echo and the next request. */
const ECHO_PAUSE_MILLISECONDS = 200;
/** Console latency and processing on both nodes, per echo, for the estimates. */
const ECHO_OVERHEAD_MILLISECONDS = 50;
/** The firmware declares an echo lost after twice the time on air plus this margin. */
const ECHO_LOSS_MARGIN_MILLISECONDS = 1000;
/** Margin of the HELLO hold over the worst case, for the preparation and the restoration. */
const PRESENCE_HOLD_MARGIN_MILLISECONDS = 60_000;
/** Wait after both nodes confirmed the modulation, before the first echo. */
const SETTLING_MILLISECONDS = 300;

export interface CommunicationTestConfiguration {
  readonly sf: number;
  readonly bw: BandwidthKilohertz;
  readonly cr: number;
  readonly count: number;
}

export const DEFAULT_COMMUNICATION_TEST_CONFIGURATION: CommunicationTestConfiguration = {
  sf: 7,
  bw: 500,
  cr: 5,
  count: DEFAULT_COMMUNICATION_TEST_COUNT,
};

/** Time on air of one echo frame, request or reply, in microseconds. */
export function echoTimeOnAirMicroseconds(
  configuration: Pick<CommunicationTestConfiguration, "sf" | "bw" | "cr">,
  preamble: number,
): number {
  return timeOnAirFor(computeFrameLength(COMMUNICATION_TEST_PAYLOAD_SIZE), {
    ...configuration,
    preamble,
  });
}

/** Expected duration of the series when every echo is answered. */
export function estimateCommunicationTestMilliseconds(
  configuration: CommunicationTestConfiguration,
  preamble: number,
): number {
  const roundTrip = (2 * echoTimeOnAirMicroseconds(configuration, preamble)) / 1000;
  return (
    configuration.count * (roundTrip + ECHO_OVERHEAD_MILLISECONDS + ECHO_PAUSE_MILLISECONDS) +
    SETTLING_MILLISECONDS
  );
}

/** Seconds of the HELLO hold: enough for a series in which every echo is lost. */
export function presenceHoldSecondsFor(
  configuration: CommunicationTestConfiguration,
  preamble: number,
): number {
  const roundTrip = (2 * echoTimeOnAirMicroseconds(configuration, preamble)) / 1000;
  const worstCase =
    configuration.count *
      (roundTrip +
        ECHO_LOSS_MARGIN_MILLISECONDS +
        ECHO_OVERHEAD_MILLISECONDS +
        ECHO_PAUSE_MILLISECONDS) +
    PRESENCE_HOLD_MARGIN_MILLISECONDS;
  return Math.ceil(worstCase / 1000);
}

/** Problems of a configuration, in Spanish; empty when it can run. */
export function validateCommunicationTestConfiguration(
  configuration: CommunicationTestConfiguration,
  preamble: number,
): string[] {
  const problems: string[] = [];
  if (!(SPREADING_FACTORS as readonly number[]).includes(configuration.sf)) {
    problems.push("El factor de dispersión va de 7 a 12.");
  }
  if (!(BANDWIDTHS_KILOHERTZ as readonly number[]).includes(configuration.bw)) {
    problems.push("El ancho de banda es de 125, 250 o 500 kHz.");
  }
  if (!(CODING_RATE_DENOMINATORS as readonly number[]).includes(configuration.cr)) {
    problems.push("La tasa de código va de 4/5 a 4/8.");
  }
  if (
    !Number.isInteger(configuration.count) ||
    configuration.count < 1 ||
    configuration.count > MAXIMUM_COMMUNICATION_TEST_COUNT
  ) {
    problems.push(`La cantidad de ecos va de 1 a ${MAXIMUM_COMMUNICATION_TEST_COUNT}.`);
  }
  if (
    problems.length === 0 &&
    presenceHoldSecondsFor(configuration, preamble) > MAXIMUM_PRESENCE_HOLD_SECONDS
  ) {
    problems.push(
      "En el peor caso la prueba supera la hora que admite la suspensión de los HELLO: " +
        "conviene pedir menos ecos o usar una modulación más rápida.",
    );
  }
  return problems;
}

export type CommunicationTestStatus =
  | "ready"
  | "preparing"
  | "measuring"
  | "restoring"
  | "finished"
  | "stopped"
  | "failed";

/** One echo of the series. */
export type EchoExchange =
  | {
      readonly outcome: "answered";
      readonly number: number;
      readonly hostTime: number;
      readonly roundTripMicroseconds: number;
      /** Quality of the request as the responder received it. */
      readonly forwardRssi: number;
      readonly forwardSnr: number;
      /** Quality of the reply as the requester received it. */
      readonly reverseRssi: number;
      readonly reverseSnr: number;
    }
  | {
      readonly outcome: "lost";
      readonly number: number;
      readonly hostTime: number;
    };

/** What the test ran with: the channel of the node, the modulation chosen and the series. */
export interface CommunicationTestSettings {
  readonly freq: number;
  readonly preamble: number;
  readonly sync: number;
  readonly sf: number;
  readonly bw: number;
  readonly cr: number;
  readonly size: number;
  readonly count: number;
}

export interface CommunicationTestSnapshot {
  readonly status: CommunicationTestStatus;
  readonly requester: NodeIdentifier;
  readonly responder: NodeIdentifier;
  readonly settings: CommunicationTestSettings;
  /** Radio settings of the requester before the test, which the restoration puts back. */
  readonly requesterRadio: RadioSettings;
  readonly exchanges: readonly EchoExchange[];
  readonly startHostTime: number | null;
  readonly endHostTime: number | null;
  /** Explanation of a failure, in Spanish. */
  readonly failure: string | null;
  /** Whether the node confirmed its radio settings and HELLO back; null before trying. */
  readonly restored: boolean | null;
  readonly restorationProblems: readonly string[];
}

export interface CommunicationTestOptions {
  /** The connected node, which sends the echoes. */
  readonly node: CampaignNode;
  /** Radio settings the node reported before the test. */
  readonly radio: RadioSettings;
  /** Neighbor that answers the echoes; its operator sets the same modulation by hand. */
  readonly destination: NodeIdentifier;
  readonly configuration: CommunicationTestConfiguration;
  readonly timeSource?: TimeSource;
  readonly confirmationTimeoutMilliseconds?: number;
  readonly echoPauseMilliseconds?: number;
  readonly onChange?: (snapshot: CommunicationTestSnapshot) => void;
}

/**
 * The sender side of the test, on the one node the panel reaches. The neighbor must already be in
 * receiver mode with the same modulation (communication-receiver.ts).
 */
export class CommunicationTest {
  readonly #node: CampaignNode;
  readonly #radio: RadioSettings;
  readonly #destination: NodeIdentifier;
  readonly #configuration: CommunicationTestConfiguration;
  readonly #settings: CommunicationTestSettings;
  readonly #timeSource: TimeSource;
  readonly #confirmationTimeout: number;
  readonly #echoPause: number;
  readonly #onChange: ((snapshot: CommunicationTestSnapshot) => void) | undefined;
  #status: CommunicationTestStatus = "ready";
  #exchanges: EchoExchange[] = [];
  #startHostTime: number | null = null;
  #endHostTime: number | null = null;
  #failure: string | null = null;
  #restored: boolean | null = null;
  #restorationProblems: string[] = [];
  #stopRequested = false;
  #series: EchoSeries | null = null;
  #snapshot: CommunicationTestSnapshot;

  constructor(options: CommunicationTestOptions) {
    const destination = options.destination.trim().toUpperCase();
    if (options.node.identifier === destination) {
      throw new Error("the destination must be another node");
    }
    this.#node = options.node;
    this.#radio = options.radio;
    this.#destination = destination;
    this.#configuration = options.configuration;
    this.#settings = {
      freq: options.radio.freq,
      preamble: options.radio.preamble,
      sync: options.radio.sync,
      sf: options.configuration.sf,
      bw: options.configuration.bw,
      cr: options.configuration.cr,
      size: COMMUNICATION_TEST_PAYLOAD_SIZE,
      count: options.configuration.count,
    };
    this.#timeSource = options.timeSource ?? SYSTEM_TIME_SOURCE;
    this.#confirmationTimeout =
      options.confirmationTimeoutMilliseconds ?? DEFAULT_CONFIRMATION_TIMEOUT_MILLISECONDS;
    this.#echoPause = options.echoPauseMilliseconds ?? ECHO_PAUSE_MILLISECONDS;
    this.#onChange = options.onChange;
    this.#snapshot = this.#buildSnapshot();
  }

  get snapshot(): CommunicationTestSnapshot {
    return this.#snapshot;
  }

  /** Runs the test; whatever happens, it tries to leave the node as it found it. */
  async run(): Promise<CommunicationTestSnapshot> {
    if (this.#status !== "ready") {
      throw new Error(`communication test cannot start from status ${this.#status}`);
    }
    this.#startHostTime = this.#timeSource.now();
    this.#status = "preparing";
    this.#publish();
    const unsubscribe = this.#node.subscribe((event, hostTime) =>
      this.#acceptEvent(event, hostTime),
    );
    let outcome: "finished" | "stopped" | "failed";
    try {
      outcome = await this.#prepareAndMeasure();
    } catch (error) {
      this.#failure = error instanceof Error ? error.message : String(error);
      outcome = "failed";
    } finally {
      unsubscribe();
    }
    this.#status = "restoring";
    this.#publish();
    const { sf, bw, cr } = this.#radio;
    this.#restorationProblems = await restoreNode(
      this.#node,
      { sf, bw, cr },
      this.#timeSource,
      this.#confirmationTimeout,
    );
    this.#restored = this.#restorationProblems.length === 0;
    this.#status = outcome;
    this.#endHostTime = this.#timeSource.now();
    this.#publish();
    return this.#snapshot;
  }

  /** Ends the series after the echo in course; the restoration still runs. */
  stop(): void {
    if (this.#status === "ready") {
      this.#status = "stopped";
      this.#publish();
      return;
    }
    if (this.#stopRequested || (this.#status !== "preparing" && this.#status !== "measuring")) {
      return;
    }
    this.#stopRequested = true;
    this.#series?.stop();
  }

  async #prepareAndMeasure(): Promise<"finished" | "stopped" | "failed"> {
    const held = await holdPresence(
      this.#node,
      presenceHoldSecondsFor(this.#configuration, this.#radio.preamble),
      this.#timeSource,
      this.#confirmationTimeout,
    );
    if (held !== null) {
      return this.#fail(`No se pudieron suspender los HELLO: ${held}`);
    }
    if (this.#stopRequested) {
      return "stopped";
    }

    const { sf, bw, cr } = this.#configuration;
    const modulated = await applyModulation(
      this.#node,
      { sf, bw, cr },
      this.#timeSource,
      this.#confirmationTimeout,
    );
    if (modulated !== null) {
      return this.#fail(`No se pudo aplicar la modulación de la prueba: ${modulated}`);
    }
    if (this.#stopRequested) {
      return "stopped";
    }
    await this.#sleep(SETTLING_MILLISECONDS);

    this.#status = "measuring";
    this.#publish();
    const series = new EchoSeries({
      node: this.#node,
      destination: this.#destination,
      size: COMMUNICATION_TEST_PAYLOAD_SIZE,
      count: this.#configuration.count,
      pauseMilliseconds: this.#echoPause,
      timeSource: this.#timeSource,
    });
    this.#series = series;
    if (this.#stopRequested) {
      series.stop();
    }
    const result = await series.run();
    this.#series = null;
    if (result.status === "failed") {
      return this.#fail(result.failure ?? "La serie de ecos falló.");
    }
    return result.status === "finished" ? "finished" : "stopped";
  }

  #acceptEvent(event: ConsoleEvent, hostTime: number): void {
    if (this.#status !== "measuring") {
      return;
    }
    if (event.ev === "echo" && event.dst === this.#destination) {
      this.#exchanges.push({
        outcome: "answered",
        number: event.n,
        hostTime,
        roundTripMicroseconds: event.rtt,
        forwardRssi: event.remote_rssi,
        forwardSnr: event.remote_snr,
        reverseRssi: event.rssi,
        reverseSnr: event.snr,
      });
      this.#publish();
    } else if (event.ev === "echo_lost" && event.dst === this.#destination) {
      this.#exchanges.push({ outcome: "lost", number: event.n, hostTime });
      this.#publish();
    }
  }

  #fail(failure: string): "failed" {
    this.#failure = failure;
    return "failed";
  }

  #sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.#timeSource.schedule(resolve, milliseconds);
    });
  }

  #publish(): void {
    this.#snapshot = this.#buildSnapshot();
    this.#onChange?.(this.#snapshot);
  }

  #buildSnapshot(): CommunicationTestSnapshot {
    return {
      status: this.#status,
      requester: this.#node.identifier,
      responder: this.#destination,
      settings: this.#settings,
      requesterRadio: this.#radio,
      exchanges: [...this.#exchanges],
      startHostTime: this.#startHostTime,
      endHostTime: this.#endHostTime,
      failure: this.#failure,
      restored: this.#restored,
      restorationProblems: [...this.#restorationProblems],
    };
  }
}

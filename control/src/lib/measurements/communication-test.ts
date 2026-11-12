/**
 * Communication test, sender side: on the one node the panel reaches, holds the HELLO messages,
 * sets the modulation agreed with the operator of the neighbor, asks the neighbor for a series of
 * echoes of the minimum length and then puts the radio settings and the HELLO messages back as
 * they were. The neighbor answers in receiver mode (communication-receiver.ts). Every echo yields
 * the link quality in both directions; the metrics are in communication-test-metrics.ts.
 */
import { CommunicationTestSession } from "./communication-test-session.ts";
import {
  EchoSeries,
  MAXIMUM_ECHO_SERIES_COUNT,
  MINIMUM_ECHO_SERIES_COUNT,
  type EchoSeriesSnapshot,
} from "./echo-series.ts";
import { buildRadioSetCommand, normalizeNodeIdentifier } from "$lib/commands/console-command.ts";
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import type { EchoResult } from "$lib/nodes/echo-records.ts";
import type { NodePort } from "$lib/nodes/node-port.ts";
import {
  DEFAULT_CODING_RATE_DENOMINATOR,
  DEFAULT_SPREADING_FACTOR,
  MAXIMUM_PRESENCE_HOLD_SECONDS,
  MINIMUM_ECHO_SIZE,
  ON_AIR_BANDWIDTH_KILOHERTZ,
  echoLossDeadlineMilliseconds,
} from "$lib/protocol/protocol-contract.ts";
import type { Modulation, RadioSettings, SupportedModulation } from "$lib/radio/radio-settings.ts";
import { timeOnAirOfPayload } from "$lib/radio/time-on-air.ts";
import { SYSTEM_TIME_SOURCE, type TimeSource } from "$lib/utils/time-source.ts";

/** Echoes carry the shortest body the firmware accepts. */
export const COMMUNICATION_TEST_PAYLOAD_SIZE = MINIMUM_ECHO_SIZE;
export const MINIMUM_COMMUNICATION_TEST_COUNT = MINIMUM_ECHO_SERIES_COUNT;
export const DEFAULT_COMMUNICATION_TEST_COUNT = 100;
export const MAXIMUM_COMMUNICATION_TEST_COUNT = MAXIMUM_ECHO_SERIES_COUNT;

/** Pause of the panel between the result of one echo and the next request. */
const ECHO_PAUSE_MILLISECONDS = 200;
/** Console latency and processing on both nodes, per echo, for the estimates. */
const ECHO_OVERHEAD_MILLISECONDS = 50;
/** Margin of the HELLO hold over the worst case, for the preparation and the restoration. */
const PRESENCE_HOLD_MARGIN_MILLISECONDS = 60_000;
/** Wait after both nodes confirmed the modulation, before the first echo. */
const SETTLING_MILLISECONDS = 300;

/** The modulation both operators agree on and the number of echoes. */
export interface CommunicationTestConfiguration extends SupportedModulation {
  readonly count: number;
}

export const DEFAULT_COMMUNICATION_TEST_CONFIGURATION: CommunicationTestConfiguration = {
  sf: DEFAULT_SPREADING_FACTOR,
  bw: ON_AIR_BANDWIDTH_KILOHERTZ,
  cr: DEFAULT_CODING_RATE_DENOMINATOR,
  count: DEFAULT_COMMUNICATION_TEST_COUNT,
};

/** Time on air of one echo frame, request or reply, in microseconds. */
export function echoTimeOnAirMicroseconds(modulation: Modulation, preamble: number): number {
  return timeOnAirOfPayload(COMMUNICATION_TEST_PAYLOAD_SIZE, { ...modulation, preamble });
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
  const lossDeadline = echoLossDeadlineMilliseconds(
    echoTimeOnAirMicroseconds(configuration, preamble),
  );
  const worstCase =
    configuration.count * (lossDeadline + ECHO_OVERHEAD_MILLISECONDS + ECHO_PAUSE_MILLISECONDS) +
    PRESENCE_HOLD_MARGIN_MILLISECONDS;
  return Math.ceil(worstCase / 1000);
}

/** Problems of a configuration, in Spanish; empty when it can run. */
export function validateCommunicationTestConfiguration(
  configuration: CommunicationTestConfiguration,
  preamble: number,
): string[] {
  const { sf, bw, cr } = configuration;
  const radio = buildRadioSetCommand({ sf, bw, cr }, null);
  const problems = radio.valid ? [] : radio.problems.map((problem) => problem.message);
  if (
    !Number.isInteger(configuration.count) ||
    configuration.count < MINIMUM_COMMUNICATION_TEST_COUNT ||
    configuration.count > MAXIMUM_COMMUNICATION_TEST_COUNT
  ) {
    problems.push(
      `La cantidad de ecos va de ${MINIMUM_COMMUNICATION_TEST_COUNT} a ${MAXIMUM_COMMUNICATION_TEST_COUNT}.`,
    );
  }
  if (
    problems.length === 0 &&
    presenceHoldSecondsFor(configuration, preamble) > MAXIMUM_PRESENCE_HOLD_SECONDS
  ) {
    problems.push(
      `En el peor caso la prueba supera los ${MAXIMUM_PRESENCE_HOLD_SECONDS / 60} minutos que admite la suspensión de los HELLO: ` +
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

export const COMMUNICATION_TEST_STATUS_LABELS: {
  readonly [Status in CommunicationTestStatus]: string;
} = {
  ready: "Lista para empezar",
  preparing: "Suspendiendo los HELLO y aplicando la modulación",
  measuring: "Enviando ecos",
  restoring: "Restableciendo la radio y los HELLO",
  finished: "Terminada",
  stopped: "Detenida",
  failed: "Falló",
};

/** True from the start of the test until the radio and the HELLO of the node are restored. */
export function isCommunicationTestActive(snapshot: {
  readonly status: CommunicationTestStatus;
}): boolean {
  const status = snapshot.status;
  return status === "preparing" || status === "measuring" || status === "restoring";
}

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
  /** The `echo` and `echo_lost` of the series, oldest first. */
  readonly exchanges: readonly EchoResult[];
  /** Share of the echoes of the series already requested and settled, from 0 to 1. */
  readonly progress: number;
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
  readonly node: NodePort;
  /** Radio settings the node reported before the test. */
  readonly radio: RadioSettings;
  /** Neighbor that answers the echoes; its operator sets the same modulation by hand. */
  readonly destination: NodeIdentifier;
  readonly configuration: CommunicationTestConfiguration;
  readonly timeSource?: TimeSource;
  readonly onChange?: (snapshot: CommunicationTestSnapshot) => void;
}

/**
 * The sender side of the test, on the one node the panel reaches. The neighbor must already be in
 * receiver mode with the same modulation (communication-receiver.ts).
 */
export class CommunicationTest {
  readonly #node: NodePort;
  readonly #radio: RadioSettings;
  readonly #destination: NodeIdentifier;
  readonly #configuration: CommunicationTestConfiguration;
  readonly #settings: CommunicationTestSettings;
  readonly #timeSource: TimeSource;
  readonly #session: CommunicationTestSession;
  readonly #onChange: ((snapshot: CommunicationTestSnapshot) => void) | undefined;
  readonly #stopController = new AbortController();
  #status: CommunicationTestStatus = "ready";
  #exchanges: readonly EchoResult[] = [];
  /** Echoes of the series that settled: answered, reported lost or without any result in time. */
  #requested = 0;
  #startHostTime: number | null = null;
  #endHostTime: number | null = null;
  #failure: string | null = null;
  #restored: boolean | null = null;
  #restorationProblems: string[] = [];
  #series: EchoSeries | null = null;
  #snapshot: CommunicationTestSnapshot;

  constructor(options: CommunicationTestOptions) {
    const destination = normalizeNodeIdentifier(options.destination);
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
    this.#session = new CommunicationTestSession(options.node, options.radio, this.#timeSource);
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
    let outcome: "finished" | "stopped" | "failed";
    try {
      outcome = await this.#prepareAndMeasure();
    } catch (error) {
      this.#failure = error instanceof Error ? error.message : String(error);
      outcome = "failed";
    }
    this.#status = "restoring";
    this.#publish();
    this.#restorationProblems = await this.#session.restore();
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
    if (
      this.#stopController.signal.aborted ||
      (this.#status !== "preparing" && this.#status !== "measuring")
    ) {
      return;
    }
    this.#stopController.abort();
    this.#series?.stop();
  }

  async #prepareAndMeasure(): Promise<"finished" | "stopped" | "failed"> {
    const stopSignal = this.#stopController.signal;
    const { sf, bw, cr } = this.#configuration;
    const modulation: Modulation = { sf, bw, cr };
    const prepared = await this.#session.prepare(
      modulation,
      presenceHoldSecondsFor(this.#configuration, this.#radio.preamble),
      stopSignal,
    );
    if (prepared !== null) {
      return this.#fail(prepared);
    }
    if (stopSignal.aborted) {
      return "stopped";
    }
    await this.#timeSource.wait(SETTLING_MILLISECONDS, stopSignal);
    if (stopSignal.aborted) {
      return "stopped";
    }

    this.#status = "measuring";
    this.#publish();
    const series = new EchoSeries({
      node: this.#node,
      destination: this.#destination,
      size: COMMUNICATION_TEST_PAYLOAD_SIZE,
      count: this.#configuration.count,
      radio: { ...modulation, preamble: this.#radio.preamble },
      pauseMilliseconds: ECHO_PAUSE_MILLISECONDS,
      timeSource: this.#timeSource,
      onChange: (snapshot) => this.#acceptSeries(snapshot),
    });
    this.#series = series;
    const result = await series.run();
    this.#series = null;
    if (result.status === "failed") {
      return this.#fail(result.failure ?? "La serie de ecos falló.");
    }
    return result.status === "finished" ? "finished" : "stopped";
  }

  #acceptSeries(snapshot: EchoSeriesSnapshot): void {
    if (
      snapshot.requested !== this.#requested ||
      snapshot.results.length !== this.#exchanges.length
    ) {
      this.#requested = snapshot.requested;
      this.#exchanges = snapshot.results;
      this.#publish();
    }
  }

  #fail(failure: string): "failed" {
    this.#failure = failure;
    return "failed";
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
      exchanges: this.#exchanges,
      progress:
        this.#settings.count === 0 ? 0 : Math.min(1, this.#requested / this.#settings.count),
      startHostTime: this.#startHostTime,
      endHostTime: this.#endHostTime,
      failure: this.#failure,
      restored: this.#restored,
      restorationProblems: [...this.#restorationProblems],
    };
  }
}

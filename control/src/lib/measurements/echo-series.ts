/**
 * A series of echoes from one node to another, one at a time as the firmware requires: each
 * request waits for its `echo` or `echo_lost` before the next one goes out. A single echo is a
 * series of one.
 */
import { buildEchoCommand, normalizeNodeIdentifier } from "$lib/commands/console-command.ts";
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import { echoResultOf, isEchoResultEvent, type EchoResult } from "$lib/nodes/echo-records.ts";
import {
  CommandFailure,
  describeCommandFailureSentence,
  retryWhileBusy,
  sendAndAwait,
  type NodePort,
} from "$lib/nodes/node-port.ts";
import {
  DEFAULT_ECHO_SIZE,
  echoLossDeadlineMilliseconds,
} from "$lib/protocol/protocol-contract.ts";
import { timeOnAirOfPayload, type TimeOnAirSettings } from "$lib/radio/time-on-air.ts";
import { SYSTEM_TIME_SOURCE, type TimeSource } from "$lib/utils/time-source.ts";

/**
 * The firmware starts the loss deadline of an echo when the request goes on air: before that the
 * request may wait in the transmission queue behind other frames, and the result still has to
 * cross the console. Without a result within the loss deadline plus this margin, the panel counts
 * the request as lost.
 */
const RESULT_MARGIN_MILLISECONDS = 5000;
const DEFAULT_PAUSE_MILLISECONDS = 200;

export const MINIMUM_ECHO_SERIES_COUNT = 1;
export const MAXIMUM_ECHO_SERIES_COUNT = 1000;

export type EchoSeriesStatus = "ready" | "running" | "stopping" | "stopped" | "finished" | "failed";

/** How the panel reports the status after the counts of a series: "…; terminada." */
export const ECHO_SERIES_STATUS_LABELS: { readonly [Status in EchoSeriesStatus]: string } = {
  ready: "sin empezar",
  running: "en curso",
  stopping: "se detiene al terminar el eco en curso",
  stopped: "detenida",
  finished: "terminada",
  failed: "falló",
};

/** True from the first request of the series until its last echo settles. */
export function isEchoSeriesActive(snapshot: { readonly status: EchoSeriesStatus }): boolean {
  return snapshot.status === "running" || snapshot.status === "stopping";
}

export interface EchoSeriesSnapshot {
  readonly status: EchoSeriesStatus;
  readonly destination: NodeIdentifier;
  readonly requested: number;
  readonly answered: number;
  /** Echoes the node reported lost and requests without any result in time. */
  readonly lost: number;
  readonly total: number;
  /** The `echo` and `echo_lost` the node reported for the requests of the series, oldest first. */
  readonly results: readonly EchoResult[];
  /** Explanation of a failure, in Spanish. */
  readonly failure: string | null;
}

export interface EchoSeriesOptions {
  readonly node: NodePort;
  readonly destination: NodeIdentifier;
  /** Body length; the firmware uses DEFAULT_ECHO_SIZE when absent. */
  readonly size?: number;
  readonly count: number;
  /** Radio settings of the node while the series runs, for the loss deadline of each echo. */
  readonly radio: TimeOnAirSettings;
  /** Pause between the result of one echo and the next request. */
  readonly pauseMilliseconds?: number;
  readonly timeSource?: TimeSource;
  readonly onChange?: (snapshot: EchoSeriesSnapshot) => void;
}

/**
 * How one request ended: with the result the node reported, without any result in time, or with
 * the request refused by the node or never sent, which ends the series.
 */
type Outcome =
  | { readonly kind: "reported"; readonly result: EchoResult }
  | { readonly kind: "unreported" }
  | { readonly kind: "refused" | "unsent"; readonly failure: CommandFailure };

export class EchoSeries {
  readonly #node: NodePort;
  readonly #destination: NodeIdentifier;
  readonly #size: number | undefined;
  readonly #count: number;
  readonly #resultTimeout: number;
  readonly #pause: number;
  readonly #timeSource: TimeSource;
  readonly #onChange: ((snapshot: EchoSeriesSnapshot) => void) | undefined;
  readonly #stopController = new AbortController();
  #status: EchoSeriesStatus = "ready";
  #requested = 0;
  #answered = 0;
  #lost = 0;
  #results: EchoResult[] = [];
  #failure: string | null = null;

  constructor(options: EchoSeriesOptions) {
    this.#node = options.node;
    this.#destination = normalizeNodeIdentifier(options.destination);
    this.#size = options.size;
    this.#count = options.count;
    this.#resultTimeout =
      echoLossDeadlineMilliseconds(
        timeOnAirOfPayload(options.size ?? DEFAULT_ECHO_SIZE, options.radio),
      ) + RESULT_MARGIN_MILLISECONDS;
    this.#pause = options.pauseMilliseconds ?? DEFAULT_PAUSE_MILLISECONDS;
    this.#timeSource = options.timeSource ?? SYSTEM_TIME_SOURCE;
    this.#onChange = options.onChange;
  }

  get snapshot(): EchoSeriesSnapshot {
    return {
      status: this.#status,
      destination: this.#destination,
      requested: this.#requested,
      answered: this.#answered,
      lost: this.#lost,
      total: this.#count,
      results: [...this.#results],
      failure: this.#failure,
    };
  }

  async run(): Promise<EchoSeriesSnapshot> {
    if (this.#status !== "ready") {
      throw new Error(`echo series cannot start from status ${this.#status}`);
    }
    const command = buildEchoCommand(this.#destination, this.#size);
    if (!command.valid) {
      return this.#end("failed", command.problems.map((problem) => problem.message).join(" "));
    }
    this.#status = "running";
    this.#publish();
    const stopSignal = this.#stopController.signal;
    while (this.#requested < this.#count && this.#status === "running") {
      const outcome = await this.#requestEcho(command.command);
      if (outcome === null) {
        break;
      }
      if (outcome.kind === "refused" || outcome.kind === "unsent") {
        return this.#end("failed", describeCommandFailureSentence(outcome.failure));
      }
      this.#requested += 1;
      if (outcome.kind === "reported") {
        this.#results.push(outcome.result);
      }
      if (outcome.kind === "reported" && outcome.result.outcome === "answered") {
        this.#answered += 1;
      } else {
        this.#lost += 1;
      }
      this.#publish();
      if (this.#requested < this.#count && this.#pause > 0) {
        await this.#timeSource.wait(this.#pause, stopSignal);
      }
    }
    return this.#end(this.#status === "running" ? "finished" : "stopped", null);
  }

  /** Ends the series; the echo in course still counts. */
  stop(): void {
    if (this.#status === "running") {
      this.#status = "stopping";
      this.#publish();
      this.#stopController.abort();
    } else if (this.#status === "ready") {
      this.#end("stopped", null);
    }
  }

  /**
   * Sends one request, repeating it while the node is busy; null when the series was stopped
   * between two attempts. Stopping does not cut short the wait for the result.
   */
  async #requestEcho(command: string): Promise<Outcome | null> {
    try {
      const { event, hostTime } = await retryWhileBusy(
        () =>
          sendAndAwait(
            this.#node,
            command,
            (event) => isEchoResultEvent(event, this.#destination),
            { timeSource: this.#timeSource, timeoutMilliseconds: this.#resultTimeout },
          ),
        this.#timeSource,
        this.#stopController.signal,
      );
      return { kind: "reported", result: echoResultOf(event, hostTime) };
    } catch (error) {
      if (!(error instanceof CommandFailure)) {
        throw error;
      }
      switch (error.kind) {
        case "cancelled":
          return null;
        case "timeout":
          return { kind: "unreported" };
        case "refused":
        case "unsent":
          return { kind: error.kind, failure: error };
      }
    }
  }

  #end(status: EchoSeriesStatus, failure: string | null): EchoSeriesSnapshot {
    this.#status = status;
    this.#failure = failure;
    this.#publish();
    return this.snapshot;
  }

  #publish(): void {
    this.#onChange?.(this.snapshot);
  }
}

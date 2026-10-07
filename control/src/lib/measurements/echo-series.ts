/**
 * A series of echoes from one node to another, one at a time as the firmware requires: each
 * request waits for its `echo` or `echo_lost` before the next one goes out.
 */
import type { CampaignNode } from "./capacity-test-campaign.ts";
import { buildEchoCommand } from "$lib/console/console-command.ts";
import type { ConsoleEvent, NodeIdentifier } from "$lib/console/console-event.ts";
import { SYSTEM_TIME_SOURCE, type TimeSource } from "$lib/utils/time-source.ts";

/**
 * The firmware reports `echo_lost` after twice the time on air plus one second; without any answer
 * from the node within this time, the request counts as lost.
 */
const RESULT_TIMEOUT_MILLISECONDS = 10_000;
const BUSY_RETRY_DELAY_MILLISECONDS = 500;
const MAXIMUM_BUSY_RETRIES = 4;
const DEFAULT_PAUSE_MILLISECONDS = 200;

export type EchoSeriesStatus = "ready" | "running" | "stopping" | "stopped" | "finished" | "failed";

export interface EchoSeriesSnapshot {
  readonly status: EchoSeriesStatus;
  readonly destination: NodeIdentifier;
  readonly requested: number;
  readonly answered: number;
  readonly lost: number;
  readonly total: number;
  /** Explanation of a failure, in Spanish. */
  readonly failure: string | null;
}

export interface EchoSeriesOptions {
  readonly node: CampaignNode;
  readonly destination: NodeIdentifier;
  /** Body length; the firmware uses 16 bytes when absent. */
  readonly size?: number;
  readonly count: number;
  /** Pause between the result of one echo and the next request. */
  readonly pauseMilliseconds?: number;
  readonly timeSource?: TimeSource;
  readonly onChange?: (snapshot: EchoSeriesSnapshot) => void;
}

type Outcome =
  | { readonly kind: "answered" }
  | { readonly kind: "lost" }
  | { readonly kind: "refused"; readonly reason: string; readonly detail: string | null };

export class EchoSeries {
  readonly #node: CampaignNode;
  readonly #destination: NodeIdentifier;
  readonly #size: number | undefined;
  readonly #count: number;
  readonly #pause: number;
  readonly #timeSource: TimeSource;
  readonly #onChange: ((snapshot: EchoSeriesSnapshot) => void) | undefined;
  #status: EchoSeriesStatus = "ready";
  #requested = 0;
  #answered = 0;
  #lost = 0;
  #failure: string | null = null;
  #interruptPause: (() => void) | null = null;

  constructor(options: EchoSeriesOptions) {
    this.#node = options.node;
    this.#destination = options.destination.trim().toUpperCase();
    this.#size = options.size;
    this.#count = options.count;
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
    while (this.#requested < this.#count && this.#status === "running") {
      const outcome = await this.#requestEcho(command.command);
      if (outcome === null) {
        break;
      }
      if (outcome.kind === "refused") {
        const detail = outcome.detail === null ? "" : `: ${outcome.detail}`;
        return this.#end("failed", `El nodo rechazó el eco (${outcome.reason}${detail}).`);
      }
      this.#requested += 1;
      if (outcome.kind === "answered") {
        this.#answered += 1;
      } else {
        this.#lost += 1;
      }
      this.#publish();
      if (this.#requested < this.#count && this.#pause > 0) {
        await this.#sleep(this.#pause);
      }
    }
    return this.#end(this.#status === "running" ? "finished" : "stopped", null);
  }

  /** Ends the series; the echo in course still counts. */
  stop(): void {
    if (this.#status === "running") {
      this.#status = "stopping";
      this.#publish();
      this.#interruptPause?.();
    } else if (this.#status === "ready") {
      this.#end("stopped", null);
    }
  }

  /** Sends one request, repeating it while the node is busy; null when the series was stopped. */
  async #requestEcho(command: string): Promise<Outcome | null> {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.#sendAndWait(command);
      const busy = outcome.kind === "refused" && outcome.reason === "busy";
      if (!busy || attempt >= MAXIMUM_BUSY_RETRIES) {
        return outcome;
      }
      await this.#sleep(BUSY_RETRY_DELAY_MILLISECONDS);
      if (this.#status !== "running") {
        return null;
      }
    }
  }

  #sendAndWait(command: string): Promise<Outcome> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: Outcome): void => {
        if (!settled) {
          settled = true;
          unsubscribe();
          cancelTimer();
          resolve(outcome);
        }
      };
      const unsubscribe = this.#node.subscribe((event: ConsoleEvent) => {
        if ((event.ev === "echo" || event.ev === "echo_lost") && event.dst === this.#destination) {
          finish({ kind: event.ev === "echo" ? "answered" : "lost" });
        } else if (event.ev === "error" && event.cmd === "echo") {
          finish({ kind: "refused", reason: event.reason, detail: event.detail ?? null });
        }
      });
      const cancelTimer = this.#timeSource.schedule(
        () => finish({ kind: "lost" }),
        RESULT_TIMEOUT_MILLISECONDS,
      );
      this.#node.sendCommand(command).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        finish({ kind: "refused", reason: "send_failure", detail: message });
      });
    });
  }

  #sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        cancel();
        this.#interruptPause = null;
        resolve();
      };
      const cancel = this.#timeSource.schedule(wake, milliseconds);
      this.#interruptPause = wake;
    });
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

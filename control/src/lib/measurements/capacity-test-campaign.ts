/**
 * Runs a capacity test over two nodes: for each point of the plan it sets the same radio settings
 * on both, waits until both confirm them, has the sender transmit a run and waits for the report
 * of the receiver. Points that fail are marked and the campaign continues with the next one.
 */
import {
  RUN_STOP_COMMAND,
  buildRadioSetCommand,
  buildRunCommand,
} from "$lib/console/console-command.ts";
import type { ConsoleEvent, NodeIdentifier, RunEndEvent } from "$lib/console/console-event.ts";
import {
  CAPACITY_TEST_INTERVAL,
  estimatePointDurationMilliseconds,
  estimateTransmissionMilliseconds,
  pointTimeOnAirMicroseconds,
  type CapacityTestPoint,
} from "./capacity-test-plan.ts";
import { frequenciesMatch } from "$lib/radio/radio-settings.ts";
import { receptionGraceMilliseconds } from "./test-run-ledger.ts";
import { SYSTEM_TIME_SOURCE, type TimeSource } from "$lib/utils/time-source.ts";

/** A connected node as the campaign sees it. */
export interface CampaignNode {
  readonly identifier: NodeIdentifier;
  sendCommand(command: string): Promise<void>;
  /** Receives every event of the node; returns the function that ends the subscription. */
  subscribe(listener: (event: ConsoleEvent, hostTime: number) => void): () => void;
}

export type PointStatus =
  | "pending"
  | "configuring"
  | "transmitting"
  | "completed"
  | "failed"
  | "stopped";

export interface PointResult {
  readonly point: CapacityTestPoint;
  readonly status: PointStatus;
  /** Run number assigned by the sender. */
  readonly run: number | null;
  /** Packets the receiver reported, 0 when it heard none. */
  readonly received: number | null;
  /** Explanation of a failure, in Spanish. */
  readonly failure: string | null;
  readonly startHostTime: number | null;
  readonly endHostTime: number | null;
}

export type CampaignStatus =
  | "ready"
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "stopped"
  | "finished";

export interface CampaignSnapshot {
  readonly status: CampaignStatus;
  readonly sender: NodeIdentifier;
  readonly receiver: NodeIdentifier;
  readonly results: readonly PointResult[];
  readonly currentIndex: number | null;
  /** Points completed or failed. */
  readonly finishedCount: number;
  /** Share of the estimated total time already done, from 0 to 1. */
  readonly progress: number;
  readonly estimatedRemainingMilliseconds: number;
  readonly startHostTime: number | null;
  readonly endHostTime: number | null;
}

export interface CapacityTestCampaignOptions {
  readonly sender: CampaignNode;
  readonly receiver: CampaignNode;
  readonly points: readonly CapacityTestPoint[];
  readonly timeSource?: TimeSource;
  /** Time both nodes have to confirm the radio settings. */
  readonly radioConfirmationTimeoutMilliseconds?: number;
  /** Time the sender has to answer `run` with `run_start`. */
  readonly runStartTimeoutMilliseconds?: number;
  /** Pause before repeating a `radio` command that a node refused as busy. */
  readonly busyRetryDelayMilliseconds?: number;
  readonly maximumBusyRetries?: number;
  readonly onChange?: (snapshot: CampaignSnapshot) => void;
  /** Called when the receiver heard no packet of a run, so the ledger can record it. */
  readonly onSilentReception?: (
    sender: NodeIdentifier,
    run: number,
    receiver: NodeIdentifier,
  ) => void;
}

const DEFAULT_RADIO_CONFIRMATION_TIMEOUT_MILLISECONDS = 5000;
const DEFAULT_RUN_START_TIMEOUT_MILLISECONDS = 5000;
const DEFAULT_BUSY_RETRY_DELAY_MILLISECONDS = 2000;
const DEFAULT_MAXIMUM_BUSY_RETRIES = 5;
/** The sender gets this factor over the estimated transmission time, plus a fixed margin. */
const TRANSMISSION_TIMEOUT_FACTOR = 1.5;
const TRANSMISSION_TIMEOUT_MARGIN_MILLISECONDS = 10_000;

type WaitResult<Value> =
  | { readonly kind: "satisfied"; readonly value: Value }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" };

type Verdict = { readonly failure: string } | "confirmed";

/** Events of both nodes relevant to the point in course. */
class PointObservation {
  readonly #point: CapacityTestPoint;
  readonly #sender: NodeIdentifier;
  radioPending = false;
  senderRadioConfirmed = false;
  receiverRadioConfirmed = false;
  radioRefusal: {
    readonly node: NodeIdentifier;
    readonly reason: string;
    readonly detail: string | null;
  } | null = null;
  runPending = false;
  runRefusal: { readonly reason: string; readonly detail: string | null } | null = null;
  runNumber: number | null = null;
  senderDone = false;
  readonly #packetsByRun = new Map<number, number>();
  readonly #endsByRun = new Map<number, RunEndEvent>();

  constructor(point: CapacityTestPoint, sender: NodeIdentifier) {
    this.#point = point;
    this.#sender = sender;
  }

  get receivedPackets(): number {
    return this.runNumber === null ? 0 : (this.#packetsByRun.get(this.runNumber) ?? 0);
  }

  get runEnd(): RunEndEvent | null {
    return this.runNumber === null ? null : (this.#endsByRun.get(this.runNumber) ?? null);
  }

  acceptSenderEvent(node: NodeIdentifier, event: ConsoleEvent): void {
    switch (event.ev) {
      case "radio":
        if (this.radioPending && this.#matchesPoint(event)) {
          this.senderRadioConfirmed = true;
        }
        break;
      case "run_start":
        if (this.runPending && this.runNumber === null) {
          this.runNumber = event.run;
        }
        break;
      case "run_done":
        if (this.runNumber !== null && event.run === this.runNumber) {
          this.senderDone = true;
        }
        break;
      case "error":
        this.#acceptError(node, event.cmd, event.reason, event.detail ?? null);
        break;
      default:
        break;
    }
  }

  acceptReceiverEvent(node: NodeIdentifier, event: ConsoleEvent): void {
    switch (event.ev) {
      case "radio":
        if (this.radioPending && this.#matchesPoint(event)) {
          this.receiverRadioConfirmed = true;
        }
        break;
      case "test_rx":
        if (this.runPending && event.src === this.#sender) {
          this.#packetsByRun.set(event.run, (this.#packetsByRun.get(event.run) ?? 0) + 1);
        }
        break;
      case "run_end":
        if (this.runPending && event.src === this.#sender) {
          this.#endsByRun.set(event.run, event);
        }
        break;
      case "error":
        this.#acceptError(node, event.cmd, event.reason, event.detail ?? null);
        break;
      default:
        break;
    }
  }

  /** Prepares a new attempt of the `radio` command. */
  beginRadioAttempt(): void {
    this.radioPending = true;
    this.radioRefusal = null;
  }

  /** Reason with which a node refused the last `radio` command, if one did. */
  radioRefusalReason(): string | null {
    return this.radioRefusal?.reason ?? null;
  }

  radioVerdict(): Verdict | null {
    if (this.radioRefusal !== null) {
      const { node, reason, detail } = this.radioRefusal;
      return {
        failure: `El nodo ${node} rechazó el comando radio (${describeReason(reason, detail)}).`,
      };
    }
    return this.senderRadioConfirmed && this.receiverRadioConfirmed ? "confirmed" : null;
  }

  runStartVerdict(): Verdict | null {
    if (this.runRefusal !== null) {
      const { reason, detail } = this.runRefusal;
      return { failure: `El emisor rechazó el comando run (${describeReason(reason, detail)}).` };
    }
    return this.runNumber !== null ? "confirmed" : null;
  }

  #acceptError(node: NodeIdentifier, command: string, reason: string, detail: string | null): void {
    if (this.radioPending && command === "radio" && this.radioRefusal === null) {
      this.radioRefusal = { node, reason, detail };
    }
    if (this.runPending && command === "run" && node === this.#sender && this.runRefusal === null) {
      this.runRefusal = { reason, detail };
    }
  }

  #matchesPoint(event: Extract<ConsoleEvent, { ev: "radio" }>): boolean {
    const point = this.#point;
    return (
      frequenciesMatch(event.freq, point.freq) &&
      event.sf === point.sf &&
      event.bw === point.bw &&
      event.cr === point.cr &&
      event.preamble === point.preamble &&
      event.sync === point.sync
    );
  }
}

function describeReason(reason: string, detail: string | null): string {
  return detail === null ? reason : `${reason}: ${detail}`;
}

interface MutablePointResult {
  point: CapacityTestPoint;
  status: PointStatus;
  run: number | null;
  received: number | null;
  failure: string | null;
  startHostTime: number | null;
  endHostTime: number | null;
}

export class CapacityTestCampaign {
  readonly #sender: CampaignNode;
  readonly #receiver: CampaignNode;
  readonly #points: readonly CapacityTestPoint[];
  readonly #timeSource: TimeSource;
  readonly #radioConfirmationTimeout: number;
  readonly #runStartTimeout: number;
  readonly #busyRetryDelay: number;
  readonly #maximumBusyRetries: number;
  readonly #onChange: ((snapshot: CampaignSnapshot) => void) | undefined;
  readonly #onSilentReception: CapacityTestCampaignOptions["onSilentReception"];
  readonly #results: MutablePointResult[];
  readonly #estimates: readonly number[];
  readonly #waiters = new Set<() => void>();
  #status: CampaignStatus = "ready";
  #currentIndex: number | null = null;
  #startHostTime: number | null = null;
  #endHostTime: number | null = null;
  #pauseRequested = false;
  #stopRequested = false;
  /** A command could not reach a node: its connection is gone, so the campaign cannot go on. */
  #transportFailed = false;
  #observation: PointObservation | null = null;
  #resumeWaiter: (() => void) | null = null;
  #snapshot: CampaignSnapshot;

  constructor(options: CapacityTestCampaignOptions) {
    if (options.sender.identifier === options.receiver.identifier) {
      throw new Error("sender and receiver must be different nodes");
    }
    this.#sender = options.sender;
    this.#receiver = options.receiver;
    this.#points = options.points;
    this.#timeSource = options.timeSource ?? SYSTEM_TIME_SOURCE;
    this.#radioConfirmationTimeout =
      options.radioConfirmationTimeoutMilliseconds ??
      DEFAULT_RADIO_CONFIRMATION_TIMEOUT_MILLISECONDS;
    this.#runStartTimeout =
      options.runStartTimeoutMilliseconds ?? DEFAULT_RUN_START_TIMEOUT_MILLISECONDS;
    this.#busyRetryDelay =
      options.busyRetryDelayMilliseconds ?? DEFAULT_BUSY_RETRY_DELAY_MILLISECONDS;
    this.#maximumBusyRetries = options.maximumBusyRetries ?? DEFAULT_MAXIMUM_BUSY_RETRIES;
    this.#onChange = options.onChange;
    this.#onSilentReception = options.onSilentReception;
    this.#results = options.points.map((point) => ({
      point,
      status: "pending",
      run: null,
      received: null,
      failure: null,
      startHostTime: null,
      endHostTime: null,
    }));
    this.#estimates = options.points.map(estimatePointDurationMilliseconds);
    this.#snapshot = this.#buildSnapshot();
  }

  get snapshot(): CampaignSnapshot {
    return this.#snapshot;
  }

  /** Executes the plan; resolves when every point was tried or the campaign was stopped. */
  async run(): Promise<CampaignSnapshot> {
    if (this.#status !== "ready") {
      throw new Error(`campaign cannot start from status ${this.#status}`);
    }
    this.#status = "running";
    this.#startHostTime = this.#timeSource.now();
    this.#publish();
    const unsubscribeSender = this.#sender.subscribe((event) => {
      this.#observation?.acceptSenderEvent(this.#sender.identifier, event);
      this.#wake();
    });
    const unsubscribeReceiver = this.#receiver.subscribe((event) => {
      this.#observation?.acceptReceiverEvent(this.#receiver.identifier, event);
      this.#wake();
    });
    try {
      for (let index = 0; index < this.#points.length && !this.#stopRequested; index += 1) {
        if (this.#pauseRequested) {
          this.#status = "paused";
          this.#publish();
          await new Promise<void>((resolve) => {
            this.#resumeWaiter = resolve;
          });
          this.#resumeWaiter = null;
          if (this.#stopRequested) {
            break;
          }
          this.#status = "running";
          this.#publish();
        }
        await this.#executePoint(index);
        if (this.#transportFailed) {
          this.#stopRequested = true;
        }
      }
    } finally {
      unsubscribeSender();
      unsubscribeReceiver();
      this.#observation = null;
      this.#currentIndex = null;
    }
    this.#status = this.#stopRequested ? "stopped" : "finished";
    this.#endHostTime = this.#timeSource.now();
    this.#publish();
    return this.#snapshot;
  }

  /** Stops after the point in course; the campaign waits for `resume()`. */
  pause(): void {
    if (this.#status === "running") {
      this.#pauseRequested = true;
      this.#status = "pausing";
      this.#publish();
    }
  }

  resume(): void {
    if (this.#status === "pausing") {
      this.#pauseRequested = false;
      this.#status = "running";
      this.#publish();
    } else if (this.#status === "paused") {
      this.#pauseRequested = false;
      this.#resumeWaiter?.();
    }
  }

  /** Abandons the point in course (stopping the run of the sender) and ends the campaign. */
  stop(): void {
    if (this.#status === "ready") {
      this.#stopRequested = true;
      this.#status = "stopped";
      this.#publish();
      return;
    }
    if (this.#status === "stopped" || this.#status === "finished" || this.#status === "stopping") {
      return;
    }
    this.#stopRequested = true;
    this.#status = "stopping";
    this.#publish();
    this.#resumeWaiter?.();
    this.#wake();
  }

  async #executePoint(index: number): Promise<void> {
    const point = this.#points[index]!;
    const result = this.#results[index]!;
    const observation = new PointObservation(point, this.#sender.identifier);
    this.#observation = observation;
    this.#currentIndex = index;
    result.status = "configuring";
    result.startHostTime = this.#timeSource.now();
    this.#publish();

    const configured = await this.#configureRadio(point, observation);
    if (configured !== "confirmed") {
      this.#finishPoint(result, configured);
      return;
    }

    result.status = "transmitting";
    this.#publish();
    const runCommand = buildRunCommand(point.count, point.size, CAPACITY_TEST_INTERVAL);
    if (!runCommand.valid) {
      this.#finishPoint(result, {
        failure: "El punto tiene una cantidad o un largo fuera de rango.",
      });
      return;
    }
    observation.runPending = true;
    const sent = await this.#sendCommand(this.#sender, runCommand.command);
    if (sent !== null) {
      this.#finishPoint(result, { failure: sent });
      return;
    }
    const started = await this.#waitFor(() => observation.runStartVerdict(), this.#runStartTimeout);
    if (started.kind === "cancelled") {
      this.#finishPoint(result, "stopped");
      return;
    }
    if (started.kind === "timeout") {
      this.#finishPoint(result, { failure: "El emisor no confirmó el comienzo de la corrida." });
      return;
    }
    if (started.value !== "confirmed") {
      this.#finishPoint(result, started.value);
      return;
    }
    result.run = observation.runNumber;
    this.#publish();

    const transmissionTimeout =
      estimateTransmissionMilliseconds(point) * TRANSMISSION_TIMEOUT_FACTOR +
      TRANSMISSION_TIMEOUT_MARGIN_MILLISECONDS;
    const done = await this.#waitFor(
      () => (observation.senderDone ? true : null),
      transmissionTimeout,
    );
    if (done.kind !== "satisfied") {
      void this.#sendCommand(this.#sender, RUN_STOP_COMMAND);
      this.#finishPoint(
        result,
        done.kind === "cancelled"
          ? "stopped"
          : { failure: "El emisor no informó el fin de la corrida a tiempo." },
      );
      return;
    }

    const grace = receptionGraceMilliseconds(
      CAPACITY_TEST_INTERVAL,
      pointTimeOnAirMicroseconds(point),
    );
    const ended = await this.#waitFor(() => observation.runEnd, grace);
    if (ended.kind === "cancelled") {
      this.#finishPoint(result, "stopped");
      return;
    }
    if (ended.kind === "satisfied") {
      result.received = ended.value.received;
      this.#finishPoint(result, "completed");
      return;
    }
    if (observation.receivedPackets === 0) {
      // The firmware opens a reception with the first packet: without packets there is no run_end.
      result.received = 0;
      this.#onSilentReception?.(
        this.#sender.identifier,
        observation.runNumber!,
        this.#receiver.identifier,
      );
      this.#finishPoint(result, "completed");
      return;
    }
    this.#finishPoint(result, {
      failure: `El receptor recibió ${observation.receivedPackets} paquetes pero no informó el fin de la corrida.`,
    });
  }

  async #configureRadio(
    point: CapacityTestPoint,
    observation: PointObservation,
  ): Promise<Verdict | "stopped"> {
    const command = buildRadioSetCommand(
      {
        freq: point.freq,
        sf: point.sf,
        bw: point.bw,
        cr: point.cr,
        preamble: point.preamble,
        sync: point.sync,
      },
      null,
    );
    if (!command.valid) {
      return { failure: command.problems.map((problem) => problem.message).join(" ") };
    }
    for (let attempt = 0; ; attempt += 1) {
      observation.beginRadioAttempt();
      const failures = await Promise.all([
        observation.senderRadioConfirmed ? null : this.#sendCommand(this.#sender, command.command),
        observation.receiverRadioConfirmed
          ? null
          : this.#sendCommand(this.#receiver, command.command),
      ]);
      const sendFailure = failures.find((failure) => failure !== null);
      if (sendFailure !== undefined && sendFailure !== null) {
        return { failure: sendFailure };
      }
      const verdict = await this.#waitFor(
        () => observation.radioVerdict(),
        this.#radioConfirmationTimeout,
      );
      if (verdict.kind === "cancelled") {
        return "stopped";
      }
      if (verdict.kind === "timeout") {
        const silent = [
          observation.senderRadioConfirmed ? null : this.#sender.identifier,
          observation.receiverRadioConfirmed ? null : this.#receiver.identifier,
        ].filter((node) => node !== null);
        return {
          failure:
            silent.length === 1
              ? `El nodo ${silent[0]} no confirmó los parámetros de radio a tiempo.`
              : `Los nodos ${silent.join(" y ")} no confirmaron los parámetros de radio a tiempo.`,
        };
      }
      if (
        verdict.value === "confirmed" ||
        observation.radioRefusalReason() !== "busy" ||
        attempt >= this.#maximumBusyRetries
      ) {
        return verdict.value;
      }
      // A node still closing the previous run refuses radio as busy: wait and repeat.
      const pause = await this.#waitFor(() => null, this.#busyRetryDelay);
      if (pause.kind === "cancelled") {
        return "stopped";
      }
    }
  }

  async #sendCommand(node: CampaignNode, command: string): Promise<string | null> {
    try {
      await node.sendCommand(command);
      return null;
    } catch (error) {
      this.#transportFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      return `No se pudo enviar «${command}» al nodo ${node.identifier}: ${message}`;
    }
  }

  #finishPoint(result: MutablePointResult, outcome: Verdict | "completed" | "stopped"): void {
    if (outcome === "completed" || outcome === "stopped") {
      result.status = outcome;
    } else if (outcome === "confirmed") {
      result.status = "completed";
    } else {
      result.status = "failed";
      result.failure = outcome.failure;
    }
    result.endHostTime = this.#timeSource.now();
    this.#observation = null;
    this.#publish();
  }

  #waitFor<Value>(
    evaluate: () => Value | null,
    timeoutMilliseconds: number,
  ): Promise<WaitResult<Value>> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: WaitResult<Value>): void => {
        if (settled) {
          return;
        }
        settled = true;
        cancelTimer();
        this.#waiters.delete(check);
        resolve(result);
      };
      const check = (): void => {
        if (this.#stopRequested) {
          finish({ kind: "cancelled" });
          return;
        }
        const value = evaluate();
        if (value !== null) {
          finish({ kind: "satisfied", value });
        }
      };
      const cancelTimer = this.#timeSource.schedule(
        () => finish({ kind: "timeout" }),
        timeoutMilliseconds,
      );
      this.#waiters.add(check);
      check();
    });
  }

  #wake(): void {
    // Deleting the entry being visited does not disturb the iteration of a Set.
    for (const check of this.#waiters) {
      check();
    }
  }

  #publish(): void {
    this.#snapshot = this.#buildSnapshot();
    this.#onChange?.(this.#snapshot);
  }

  #buildSnapshot(): CampaignSnapshot {
    const now = this.#timeSource.now();
    const results = this.#results.map((result): PointResult => ({ ...result }));
    const finished = results.filter(
      (result) => result.status === "completed" || result.status === "failed",
    );

    // Scale the estimates with what the completed points actually took.
    let estimatedOfCompleted = 0;
    let actualOfCompleted = 0;
    results.forEach((result, index) => {
      if (
        result.status === "completed" &&
        result.startHostTime !== null &&
        result.endHostTime !== null
      ) {
        estimatedOfCompleted += this.#estimates[index]!;
        actualOfCompleted += result.endHostTime - result.startHostTime;
      }
    });
    const calibration =
      estimatedOfCompleted > 0
        ? Math.min(3, Math.max(0.5, actualOfCompleted / estimatedOfCompleted))
        : 1;

    const total = this.#estimates.reduce((sum, estimate) => sum + estimate, 0);
    let done = 0;
    let remaining = 0;
    results.forEach((result, index) => {
      const estimate = this.#estimates[index]!;
      if (
        result.status === "completed" ||
        result.status === "failed" ||
        result.status === "stopped"
      ) {
        done += estimate;
      } else if (result.status === "pending") {
        remaining += estimate * calibration;
      } else {
        const elapsed = result.startHostTime === null ? 0 : now - result.startHostTime;
        done += Math.min(estimate, elapsed / calibration);
        remaining += Math.max(0, estimate * calibration - elapsed);
      }
    });
    const ended = this.#status === "stopped" || this.#status === "finished";
    return {
      status: this.#status,
      sender: this.#sender.identifier,
      receiver: this.#receiver.identifier,
      results,
      currentIndex: this.#currentIndex,
      finishedCount: finished.length,
      progress: total > 0 ? Math.min(1, done / total) : 1,
      estimatedRemainingMilliseconds: ended ? 0 : Math.round(remaining),
      startHostTime: this.#startHostTime,
      endHostTime: this.#endHostTime,
    };
  }

  /** Recomputes the progress and the remaining time; the view calls it every second. */
  refresh(): void {
    this.#publish();
  }
}

/**
 * Runs a capacity test over two nodes: for each point of the plan it sets the same radio settings
 * on both, waits until both confirm them, has the sender transmit a run and waits for the report
 * of the receiver. Points that fail are marked and the campaign continues with the next one.
 */
import { RUN_STOP_COMMAND, buildRunCommand } from "$lib/commands/console-command.ts";
import type { ConsoleEvent, NodeIdentifier, RunEndEvent } from "$lib/console/console-event.ts";
import {
  CAPACITY_TEST_INTERVAL,
  estimatePointDurationMilliseconds,
  estimateTransmissionMilliseconds,
  pointTimeOnAirMicroseconds,
  type CapacityTestPoint,
} from "./capacity-test-plan.ts";
import {
  COMMAND_CONFIRMATION_MILLISECONDS,
  CommandFailure,
  applyRadioSettings,
  describeCommandFailureSentence,
  sendAndAwait,
  type NodePort,
} from "$lib/nodes/node-port.ts";
import { CHANNEL_FIELDS } from "$lib/radio/radio-settings.ts";
import { receptionGraceMilliseconds } from "./test-run-ledger.ts";
import { SYSTEM_TIME_SOURCE, scheduleRepeatedly, type TimeSource } from "$lib/utils/time-source.ts";

export type PointStatus =
  | "pending"
  | "configuring"
  | "transmitting"
  | "completed"
  | "failed"
  | "stopped";

export const POINT_STATUS_LABELS: { readonly [Status in PointStatus]: string } = {
  pending: "Pendiente",
  configuring: "Configurando la radio",
  transmitting: "Transmitiendo",
  completed: "Completo",
  failed: "Falló",
  stopped: "Detenido",
};

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

export const CAMPAIGN_STATUS_LABELS: { readonly [Status in CampaignStatus]: string } = {
  ready: "Lista para empezar",
  running: "En curso",
  pausing: "Se pausa al terminar el punto en curso",
  paused: "En pausa",
  stopping: "Deteniendo",
  stopped: "Detenida",
  finished: "Terminada",
};

/** True from the start of the campaign until it stops or finishes, through its pauses. */
export function isCampaignActive(snapshot: { readonly status: CampaignStatus }): boolean {
  const status = snapshot.status;
  return (
    status === "running" || status === "pausing" || status === "paused" || status === "stopping"
  );
}

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
  readonly sender: NodePort;
  readonly receiver: NodePort;
  readonly points: readonly CapacityTestPoint[];
  readonly timeSource?: TimeSource;
  readonly onChange?: (snapshot: CampaignSnapshot) => void;
  /** Called when the receiver heard no packet of a run, so the ledger can record it. */
  readonly onSilentReception?: (
    sender: NodeIdentifier,
    run: number,
    receiver: NodeIdentifier,
  ) => void;
}

const PROGRESS_REFRESH_INTERVAL_MILLISECONDS = 1000;
/** The sender gets this factor over the estimated transmission time, plus a fixed margin. */
const TRANSMISSION_TIMEOUT_FACTOR = 1.5;
const TRANSMISSION_TIMEOUT_MARGIN_MILLISECONDS = 10_000;

type WaitResult<Value> =
  | { readonly kind: "satisfied"; readonly value: Value }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" };

type Verdict = { readonly failure: string } | "confirmed";

/** What the sender and the receiver report about the run of the point in course. */
class RunObservation {
  readonly #sender: NodeIdentifier;
  /** Run number the sender assigned, once it confirmed the run. */
  runNumber: number | null = null;
  readonly #doneRuns = new Set<number>();
  readonly #packetsByRun = new Map<number, number>();
  readonly #endsByRun = new Map<number, RunEndEvent>();

  constructor(sender: NodeIdentifier) {
    this.#sender = sender;
  }

  get senderDone(): boolean {
    return this.runNumber !== null && this.#doneRuns.has(this.runNumber);
  }

  get receivedPackets(): number {
    return this.runNumber === null ? 0 : (this.#packetsByRun.get(this.runNumber) ?? 0);
  }

  get runEnd(): RunEndEvent | null {
    return this.runNumber === null ? null : (this.#endsByRun.get(this.runNumber) ?? null);
  }

  // Kept by run number: run_start and run_done of a short run may arrive in the same burst of
  // console lines, before the confirmation of the run sets the run number here.
  acceptSenderEvent(event: ConsoleEvent): void {
    if (event.ev === "run_done") {
      this.#doneRuns.add(event.run);
    }
  }

  acceptReceiverEvent(event: ConsoleEvent): void {
    if (event.ev === "test_rx" && event.src === this.#sender) {
      this.#packetsByRun.set(event.run, (this.#packetsByRun.get(event.run) ?? 0) + 1);
    } else if (event.ev === "run_end" && event.src === this.#sender) {
      this.#endsByRun.set(event.run, event);
    }
  }
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
  readonly #sender: NodePort;
  readonly #receiver: NodePort;
  readonly #points: readonly CapacityTestPoint[];
  readonly #timeSource: TimeSource;
  readonly #onChange: ((snapshot: CampaignSnapshot) => void) | undefined;
  readonly #onSilentReception: CapacityTestCampaignOptions["onSilentReception"];
  readonly #results: MutablePointResult[];
  readonly #estimates: readonly number[];
  readonly #waiters = new Set<() => void>();
  readonly #stopController = new AbortController();
  #status: CampaignStatus = "ready";
  #currentIndex: number | null = null;
  #startHostTime: number | null = null;
  #endHostTime: number | null = null;
  #pauseRequested = false;
  /** A command could not reach a node: its connection is gone, so the campaign cannot go on. */
  #transportFailed = false;
  #observation: RunObservation | null = null;
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
    const stopRefreshing = scheduleRepeatedly(
      this.#timeSource,
      () => this.#publish(),
      PROGRESS_REFRESH_INTERVAL_MILLISECONDS,
    );
    const unsubscribeSender = this.#sender.subscribe((event) => {
      this.#observation?.acceptSenderEvent(event);
      this.#wake();
    });
    const unsubscribeReceiver = this.#receiver.subscribe((event) => {
      this.#observation?.acceptReceiverEvent(event);
      this.#wake();
    });
    try {
      for (let index = 0; index < this.#points.length && !this.#stopping; index += 1) {
        if (this.#pauseRequested) {
          this.#status = "paused";
          this.#publish();
          await new Promise<void>((resolve) => {
            this.#resumeWaiter = resolve;
          });
          this.#resumeWaiter = null;
          if (this.#stopping) {
            break;
          }
          this.#status = "running";
          this.#publish();
        }
        await this.#executePoint(index);
        if (this.#transportFailed) {
          this.#stopController.abort();
        }
      }
    } finally {
      stopRefreshing();
      unsubscribeSender();
      unsubscribeReceiver();
      this.#observation = null;
      this.#currentIndex = null;
    }
    this.#status = this.#stopping ? "stopped" : "finished";
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
      this.#stopController.abort();
      this.#status = "stopped";
      this.#publish();
      return;
    }
    if (this.#status === "stopped" || this.#status === "finished" || this.#status === "stopping") {
      return;
    }
    this.#stopController.abort();
    this.#status = "stopping";
    this.#publish();
    this.#resumeWaiter?.();
    this.#wake();
  }

  /** True once stop() was called or a command could not reach a node. */
  get #stopping(): boolean {
    return this.#stopController.signal.aborted;
  }

  async #executePoint(index: number): Promise<void> {
    const point = this.#points[index]!;
    const result = this.#results[index]!;
    this.#currentIndex = index;
    result.status = "configuring";
    result.startHostTime = this.#timeSource.now();
    this.#publish();

    const configured = await this.#configureRadio(point);
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
    const observation = new RunObservation(this.#sender.identifier);
    this.#observation = observation;
    try {
      const started = await sendAndAwait(
        this.#sender,
        runCommand.command,
        (event) => event.ev === "run_start",
        this.#awaitOptions(COMMAND_CONFIRMATION_MILLISECONDS),
      );
      observation.runNumber = started.event.run;
    } catch (error) {
      this.#finishPoint(result, this.#runStartVerdict(error));
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
      failure: `El receptor recibió ${observation.receivedPackets} ${observation.receivedPackets === 1 ? "paquete" : "paquetes"}, pero no informó el fin de la corrida.`,
    });
  }

  /** Sets the radio settings of the point on both nodes and waits until both confirm them. */
  async #configureRadio(point: CapacityTestPoint): Promise<Verdict | "stopped"> {
    // A refusal by one node makes the point fail: the wait for the other one ends there.
    const pointAttempt = new AbortController();
    const signal = AbortSignal.any([this.#stopController.signal, pointAttempt.signal]);
    const confirm = async (node: NodePort): Promise<CommandFailure | null> => {
      const failure = await applyRadioSettings(node, point, CHANNEL_FIELDS, {
        timeSource: this.#timeSource,
        signal,
      });
      if (failure?.kind === "refused" || failure?.kind === "unsent") {
        pointAttempt.abort();
      }
      return failure;
    };
    const failures = (await Promise.all([confirm(this.#sender), confirm(this.#receiver)])).filter(
      (failure) => failure !== null,
    );
    const unsent = failures.find((failure) => failure.kind === "unsent");
    if (unsent !== undefined) {
      return { failure: this.#recordTransportFailure(unsent) };
    }
    const refused = failures.find((failure) => failure.kind === "refused");
    if (refused !== undefined) {
      return { failure: describeCommandFailureSentence(refused) };
    }
    if (this.#stopping) {
      return "stopped";
    }
    const silent = failures
      .filter((failure) => failure.kind === "timeout")
      .map((failure) => failure.node);
    if (silent.length === 0) {
      return "confirmed";
    }
    return {
      failure:
        silent.length === 1
          ? `El nodo ${silent[0]} no confirmó los parámetros de radio a tiempo.`
          : `Los nodos ${silent.join(" y ")} no confirmaron los parámetros de radio a tiempo.`,
    };
  }

  #runStartVerdict(error: unknown): Verdict | "stopped" {
    if (!(error instanceof CommandFailure)) {
      throw error;
    }
    switch (error.kind) {
      case "cancelled":
        return "stopped";
      case "timeout":
        return { failure: "El emisor no confirmó el comienzo de la corrida." };
      case "refused":
        return { failure: describeCommandFailureSentence(error) };
      case "unsent":
        return { failure: this.#recordTransportFailure(error) };
    }
  }

  #awaitOptions(timeoutMilliseconds: number) {
    return {
      timeSource: this.#timeSource,
      timeoutMilliseconds,
      signal: this.#stopController.signal,
    };
  }

  /**
   * A command that cannot reach a node means its connection is gone: marks the campaign to stop
   * after the point and describes the failure.
   */
  #recordTransportFailure(failure: CommandFailure): string {
    this.#transportFailed = true;
    return describeCommandFailureSentence(failure);
  }

  async #sendCommand(node: NodePort, command: string): Promise<void> {
    try {
      await node.sendCommand(command);
    } catch {
      this.#transportFailed = true;
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
        if (this.#stopping) {
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
}

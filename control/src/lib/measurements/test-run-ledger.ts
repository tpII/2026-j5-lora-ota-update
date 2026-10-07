/**
 * Bookkeeping of test runs across nodes. The sender reports `run_start`, a `tx` of type "test" per
 * packet and `run_done`; each receiver reports `test_rx` per packet and `run_end`. The ledger
 * matches them by sender identifier and run number and produces one summary row per run and
 * receiver, with the columns of measurements/README.md.
 *
 * A receiver that hears no packet of a run never opens it, so it never emits `run_end`. For a
 * receiver that was listening on the channel of the sender, the ledger closes that reception with
 * zero packets once the sender finished and the receiver deadline went by, or when told so.
 */
import type {
  BoardModel,
  ConsoleEvent,
  LnaMode,
  NodeIdentifier,
  RunEndEvent,
  RunEndReason,
} from "$lib/console/console-event.ts";
import {
  channelsMatch,
  radioSettingsOf,
  timeOnAirFor,
  type RadioSettings,
} from "$lib/radio/radio-settings.ts";
import { computeFrameLength } from "$lib/radio/time-on-air.ts";

/** Margin added to the receiver deadline before closing a reception without packets. */
export const RECEPTION_CLOSURE_MARGIN_MILLISECONDS = 3000;

/** Fixed part of the receiver deadline in the firmware (RESPONSE_MARGIN_MS). */
const RECEIVER_DEADLINE_MARGIN_MILLISECONDS = 1000;

/** One row of summary.csv, with the column names of measurements/README.md. */
export interface TestRunSummaryRow {
  readonly run: number;
  readonly sender: NodeIdentifier;
  readonly receiver: NodeIdentifier;
  readonly sender_model: BoardModel | null;
  readonly receiver_model: BoardModel | null;
  readonly freq: number | null;
  readonly sf: number | null;
  readonly bw: number | null;
  readonly cr: number | null;
  readonly preamble: number | null;
  readonly power: number | null;
  readonly receiver_lna: LnaMode | null;
  readonly size: number | null;
  readonly count: number;
  readonly sent: number | null;
  readonly received: number;
  readonly pdr: number;
  readonly rssi_avg: number | null;
  readonly rssi_min: number | null;
  readonly rssi_max: number | null;
  readonly snr_avg: number | null;
  readonly toa_avg: number | null;
  readonly toa_calc: number | null;
  readonly duration: number | null;
  readonly goodput: number | null;
  readonly reason: RunEndReason;
}

/** Columns of summary.csv, in order. */
export const SUMMARY_COLUMNS = [
  "run",
  "sender",
  "receiver",
  "sender_model",
  "receiver_model",
  "freq",
  "sf",
  "bw",
  "cr",
  "preamble",
  "power",
  "receiver_lna",
  "size",
  "count",
  "sent",
  "received",
  "pdr",
  "rssi_avg",
  "rssi_min",
  "rssi_max",
  "snr_avg",
  "toa_avg",
  "toa_calc",
  "duration",
  "goodput",
  "reason",
] as const satisfies readonly (keyof TestRunSummaryRow)[];

export type ReceptionOutcome = "receiving" | "complete" | "timeout" | "no_reception";

export interface ReceptionView {
  readonly receiver: NodeIdentifier;
  readonly receiverModel: BoardModel | null;
  /** Packets received so far, or the final count once the reception ends. */
  readonly received: number;
  readonly outcome: ReceptionOutcome;
  readonly row: TestRunSummaryRow | null;
}

export interface SenderCompletion {
  readonly sent: number;
  readonly duration: number;
  readonly aborted: boolean;
  readonly hostTime: number;
}

export interface TestRunView {
  readonly sender: NodeIdentifier;
  readonly run: number;
  readonly senderModel: BoardModel | null;
  readonly count: number | null;
  readonly size: number | null;
  readonly interval: number | null;
  readonly settings: RadioSettings | null;
  readonly startHostTime: number | null;
  /** TEST frames the sender reported with `tx`. */
  readonly transmitted: number;
  readonly completion: SenderCompletion | null;
  readonly receptions: readonly ReceptionView[];
}

interface NodeProfile {
  model: BoardModel | null;
  radio: RadioSettings | null;
  present: boolean;
}

interface ReceptionRecord {
  readonly receiver: NodeIdentifier;
  expected: boolean;
  received: number;
  size: number | null;
  receiverModel: BoardModel | null;
  receiverRadio: RadioSettings | null;
  end: RunEndEvent | null;
  closedWithoutPackets: boolean;
}

interface RunRecord {
  readonly sender: NodeIdentifier;
  readonly run: number;
  announced: boolean;
  count: number | null;
  size: number | null;
  interval: number | null;
  startHostTime: number | null;
  senderModel: BoardModel | null;
  senderRadio: RadioSettings | null;
  transmitted: number;
  timeOnAirSum: number;
  calculatedTimeOnAir: number | null;
  completion: SenderCompletion | null;
  readonly receptions: Map<NodeIdentifier, ReceptionRecord>;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function runKey(sender: NodeIdentifier, run: number): string {
  return `${sender}:${run}`;
}

export class TestRunLedger {
  readonly #profiles = new Map<NodeIdentifier, NodeProfile>();
  readonly #records: RunRecord[] = [];
  /** Newest record for each sender and run number. */
  readonly #recordsByKey = new Map<string, RunRecord>();
  /** Run each node is transmitting, until its `run_done`. */
  readonly #activeRunsBySender = new Map<NodeIdentifier, RunRecord>();
  #revision = 0;
  #cachedRows: { revision: number; rows: readonly TestRunSummaryRow[] } | null = null;
  #cachedRuns: { revision: number; runs: readonly TestRunView[] } | null = null;

  /** Increases with every change, so a view can tell when to read the ledger again. */
  get revision(): number {
    return this.#revision;
  }

  /** Takes one event emitted by the console of node `node` and received at `hostTime`. */
  acceptEvent(node: NodeIdentifier, event: ConsoleEvent, hostTime: number): void {
    const profile = this.#profileOf(node);
    profile.present = true;
    switch (event.ev) {
      case "boot":
        profile.model = event.model;
        // The runs of a node do not survive a reboot.
        this.#activeRunsBySender.delete(node);
        break;
      case "status":
        profile.model = event.model;
        break;
      case "radio":
        profile.radio = radioSettingsOf(event);
        break;
      case "run_start":
        this.#acceptRunStart(node, event.run, event.count, event.size, event.interval, hostTime);
        break;
      case "tx":
        if (event.type === "test" && event.run !== undefined) {
          const record = this.#findRecord(node, event.run);
          if (record !== undefined && record.completion === null) {
            record.transmitted += 1;
            record.timeOnAirSum += event.toa;
            record.calculatedTimeOnAir = event.toa_calc;
          }
        }
        break;
      case "run_done": {
        const record = this.#findRecord(node, event.run);
        if (record !== undefined) {
          record.completion = {
            sent: event.sent,
            duration: event.duration,
            aborted: event.aborted,
            hostTime,
          };
          record.count ??= event.count;
        }
        if (this.#activeRunsBySender.get(node) === record) {
          this.#activeRunsBySender.delete(node);
        }
        break;
      }
      case "test_rx": {
        const record = this.#findOrCreateRecord(event.src, event.run);
        record.count ??= event.count;
        const reception = this.#receptionOf(record, node);
        if (reception.end === null) {
          reception.received += 1;
          reception.closedWithoutPackets = false;
        }
        reception.size = event.size;
        this.#captureReceiverProfile(reception, profile);
        break;
      }
      case "run_end": {
        const record = this.#findOrCreateRecord(event.src, event.run);
        record.count ??= event.count;
        const reception = this.#receptionOf(record, node);
        reception.end = event;
        reception.received = event.received;
        reception.closedWithoutPackets = false;
        this.#captureReceiverProfile(reception, profile);
        break;
      }
      default:
        return;
    }
    this.#revision += 1;
  }

  /** Stops expecting receptions from a node whose console disconnected. */
  markNodeAbsent(node: NodeIdentifier): void {
    const profile = this.#profiles.get(node);
    if (profile !== undefined && profile.present) {
      profile.present = false;
      this.#revision += 1;
    }
  }

  /**
   * Closes, with zero packets, the receptions that never started although the receiver listened
   * on the channel of the sender, once the deadline of the receiver went by. Returns true when a
   * reception was closed.
   */
  closeOverdueReceptions(hostTime: number): boolean {
    let changed = false;
    for (const record of this.#records) {
      if (record.completion === null) {
        continue;
      }
      if (hostTime < record.completion.hostTime + receptionGraceOf(record)) {
        continue;
      }
      for (const reception of record.receptions.values()) {
        if (reception.expected && this.#closeIfSilent(reception)) {
          changed = true;
        }
      }
    }
    if (changed) {
      this.#revision += 1;
    }
    return changed;
  }

  /**
   * Records that `receiver` heard no packet of run `run` of `sender`. Has no effect when the
   * receiver reported packets of that run. Returns true when the reception was closed.
   */
  closeReceptionWithoutPackets(
    sender: NodeIdentifier,
    run: number,
    receiver: NodeIdentifier,
  ): boolean {
    const record = this.#findRecord(sender, run);
    if (record === undefined) {
      return false;
    }
    const reception = this.#receptionOf(record, receiver);
    reception.expected = true;
    const closed = this.#closeIfSilent(reception);
    this.#revision += 1;
    return closed;
  }

  /** Summary rows of every finished reception, in the order the runs started. */
  get rows(): readonly TestRunSummaryRow[] {
    if (this.#cachedRows?.revision !== this.#revision) {
      const rows = this.runs.flatMap((run) =>
        run.receptions.flatMap((reception) => (reception.row === null ? [] : [reception.row])),
      );
      this.#cachedRows = { revision: this.#revision, rows };
    }
    return this.#cachedRows.rows;
  }

  /** Every run seen, oldest first, with the state of each reception. */
  get runs(): readonly TestRunView[] {
    if (this.#cachedRuns?.revision !== this.#revision) {
      this.#cachedRuns = { revision: this.#revision, runs: this.#records.map(viewOf) };
    }
    return this.#cachedRuns.runs;
  }

  findRun(sender: NodeIdentifier, run: number): TestRunView | null {
    return this.runs.findLast((view) => view.sender === sender && view.run === run) ?? null;
  }

  findRow(sender: NodeIdentifier, run: number, receiver: NodeIdentifier): TestRunSummaryRow | null {
    return (
      this.findRun(sender, run)?.receptions.find((reception) => reception.receiver === receiver)
        ?.row ?? null
    );
  }

  /** Forgets every run; the node profiles stay. */
  clear(): void {
    this.#records.length = 0;
    this.#recordsByKey.clear();
    this.#activeRunsBySender.clear();
    this.#revision += 1;
  }

  #profileOf(node: NodeIdentifier): NodeProfile {
    let profile = this.#profiles.get(node);
    if (profile === undefined) {
      profile = { model: null, radio: null, present: true };
      this.#profiles.set(node, profile);
    }
    return profile;
  }

  #acceptRunStart(
    sender: NodeIdentifier,
    run: number,
    count: number,
    size: number,
    interval: number,
    hostTime: number,
  ): void {
    const existing = this.#recordsByKey.get(runKey(sender, run));
    // A receiver may report packets before the panel sees run_start: complete that record.
    const record =
      existing !== undefined && !existing.announced ? existing : this.#createRecord(sender, run);
    const profile = this.#profileOf(sender);
    record.announced = true;
    record.count = count;
    record.size = size;
    record.interval = interval;
    record.startHostTime = hostTime;
    record.senderModel = profile.model;
    record.senderRadio = profile.radio;
    this.#activeRunsBySender.set(sender, record);

    const senderRadio = profile.radio;
    if (senderRadio === null) {
      return;
    }
    for (const [node, candidate] of this.#profiles) {
      const listening =
        node !== sender &&
        candidate.present &&
        candidate.radio !== null &&
        channelsMatch(candidate.radio, senderRadio) &&
        !this.#activeRunsBySender.has(node);
      if (listening) {
        const reception = this.#receptionOf(record, node);
        reception.expected = true;
        this.#captureReceiverProfile(reception, candidate);
      }
    }
  }

  #createRecord(sender: NodeIdentifier, run: number): RunRecord {
    const record: RunRecord = {
      sender,
      run,
      announced: false,
      count: null,
      size: null,
      interval: null,
      startHostTime: null,
      senderModel: this.#profiles.get(sender)?.model ?? null,
      senderRadio: null,
      transmitted: 0,
      timeOnAirSum: 0,
      calculatedTimeOnAir: null,
      completion: null,
      receptions: new Map(),
    };
    this.#records.push(record);
    this.#recordsByKey.set(runKey(sender, run), record);
    return record;
  }

  #findRecord(sender: NodeIdentifier, run: number): RunRecord | undefined {
    return this.#recordsByKey.get(runKey(sender, run));
  }

  #findOrCreateRecord(sender: NodeIdentifier, run: number): RunRecord {
    return this.#findRecord(sender, run) ?? this.#createRecord(sender, run);
  }

  #receptionOf(record: RunRecord, receiver: NodeIdentifier): ReceptionRecord {
    let reception = record.receptions.get(receiver);
    if (reception === undefined) {
      reception = {
        receiver,
        expected: false,
        received: 0,
        size: null,
        receiverModel: null,
        receiverRadio: null,
        end: null,
        closedWithoutPackets: false,
      };
      record.receptions.set(receiver, reception);
    }
    return reception;
  }

  #captureReceiverProfile(reception: ReceptionRecord, profile: NodeProfile): void {
    reception.receiverModel = profile.model;
    reception.receiverRadio = profile.radio;
  }

  #closeIfSilent(reception: ReceptionRecord): boolean {
    if (reception.end !== null || reception.closedWithoutPackets || reception.received > 0) {
      return false;
    }
    reception.closedWithoutPackets = true;
    const profile = this.#profiles.get(reception.receiver);
    if (profile !== undefined && reception.receiverRadio === null) {
      this.#captureReceiverProfile(reception, profile);
    }
    return true;
  }
}

function estimateTimeOnAir(size: number | null, settings: RadioSettings | null): number | null {
  if (size === null || settings === null) {
    return null;
  }
  return timeOnAirFor(computeFrameLength(size), settings);
}

/**
 * Time to wait after `run_done` before closing a silent reception: the deadline of the receiver
 * (twice the interval plus the time on air, plus one second) and a margin for the consoles.
 */
export function receptionGraceMilliseconds(
  interval: number,
  timeOnAirMicroseconds: number,
): number {
  return (
    2 * (interval + Math.ceil(timeOnAirMicroseconds / 1000)) +
    RECEIVER_DEADLINE_MARGIN_MILLISECONDS +
    RECEPTION_CLOSURE_MARGIN_MILLISECONDS
  );
}

function receptionGraceOf(record: RunRecord): number {
  const timeOnAir =
    record.calculatedTimeOnAir ?? estimateTimeOnAir(record.size, record.senderRadio) ?? 0;
  return receptionGraceMilliseconds(record.interval ?? 0, timeOnAir);
}

function outcomeOf(reception: ReceptionRecord): ReceptionOutcome {
  if (reception.end !== null) {
    return reception.end.reason;
  }
  return reception.closedWithoutPackets ? "no_reception" : "receiving";
}

function viewOf(record: RunRecord): TestRunView {
  const receptions = [...record.receptions.values()]
    .sort((first, second) => first.receiver.localeCompare(second.receiver))
    .map((reception): ReceptionView => ({
      receiver: reception.receiver,
      receiverModel: reception.receiverModel,
      received: reception.received,
      outcome: outcomeOf(reception),
      row: summaryRowOf(record, reception),
    }));
  return {
    sender: record.sender,
    run: record.run,
    senderModel: record.senderModel,
    count: record.count,
    size: record.size,
    interval: record.interval,
    settings: record.senderRadio,
    startHostTime: record.startHostTime,
    transmitted: record.transmitted,
    completion: record.completion,
    receptions,
  };
}

function summaryRowOf(record: RunRecord, reception: ReceptionRecord): TestRunSummaryRow | null {
  const end = reception.end;
  if (end === null && !reception.closedWithoutPackets) {
    return null;
  }
  // Sender and receiver share the channel, so the receiver settings stand in for an unseen sender.
  const channel = record.senderRadio ?? reception.receiverRadio;
  const size = record.size ?? reception.size;
  const received = end?.received ?? 0;
  const duration = record.completion?.duration ?? null;
  const calculatedTimeOnAir = record.calculatedTimeOnAir ?? estimateTimeOnAir(size, channel);
  return {
    run: record.run,
    sender: record.sender,
    receiver: reception.receiver,
    sender_model: record.senderModel,
    receiver_model: reception.receiverModel,
    freq: channel?.freq ?? null,
    sf: channel?.sf ?? null,
    bw: channel?.bw ?? null,
    cr: channel?.cr ?? null,
    preamble: channel?.preamble ?? null,
    power: record.senderRadio?.power ?? null,
    receiver_lna: reception.receiverRadio?.lna ?? null,
    size,
    count: end?.count ?? record.count ?? 0,
    sent: record.completion?.sent ?? null,
    received,
    pdr: end?.pdr ?? 0,
    rssi_avg: end?.rssi_avg ?? null,
    rssi_min: end?.rssi_min ?? null,
    rssi_max: end?.rssi_max ?? null,
    snr_avg: end?.snr_avg ?? null,
    toa_avg: record.transmitted > 0 ? roundTo(record.timeOnAirSum / record.transmitted, 1) : null,
    toa_calc: calculatedTimeOnAir === null ? null : Math.round(calculatedTimeOnAir),
    duration,
    goodput:
      duration !== null && duration > 0 && size !== null
        ? roundTo((received * size * 8 * 1_000_000) / duration, 1)
        : null,
    reason: end?.reason ?? "timeout",
  };
}

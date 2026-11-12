/**
 * What the panel records of the updates since the measurement record was last cleared: every
 * `load_image` and `activate` it sent, built by the update section or typed by the operator, the
 * answer of each load, and the update metrics M1, M2 and M3 they give with the event journal. The
 * update export starts from this record.
 */
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import type { EventJournal } from "$lib/measurements/event-journal.ts";
import type {
  MeasurementDescription,
  MeasurementExport,
} from "$lib/measurements/measurement-export.ts";
import type { ConnectionStatus } from "$lib/node-session/node-connection.ts";
import type { NodeState } from "$lib/node-session/node-state.ts";
import type { TimeSource } from "$lib/utils/time-source.ts";
import {
  loadedUpdateVersions,
  parseTypedUpdateCommand,
  settleLoadResponses,
  updateCommandTimesOf,
  type UpdateCommand,
  type UpdateCommandRecord,
} from "./update-commands.ts";
import { boardModelsOf, buildUpdateExport } from "./update-export.ts";
import { computeUpdateMetrics, type UpdateMetrics } from "./update-metrics.ts";

/** A connection as the record needs it when a command leaves: its status and its node. */
export interface UpdateCommandTarget {
  readonly status: ConnectionStatus;
  readonly state: { readonly identifier: NodeIdentifier | null };
}

export interface UpdateRecordOptions {
  readonly journal: EventJournal;
  readonly timeSource: TimeSource;
  /** The live connection of a key, when it exists. */
  readonly connection: (key: string) => UpdateCommandTarget | undefined;
  /** Sends a line to a connection; false when it did not leave. */
  readonly send: (key: string, line: string) => Promise<boolean>;
}

/** What the metrics were last computed from, so that they are not computed again for nothing. */
interface MetricsInputs {
  readonly journalSize: number;
  readonly journalStart: number | null;
  readonly commands: readonly UpdateCommandRecord[];
}

export class UpdateRecord {
  /** `load_image` and `activate` commands sent since the record was last cleared, oldest first. */
  commands = $state.raw<readonly UpdateCommandRecord[]>([]);
  /**
   * M1, M2 and M3 of every version a node accepted since the record was cleared, oldest first, as
   * of the last publishMetrics().
   */
  metrics = $state.raw<readonly UpdateMetrics[]>([]);

  readonly #journal: EventJournal;
  readonly #timeSource: TimeSource;
  readonly #connection: UpdateRecordOptions["connection"];
  readonly #send: UpdateRecordOptions["send"];
  #metricsInputs: MetricsInputs | null = null;

  constructor(options: UpdateRecordOptions) {
    this.#journal = options.journal;
    this.#timeSource = options.timeSource;
    this.#connection = options.connection;
    this.#send = options.send;
  }

  /** Versions a node accepted with `load_image` since the record was cleared, oldest first. */
  get versions(): readonly number[] {
    return loadedUpdateVersions(this.commands);
  }

  /**
   * Sends `load_image` or `activate`, built with `command` in it, and records it. Returns the
   * record, or null when the command did not leave.
   */
  async send(
    key: string,
    command: UpdateCommand,
    line: string,
  ): Promise<UpdateCommandRecord | null> {
    const connection = this.#connection(key);
    if (connection === undefined) {
      return null;
    }
    // Recorded before it leaves, so that the answer of the node always finds it.
    const record: UpdateCommandRecord | null =
      connection.status === "open"
        ? {
            connectionKey: key,
            node: connection.state.identifier,
            hostTime: this.#timeSource.now(),
            command,
          }
        : null;
    if (record !== null) {
      this.commands = [...this.commands, record];
    }
    return (await this.#send(key, line)) ? record : null;
  }

  /**
   * Sends a line the operator typed. A `load_image` or an `activate` typed by hand counts for the
   * metrics like those of the update section.
   */
  async sendTyped(key: string, line: string): Promise<boolean> {
    const command = parseTypedUpdateCommand(line);
    return command === null
      ? this.#send(key, line)
      : (await this.send(key, command, line)) !== null;
  }

  /** Records the answers to its `load_image` commands that the node of a connection gave. */
  acceptEvent(connectionKey: string, state: NodeState): void {
    this.commands = settleLoadResponses(this.commands, connectionKey, state);
  }

  /** Computes the metrics again when the journal or the commands changed since the last time. */
  publishMetrics(): void {
    const inputs: MetricsInputs = {
      journalSize: this.#journal.size,
      journalStart: this.#journal.firstHostTime,
      commands: this.commands,
    };
    const previous = this.#metricsInputs;
    if (
      previous !== null &&
      previous.journalSize === inputs.journalSize &&
      previous.journalStart === inputs.journalStart &&
      previous.commands === inputs.commands
    ) {
      return;
    }
    this.#metricsInputs = inputs;
    this.metrics = this.#measure();
  }

  /**
   * The export of every update loaded since the record was cleared: M1, M2 and M3 per receiver,
   * the commands of the panel and every event of the journal. Null when there is no update.
   */
  exportOf(description: MeasurementDescription): MeasurementExport | null {
    const metrics = this.#measure();
    return metrics.length === 0
      ? null
      : buildUpdateExport({
          metrics,
          commands: this.commands,
          description,
          nodes: this.#journal.participatingNodes(),
          events: this.#journal.events(),
          models: boardModelsOf(this.#journal.consoleEvents()),
        });
  }

  /**
   * Forgets the commands. The journal they are measured with is shared with the rest of the
   * measurement record, so its owner clears it.
   */
  clear(): void {
    this.commands = [];
  }

  #measure(): UpdateMetrics[] {
    // Read once for every version: the journal yields its events as a generator.
    const events = [...this.#journal.consoleEvents()];
    return this.versions.flatMap((version) => {
      const times = updateCommandTimesOf(this.commands, version);
      return times === null ? [] : [computeUpdateMetrics({ version, ...times, events })];
    });
  }
}

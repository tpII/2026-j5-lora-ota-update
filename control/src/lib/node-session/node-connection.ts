/**
 * One connected node: its transport, the records of what goes through its console and the state
 * derived from its events. The node identifier comes from `boot` or `status`; the connection asks
 * for `status` as soon as it opens.
 */
import { STATUS_COMMAND } from "$lib/commands/console-command.ts";
import { parseConsoleLine, type ParsedConsoleLine } from "$lib/console/console-line-parser.ts";
import { INITIAL_NODE_STATE, applyConsoleEvent, type NodeState } from "./node-state.ts";
import { SYSTEM_TIME_SOURCE, type TimeSource } from "$lib/utils/time-source.ts";
import { describeError } from "$lib/utils/error-description.ts";
import type { ConsoleTransport, TransportClosure } from "$lib/transports/console-transport.ts";

const IDENTITY_RETRY_MILLISECONDS = 3000;
const MAXIMUM_STATUS_REQUESTS = 3;

export type ConnectionStatus = "opening" | "open" | "closing" | "closed";

export const CONNECTION_STATUS_LABELS: { readonly [Status in ConnectionStatus]: string } = {
  opening: "Abriendo",
  open: "Conectado",
  closing: "Cerrando",
  closed: "Desconectado",
};

interface RecordHeader {
  /** Position in the order of arrival across every connection of the panel. */
  readonly sequence: number;
  readonly connectionKey: string;
  /** Milliseconds since 1970 on the host. */
  readonly hostTime: number;
}

/** One record: a line from the node, a command sent to it or a notice of the panel. */
export type ConsoleRecord = RecordHeader &
  (
    | ParsedConsoleLine
    | { readonly kind: "command"; readonly text: string }
    | { readonly kind: "notice"; readonly text: string }
  );

export type ConsoleRecordListener = (record: ConsoleRecord, connection: NodeConnection) => void;
export type ConnectionStatusListener = (connection: NodeConnection) => void;

let panelSequence = 0;

export interface NodeConnectionOptions {
  /** Name of the connection inside the panel, for example "usb-1". */
  readonly key: string;
  readonly transport: ConsoleTransport;
  readonly timeSource?: TimeSource;
}

export class NodeConnection {
  readonly key: string;
  readonly transport: ConsoleTransport;
  readonly #timeSource: TimeSource;
  readonly #recordListeners = new Set<ConsoleRecordListener>();
  readonly #statusListeners = new Set<ConnectionStatusListener>();
  #status: ConnectionStatus = "opening";
  #closureMessage: string | null = null;
  #state: NodeState = INITIAL_NODE_STATE;
  #statusRequests = 0;
  #cancelIdentityRetry: (() => void) | null = null;
  #revision = 0;

  constructor(options: NodeConnectionOptions) {
    this.key = options.key;
    this.transport = options.transport;
    this.#timeSource = options.timeSource ?? SYSTEM_TIME_SOURCE;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  /** Cause of an unexpected closure, in Spanish. */
  get closureMessage(): string | null {
    return this.#closureMessage;
  }

  get state(): NodeState {
    return this.#state;
  }

  /** Increases with every record and every change of status. */
  get revision(): number {
    return this.#revision;
  }

  /** Opens the transport and asks the node for its status. */
  async open(): Promise<void> {
    try {
      await this.transport.open({
        acceptLine: (line) => this.#acceptLine(line),
        acceptClosure: (closure) => this.#acceptClosure(closure),
      });
    } catch (error) {
      this.#closureMessage = describeError(error);
      this.#appendRecord({
        kind: "notice",
        text: `No se pudo abrir la conexión: ${this.#closureMessage}`,
      });
      this.#setStatus("closed");
      throw error;
    }
    if (this.#status !== "opening") {
      return;
    }
    this.#setStatus("open");
    this.#appendRecord({
      kind: "notice",
      text: `Conexión abierta (${this.transport.description}).`,
    });
    await this.#requestIdentity();
  }

  /** Sends one command line to the node and records it. */
  async sendCommand(command: string): Promise<void> {
    if (this.#status !== "open") {
      throw new Error("El nodo no está conectado.");
    }
    this.#appendRecord({ kind: "command", text: command });
    await this.transport.writeLine(command);
  }

  async close(): Promise<void> {
    if (this.#status === "closed" || this.#status === "closing") {
      return;
    }
    this.#setStatus("closing");
    // The transport reports its closure through acceptClosure, which settles the status.
    await this.transport.close();
  }

  subscribe(listener: ConsoleRecordListener): () => void {
    this.#recordListeners.add(listener);
    return () => this.#recordListeners.delete(listener);
  }

  subscribeToStatus(listener: ConnectionStatusListener): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async #requestIdentity(): Promise<void> {
    if (this.#status !== "open" || this.#state.identifier !== null) {
      return;
    }
    if (this.#statusRequests >= MAXIMUM_STATUS_REQUESTS) {
      this.#appendRecord({
        kind: "notice",
        text: "El nodo no respondió a status: se esperan sus eventos para conocer su identificador.",
      });
      return;
    }
    this.#statusRequests += 1;
    this.#cancelIdentityRetry?.();
    this.#cancelIdentityRetry = this.#timeSource.schedule(() => {
      this.#cancelIdentityRetry = null;
      void this.#requestIdentity();
    }, IDENTITY_RETRY_MILLISECONDS);
    try {
      await this.sendCommand(STATUS_COMMAND);
    } catch (error) {
      this.#appendRecord({
        kind: "notice",
        text: `No se pudo pedir el estado: ${describeError(error)}`,
      });
    }
  }

  #acceptLine(line: string): void {
    const parsed = parseConsoleLine(line);
    if (parsed.kind === "event") {
      this.#state = applyConsoleEvent(this.#state, parsed.event, this.#timeSource.now());
      if (this.#state.identifier !== null && this.#cancelIdentityRetry !== null) {
        this.#cancelIdentityRetry();
        this.#cancelIdentityRetry = null;
      }
    }
    this.#appendRecord(parsed);
  }

  #acceptClosure(closure: TransportClosure): void {
    if (this.#status === "closed") {
      return;
    }
    this.#cancelIdentityRetry?.();
    this.#cancelIdentityRetry = null;
    this.#closureMessage = closure.requested ? null : closure.message;
    this.#appendRecord({
      kind: "notice",
      text: closure.requested ? "Conexión cerrada." : (closure.message ?? "Se perdió la conexión."),
    });
    this.#setStatus("closed");
  }

  #appendRecord(content: DistributiveOmit<ConsoleRecord, keyof RecordHeader>): void {
    panelSequence += 1;
    const record = {
      ...content,
      sequence: panelSequence,
      connectionKey: this.key,
      hostTime: this.#timeSource.now(),
    } as ConsoleRecord;
    this.#revision += 1;
    for (const listener of this.#recordListeners) {
      listener(record, this);
    }
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    this.#revision += 1;
    for (const listener of this.#statusListeners) {
      listener(this);
    }
  }
}

type DistributiveOmit<Type, Key extends PropertyKey> = Type extends unknown
  ? Omit<Type, Key>
  : never;

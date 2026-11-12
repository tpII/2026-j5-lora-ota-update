/**
 * The connections of the panel and the node the operator chose. It keeps one immutable view per
 * connection for the components (node-session/connection-view.ts) and the lookups every section needs
 * (by key, by node identifier).
 */
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import {
  isIdentified,
  reachesSameNode,
  type ConnectionView,
  type IdentifiedConnection,
} from "$lib/node-session/connection-view.ts";
import type { NodeConnection } from "$lib/node-session/node-connection.ts";
import type { NodePort } from "$lib/nodes/node-port.ts";
import type { TransportKind } from "$lib/transports/console-transport.ts";

const CONNECTION_KEY_PREFIXES: { readonly [Kind in TransportKind]: string } = {
  serial: "usb",
  websocket: "wifi",
};

export interface NodeDirectoryOptions {
  /** Called after the operator chooses another node. */
  readonly onSelectionChange?: () => void;
}

export class NodeDirectory {
  /** Every connection, in the order it was opened; published by `publish()`. */
  connections = $state.raw<readonly ConnectionView[]>([]);
  /** The open connections, identified or not: every console that takes a line. */
  open = $state.raw<readonly ConnectionView[]>([]);
  /** The open connections whose node is identified. */
  identified = $state.raw<readonly IdentifiedConnection[]>([]);
  /**
   * Connection that the operator chose in the node strip: the center of the connection graph and
   * the node whose detail the panel shows. When it is null or gone, the first connection takes its
   * place.
   */
  selectedKey = $state<string | null>(null);

  readonly #connections = new Map<string, NodeConnection>();
  readonly #viewCache = new Map<string, { revision: number; view: ConnectionView }>();
  readonly #onSelectionChange: (() => void) | undefined;
  #connectionCounter = 0;

  constructor(options: NodeDirectoryOptions = {}) {
    this.#onSelectionChange = options.onSelectionChange;
  }

  /** The connection chosen in the node strip, or the first one; null without connections. */
  get selected(): ConnectionView | null {
    return (
      this.connections.find((connection) => connection.key === this.selectedKey) ??
      this.connections[0] ??
      null
    );
  }

  /**
   * The chosen connection when its node takes commands. Every section acts on it; null tells the
   * section to ask the operator to choose such a node above.
   */
  get selectedIdentified(): IdentifiedConnection | null {
    const connection = this.selected;
    return connection !== null && isIdentified(connection) ? connection : null;
  }

  get hasWebSocketConnection(): boolean {
    return this.connections.some(
      (connection) => connection.transportKind === "websocket" && connection.status !== "closed",
    );
  }

  byKey(key: string): ConnectionView | null {
    return this.connections.find((connection) => connection.key === key) ?? null;
  }

  identifiedByKey(key: string): IdentifiedConnection | null {
    return this.identified.find((connection) => connection.key === key) ?? null;
  }

  /** The first open connection to the node; a closed duplicate never takes its place. */
  byIdentifier(identifier: NodeIdentifier): IdentifiedConnection | null {
    return this.identified.find((connection) => connection.state.identifier === identifier) ?? null;
  }

  select(key: string): void {
    if (this.selectedKey !== key) {
      this.selectedKey = key;
      this.#onSelectionChange?.();
    }
  }

  /** Restores a choice saved before, without moving away from a node chosen meanwhile. */
  restoreSelection(key: string | null, unlessChanged: string): void {
    if (this.selectedKey === unlessChanged) {
      this.selectedKey = key;
      this.#onSelectionChange?.();
    }
  }

  /** A key for a new connection over `kind`, such as "usb-1" or "wifi-2". */
  nextKey(kind: TransportKind): string {
    this.#connectionCounter += 1;
    return `${CONNECTION_KEY_PREFIXES[kind]}-${this.#connectionCounter}`;
  }

  add(connection: NodeConnection): void {
    this.#connections.set(connection.key, connection);
  }

  /** Forgets a connection whatever its status, for one that did not open. */
  forget(key: string): void {
    this.#connections.delete(key);
    this.#viewCache.delete(key);
  }

  /** Forgets a closed connection; returns false when it is not closed. */
  remove(key: string): boolean {
    const connection = this.#connections.get(key);
    if (connection === undefined || connection.status !== "closed") {
      return false;
    }
    this.forget(key);
    return true;
  }

  /** The live connection behind a view, for sending to it. */
  connection(key: string): NodeConnection | undefined {
    return this.#connections.get(key);
  }

  /** True when a connection other than `connection` still reaches its node. */
  isReachedElsewhere(connection: NodeConnection): boolean {
    return [...this.#connections.values()].some((other) => reachesSameNode(connection, other));
  }

  /** The connection as the radio tests see a node; null unless it is open and identified. */
  port(key: string): NodePort | null {
    const connection = this.#connections.get(key);
    const identifier = connection?.state.identifier ?? null;
    if (connection === undefined || identifier === null || connection.status !== "open") {
      return null;
    }
    return {
      identifier,
      sendCommand: (command) => connection.sendCommand(command),
      subscribe: (listener) =>
        connection.subscribe((record) => {
          if (record.kind === "event") {
            listener(record.event, record.hostTime);
          }
        }),
    };
  }

  /** Publishes the views of the connections; a view changes only when its connection did. */
  publish(): void {
    const live = [...this.#connections.values()];
    const connections = live.map((connection): ConnectionView => {
      const duplicated =
        connection.status !== "closed" && live.some((other) => reachesSameNode(connection, other));
      const cached = this.#viewCache.get(connection.key);
      if (
        cached !== undefined &&
        cached.revision === connection.revision &&
        cached.view.duplicated === duplicated
      ) {
        return cached.view;
      }
      const view: ConnectionView = {
        key: connection.key,
        transportKind: connection.transport.kind,
        transportDescription: connection.transport.description,
        status: connection.status,
        closureMessage: connection.closureMessage,
        state: connection.state,
        duplicated,
      };
      this.#viewCache.set(connection.key, { revision: connection.revision, view });
      return view;
    });
    if (!haveSameElements(connections, this.connections)) {
      this.connections = connections;
      this.open = connections.filter((connection) => connection.status === "open");
      this.identified = connections.filter(isIdentified);
    }
  }
}

function haveSameElements<Element>(first: readonly Element[], second: readonly Element[]): boolean {
  return (
    first.length === second.length && first.every((element, index) => element === second[index])
  );
}

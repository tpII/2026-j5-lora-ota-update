/**
 * A console transport that reaches a simulated node, for the tests of the panel: the lines the
 * node writes arrive as console lines, and the lines the panel writes are its commands.
 */
import type {
  ConsoleTransport,
  ConsoleTransportReceiver,
  TransportKind,
} from "$lib/transports/console-transport.ts";
import type { SimulatedNode } from "$lib/testing/simulated-node.ts";

export class SimulatedConsoleTransport implements ConsoleTransport {
  readonly kind: TransportKind;
  readonly description: string;
  readonly #node: SimulatedNode;
  #receiver: ConsoleTransportReceiver | null = null;
  #unsubscribe = (): void => {};

  constructor(node: SimulatedNode, kind: TransportKind = "serial") {
    this.#node = node;
    this.kind = kind;
    this.description = `simulated ${node.identifier}`;
  }

  open(receiver: ConsoleTransportReceiver): Promise<void> {
    this.#receiver = receiver;
    this.#unsubscribe = this.#node.subscribeToLines((line) => receiver.acceptLine(line));
    return Promise.resolve();
  }

  writeLine(line: string): Promise<void> {
    return this.#node.sendCommand(line);
  }

  close(): Promise<void> {
    this.#unsubscribe();
    const receiver = this.#receiver;
    this.#receiver = null;
    receiver?.acceptClosure({ requested: true, message: null });
    return Promise.resolve();
  }

  /** Ends the connection as a lost cable would. */
  lose(): void {
    this.#unsubscribe();
    const receiver = this.#receiver;
    this.#receiver = null;
    receiver?.acceptClosure({ requested: false, message: "Se perdió la conexión." });
  }
}

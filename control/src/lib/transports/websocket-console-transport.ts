/**
 * Console over WiFi: a WebSocket to the access point of the node (ADR 0002 and ADR 0003). Each
 * text message carries one console line, without its line end, in both directions.
 */
import { SYSTEM_TIME_SOURCE, type TimeSource } from "$lib/utils/time-source.ts";
import type { ConsoleTransport, ConsoleTransportReceiver } from "./console-transport.ts";

export const DEFAULT_CONSOLE_ADDRESS = "ws://192.168.4.1/console";

const DEFAULT_OPEN_TIMEOUT_MILLISECONDS = 8000;
const CLOSE_TIMEOUT_MILLISECONDS = 2000;
const NORMAL_CLOSURE_CODE = 1000;

/** Options of the WebSocket constructor in Chromium 154 and later (ADR 0003). */
export interface LocalNetworkWebSocketOptions {
  readonly targetAddressSpace: "local";
}

/** The members of WebSocket the transport needs, so the tests can provide a fake socket. */
export type WebSocketAccess = Pick<
  WebSocket,
  "readyState" | "send" | "close" | "addEventListener" | "removeEventListener"
>;

export type WebSocketFactory = (address: string) => WebSocketAccess;

type WebSocketConstructorWithOptions = new (
  address: string,
  options?: LocalNetworkWebSocketOptions,
) => WebSocket;

/**
 * Opens a WebSocket that declares its target as the local network, so that Chromium asks for the
 * local network access permission. The TypeScript library does not know the options argument, and
 * a browser without it reads the object as a subprotocol name and throws SyntaxError: in that case
 * the socket opens without options.
 */
export function createLocalNetworkWebSocket(address: string): WebSocket {
  const Constructor = WebSocket as unknown as WebSocketConstructorWithOptions;
  try {
    return new Constructor(address, { targetAddressSpace: "local" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "SyntaxError") {
      return new WebSocket(address);
    }
    throw error;
  }
}

const OPEN = 1;

export interface WebSocketConsoleTransportOptions {
  readonly createSocket?: WebSocketFactory;
  readonly timeSource?: TimeSource;
  readonly openTimeoutMilliseconds?: number;
}

export class WebSocketConsoleTransport implements ConsoleTransport {
  readonly kind = "websocket";
  readonly description: string;
  readonly #address: string;
  readonly #createSocket: WebSocketFactory;
  readonly #timeSource: TimeSource;
  readonly #openTimeout: number;
  #socket: WebSocketAccess | null = null;
  #receiver: ConsoleTransportReceiver | null = null;
  #closeRequested = false;
  #closed = false;
  #closedSignal: (() => void) | null = null;

  constructor(address = DEFAULT_CONSOLE_ADDRESS, options: WebSocketConsoleTransportOptions = {}) {
    this.#address = address;
    this.description = address;
    this.#createSocket = options.createSocket ?? createLocalNetworkWebSocket;
    this.#timeSource = options.timeSource ?? SYSTEM_TIME_SOURCE;
    this.#openTimeout = options.openTimeoutMilliseconds ?? DEFAULT_OPEN_TIMEOUT_MILLISECONDS;
  }

  open(receiver: ConsoleTransportReceiver): Promise<void> {
    this.#receiver = receiver;
    const socket = this.#createSocket(this.#address);
    this.#socket = socket;
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      const cancelTimeout = this.#timeSource.schedule(() => {
        if (!opened) {
          this.#closeRequested = true;
          socket.close();
          reject(new Error(this.#unreachableMessage()));
        }
      }, this.#openTimeout);

      socket.addEventListener("open", () => {
        opened = true;
        cancelTimeout();
        resolve();
      });
      socket.addEventListener("message", (event) => {
        this.#acceptMessage((event as MessageEvent<unknown>).data);
      });
      socket.addEventListener("close", (event) => {
        cancelTimeout();
        if (!opened) {
          reject(new Error(this.#unreachableMessage()));
          this.#closed = true;
          return;
        }
        this.#finish((event as CloseEvent).code);
      });
      // An "error" event is always followed by "close", which reports the closure.
    });
  }

  writeLine(line: string): Promise<void> {
    const socket = this.#socket;
    if (socket === null || this.#closed || this.#closeRequested || socket.readyState !== OPEN) {
      return Promise.reject(new Error("La conexión WiFi está cerrada."));
    }
    socket.send(line);
    return Promise.resolve();
  }

  close(): Promise<void> {
    const socket = this.#socket;
    if (socket === null || this.#closed) {
      this.#closed = true;
      return Promise.resolve();
    }
    this.#closeRequested = true;
    return new Promise<void>((resolve) => {
      const cancelTimeout = this.#timeSource.schedule(() => {
        // The node did not answer the closing handshake: report the closure anyway.
        this.#finish(NORMAL_CLOSURE_CODE);
        resolve();
      }, CLOSE_TIMEOUT_MILLISECONDS);
      this.#closedSignal = () => {
        cancelTimeout();
        resolve();
      };
      socket.close(NORMAL_CLOSURE_CODE);
    });
  }

  #acceptMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }
    // The contract sends one line per message; split anyway in case a message carries several.
    for (const line of data.split("\n")) {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.length > 0) {
        this.#receiver?.acceptLine(trimmed);
      }
    }
  }

  #finish(code: number): void {
    if (this.#closed) {
      this.#closedSignal?.();
      return;
    }
    this.#closed = true;
    const message = this.#closeRequested
      ? null
      : `Se perdió la conexión WiFi con ${this.#address} (código ${code}).`;
    this.#receiver?.acceptClosure({ requested: this.#closeRequested, message });
    this.#closedSignal?.();
  }

  #unreachableMessage(): string {
    return (
      `No se pudo abrir ${this.#address}. La computadora debe estar asociada a la red J5-<id> del ` +
      "nodo y el navegador debe tener el permiso de acceso a la red local."
    );
  }
}

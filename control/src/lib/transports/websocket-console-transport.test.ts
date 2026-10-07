import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ManualTimeSource } from "$lib/utils/time-source.ts";
import type { TransportClosure } from "./console-transport.ts";
import {
  DEFAULT_CONSOLE_ADDRESS,
  WebSocketConsoleTransport,
  createLocalNetworkWebSocket,
  type WebSocketAccess,
} from "./websocket-console-transport.ts";

/** A socket the test drives by hand. */
class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];
  closeCode: number | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCode = code ?? 1005;
    this.readyState = 3;
    queueMicrotask(() =>
      this.dispatchEvent(Object.assign(new Event("close"), { code: this.closeCode })),
    );
  }

  accept(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  deliver(data: unknown): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }

  drop(code: number): void {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}

function createTransport() {
  const clock = new ManualTimeSource(0);
  const socket = new FakeSocket();
  const addresses: string[] = [];
  const transport = new WebSocketConsoleTransport(DEFAULT_CONSOLE_ADDRESS, {
    timeSource: clock,
    createSocket: (address) => {
      addresses.push(address);
      return socket as unknown as WebSocketAccess;
    },
  });
  const lines: string[] = [];
  const closures: TransportClosure[] = [];
  const receiver = {
    acceptLine: (line: string) => lines.push(line),
    acceptClosure: (closure: TransportClosure) => closures.push(closure),
  };
  return { clock, socket, transport, addresses, lines, closures, receiver };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebSocketConsoleTransport", () => {
  it("connects to the console of the access point", async () => {
    const { socket, transport, receiver, addresses } = createTransport();
    const opening = transport.open(receiver);
    socket.accept();
    await opening;
    expect(addresses).toEqual(["ws://192.168.4.1/console"]);
    expect(transport.description).toBe("ws://192.168.4.1/console");
  });

  it("takes one line per text message and sends commands without a line end", async () => {
    const { socket, transport, receiver, lines } = createTransport();
    const opening = transport.open(receiver);
    socket.accept();
    await opening;
    socket.deliver('{"t":5400,"ev":"wifi","state":"on","ssid":"J5-3A7F","channel":1,"clients":1}');
    socket.deliver("wifi 1 client(s)");
    socket.deliver("first\nsecond\r\n");
    socket.deliver(new ArrayBuffer(4));
    await transport.writeLine("status");
    expect(lines).toEqual([
      '{"t":5400,"ev":"wifi","state":"on","ssid":"J5-3A7F","channel":1,"clients":1}',
      "wifi 1 client(s)",
      "first",
      "second",
    ]);
    expect(socket.sent).toEqual(["status"]);
  });

  it("fails to open when the node does not answer in time", async () => {
    const { clock, transport, receiver } = createTransport();
    const opening = transport.open(receiver);
    clock.advanceBy(8000);
    await expect(opening).rejects.toThrow("No se pudo abrir ws://192.168.4.1/console.");
  });

  it("fails to open when the socket closes first", async () => {
    const { socket, transport, receiver, closures } = createTransport();
    const opening = transport.open(receiver);
    socket.drop(1006);
    await expect(opening).rejects.toThrow("permiso de acceso a la red local");
    expect(closures).toEqual([]);
  });

  it("reports the loss of the connection", async () => {
    const { socket, transport, receiver, closures } = createTransport();
    const opening = transport.open(receiver);
    socket.accept();
    await opening;
    socket.drop(1006);
    expect(closures).toEqual([
      {
        requested: false,
        message: "Se perdió la conexión WiFi con ws://192.168.4.1/console (código 1006).",
      },
    ]);
    await expect(transport.writeLine("status")).rejects.toThrow("La conexión WiFi está cerrada.");
  });

  it("closes on request", async () => {
    const { socket, transport, receiver, closures } = createTransport();
    const opening = transport.open(receiver);
    socket.accept();
    await opening;
    await transport.close();
    expect(socket.closeCode).toBe(1000);
    expect(closures).toEqual([{ requested: true, message: null }]);
  });
});

describe("createLocalNetworkWebSocket", () => {
  it("passes the local address space option of ADR 0003", () => {
    const calls: unknown[][] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(...arguments_: unknown[]) {
          calls.push(arguments_);
        }
      },
    );
    createLocalNetworkWebSocket(DEFAULT_CONSOLE_ADDRESS);
    expect(calls).toEqual([[DEFAULT_CONSOLE_ADDRESS, { targetAddressSpace: "local" }]]);
  });

  it("opens without options in a browser that takes the object for a subprotocol", () => {
    const calls: unknown[][] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(...arguments_: unknown[]) {
          calls.push(arguments_);
          if (arguments_.length > 1) {
            throw new DOMException("The subprotocol '[object Object]' is invalid.", "SyntaxError");
          }
        }
      },
    );
    createLocalNetworkWebSocket(DEFAULT_CONSOLE_ADDRESS);
    expect(calls).toEqual([
      [DEFAULT_CONSOLE_ADDRESS, { targetAddressSpace: "local" }],
      [DEFAULT_CONSOLE_ADDRESS],
    ]);
  });
});

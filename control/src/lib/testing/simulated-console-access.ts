/**
 * Browser access to the consoles of simulated nodes, for the simulation build of the panel
 * (src/simulation.ts): a Web Serial port that reaches one node and a WebSocket class that reaches
 * another. The panel keeps its own transports, so SerialConsoleTransport and
 * WebSocketConsoleTransport frame the lines as they do with the boards.
 */
import { ConsoleLineSplitter } from "$lib/console/console-line-splitter.ts";
import type { SimulatedNode } from "./simulated-node.ts";

/** USB identifiers the simulated port reports: those of the USB bridge of the V4.3. */
const SIMULATED_USB_VENDOR_ID = 0x303a;
const SIMULATED_USB_PRODUCT_ID = 0x1001;

/** Time the simulated access point takes to accept a WebSocket. */
const WEBSOCKET_OPEN_DELAY_MILLISECONDS = 80;

const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;
const NORMAL_CLOSURE_CODE = 1000;

/** A serial port whose stream carries the console of `node`, one line per "\n". */
function createSerialPort(node: SimulatedNode): SerialPort {
  const encoder = new TextEncoder();
  const splitter = new ConsoleLineSplitter();
  let unsubscribe = (): void => {};
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = node.subscribeToLines((line) =>
        controller.enqueue(encoder.encode(`${line}\n`)),
      );
    },
    cancel() {
      unsubscribe();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      for (const line of splitter.acceptBytes(chunk)) {
        void node.sendCommand(line);
      }
    },
  });
  const port = {
    readable,
    writable,
    getInfo: () => ({
      usbVendorId: SIMULATED_USB_VENDOR_ID,
      usbProductId: SIMULATED_USB_PRODUCT_ID,
    }),
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    setSignals: () => Promise.resolve(),
  };
  return port as unknown as SerialPort;
}

/** A WebSocket class whose sockets carry the console of `node`, one line per message. */
function createWebSocketClass(node: SimulatedNode): typeof WebSocket {
  class SimulatedWebSocket extends EventTarget {
    readonly url: string;
    readyState = 0;
    #unsubscribe = (): void => {};

    constructor(url: string) {
      super();
      this.url = url;
      setTimeout(() => {
        this.readyState = WEBSOCKET_OPEN;
        this.#unsubscribe = node.subscribeToLines((line) =>
          this.dispatchEvent(new MessageEvent("message", { data: line })),
        );
        this.dispatchEvent(new Event("open"));
      }, WEBSOCKET_OPEN_DELAY_MILLISECONDS);
    }

    send(line: string): void {
      void node.sendCommand(line);
    }

    close(code = NORMAL_CLOSURE_CODE): void {
      this.#unsubscribe();
      this.readyState = WEBSOCKET_CLOSED;
      this.dispatchEvent(new CloseEvent("close", { code }));
    }
  }
  return SimulatedWebSocket as unknown as typeof WebSocket;
}

/**
 * Replaces Web Serial and WebSocket in this page: choosing a serial port reaches `serialNode`, and
 * opening the console over WiFi reaches `websocketNode`.
 */
export function installSimulatedConsoleAccess(
  serialNode: SimulatedNode,
  websocketNode: SimulatedNode,
): void {
  const port = createSerialPort(serialNode);
  const serial = {
    requestPort: () => Promise.resolve(port),
    getPorts: () => Promise.resolve([]),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  Object.defineProperty(navigator, "serial", { value: serial, configurable: true });
  globalThis.WebSocket = createWebSocketClass(websocketNode);
}

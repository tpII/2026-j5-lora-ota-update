import { describe, expect, it } from "vite-plus/test";
import type { TransportClosure } from "./console-transport.ts";
import {
  CONSOLE_BAUD_RATE,
  SerialConsoleTransport,
  describeSerialPort,
  type SerialPortAccess,
} from "./serial-console-transport.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A serial port backed by streams the test controls, like the one Web Serial returns. */
class FakeSerialPort implements SerialPortAccess {
  openOptions: SerialOptions | null = null;
  readonly signals: SerialOutputSignals[] = [];
  readonly written: string[] = [];
  closed = false;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #readable: ReadableStream<Uint8Array> | null = null;
  readonly writable: WritableStream<Uint8Array>;

  constructor() {
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.written.push(decoder.decode(chunk));
      },
    });
    this.#replaceReadable();
  }

  get readable(): ReadableStream<Uint8Array> | null {
    return this.#readable;
  }

  open(options: SerialOptions): Promise<void> {
    this.openOptions = options;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  getInfo(): SerialPortInfo {
    return { usbVendorId: 0x10c4, usbProductId: 0xea60 };
  }

  setSignals(signals: SerialOutputSignals): Promise<void> {
    this.signals.push(signals);
    return Promise.resolve();
  }

  receive(text: string): void {
    this.#controller.enqueue(encoder.encode(text));
  }

  /** A framing error: Web Serial errors the stream and offers a new one. */
  failRecoverably(): void {
    const controller = this.#controller;
    this.#replaceReadable();
    controller.error(Object.assign(new Error("Framing error."), { name: "FramingError" }));
  }

  /** The device was unplugged. */
  lose(): void {
    this.#controller.error(
      Object.assign(new Error("The device has been lost."), { name: "NetworkError" }),
    );
    this.#readable = null;
  }

  #replaceReadable(): void {
    this.#readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
  }
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createTransport() {
  const port = new FakeSerialPort();
  const transport = new SerialConsoleTransport(port);
  const lines: string[] = [];
  const closures: TransportClosure[] = [];
  const receiver = {
    acceptLine: (line: string) => lines.push(line),
    acceptClosure: (closure: TransportClosure) => closures.push(closure),
  };
  return { port, transport, lines, closures, receiver };
}

describe("SerialConsoleTransport", () => {
  it("opens the port at 921600 baud 8N1 and releases DTR and RTS", async () => {
    const { port, transport, receiver } = createTransport();
    await transport.open(receiver);
    expect(port.openOptions).toMatchObject({
      baudRate: CONSOLE_BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
    });
    expect(port.signals).toEqual([{ dataTerminalReady: false, requestToSend: false }]);
    expect(transport.description).toBe("USB 10C4:EA60");
  });

  it("delivers whole lines from the byte stream", async () => {
    const { port, transport, receiver, lines } = createTransport();
    await transport.open(receiver);
    port.receive('{"t":1,"ev":"wi');
    port.receive('fi","state":"on"}\r\nboot 3A7F');
    port.receive(" V4.3 e12\n");
    await flushAsyncWork();
    expect(lines).toEqual(['{"t":1,"ev":"wifi","state":"on"}', "boot 3A7F V4.3 e12"]);
  });

  it("writes each command with a trailing line end, in order", async () => {
    const { port, transport, receiver } = createTransport();
    await transport.open(receiver);
    await Promise.all([transport.writeLine("status"), transport.writeLine("radio sf 9")]);
    expect(port.written).toEqual(["status\n", "radio sf 9\n"]);
  });

  it("keeps reading after a recoverable error", async () => {
    const { port, transport, receiver, lines, closures } = createTransport();
    await transport.open(receiver);
    port.receive("first\n");
    await flushAsyncWork();
    port.failRecoverably();
    await flushAsyncWork();
    port.receive("second\n");
    await flushAsyncWork();
    expect(lines).toEqual(["first", "second"]);
    expect(closures).toEqual([]);
  });

  it("reports the loss of the device once", async () => {
    const { port, transport, receiver, closures } = createTransport();
    await transport.open(receiver);
    port.lose();
    await flushAsyncWork();
    expect(closures).toEqual([
      { requested: false, message: "Se perdió la conexión USB: The device has been lost." },
    ]);
    expect(port.closed).toBe(true);
    await expect(transport.writeLine("status")).rejects.toThrow("La conexión USB está cerrada.");
    await transport.close();
    expect(closures).toHaveLength(1);
  });

  it("closes on request", async () => {
    const { port, transport, receiver, closures } = createTransport();
    await transport.open(receiver);
    await transport.close();
    expect(closures).toEqual([{ requested: true, message: null }]);
    expect(port.closed).toBe(true);
  });
});

describe("describeSerialPort", () => {
  it("shows the USB identifiers in hexadecimal", () => {
    expect(describeSerialPort({ usbVendorId: 0x303a, usbProductId: 0x1001 })).toBe("USB 303A:1001");
    expect(describeSerialPort({})).toBe("USB");
  });
});

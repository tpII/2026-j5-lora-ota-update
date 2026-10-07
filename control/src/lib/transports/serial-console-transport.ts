/**
 * Console over USB serial through Web Serial: 921600 baud, 8N1, lines ended in "\n".
 * Several ports can be open at once, one transport each.
 */
import { ConsoleLineSplitter } from "$lib/console/console-line-splitter.ts";
import {
  describeTransportError,
  type ConsoleTransport,
  type ConsoleTransportReceiver,
} from "./console-transport.ts";

export const CONSOLE_BAUD_RATE = 921600;

/** Read buffer of the port; the node writes bursts of events during a run. */
const SERIAL_BUFFER_SIZE = 64 * 1024;

/** The members of SerialPort the transport needs, so the tests can provide a fake port. */
export type SerialPortAccess = Pick<
  SerialPort,
  "readable" | "writable" | "open" | "close" | "getInfo"
> &
  Partial<Pick<SerialPort, "setSignals">>;

/**
 * Errors after which Web Serial replaces `readable` with a new stream and the port stays usable.
 * Any other error, such as the loss of the device, ends the connection.
 */
const RECOVERABLE_SERIAL_ERRORS = new Set([
  "BreakError",
  "BufferOverrunError",
  "FramingError",
  "ParityError",
]);

function isRecoverableSerialError(error: unknown): boolean {
  return error instanceof Error && RECOVERABLE_SERIAL_ERRORS.has(error.name);
}

function formatUsbIdentifier(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

export function describeSerialPort(info: SerialPortInfo): string {
  if (info.usbVendorId === undefined || info.usbProductId === undefined) {
    return "USB";
  }
  return `USB ${formatUsbIdentifier(info.usbVendorId)}:${formatUsbIdentifier(info.usbProductId)}`;
}

const encoder = new TextEncoder();

export class SerialConsoleTransport implements ConsoleTransport {
  readonly kind = "serial";
  readonly description: string;
  readonly #port: SerialPortAccess;
  #receiver: ConsoleTransportReceiver | null = null;
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #readLoop: Promise<void> | null = null;
  #writeChain: Promise<void> = Promise.resolve();
  #closeRequested = false;
  #closed = false;

  constructor(port: SerialPortAccess) {
    this.#port = port;
    this.description = describeSerialPort(port.getInfo());
  }

  async open(receiver: ConsoleTransportReceiver): Promise<void> {
    this.#receiver = receiver;
    await this.#port.open({
      baudRate: CONSOLE_BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      bufferSize: SERIAL_BUFFER_SIZE,
    });
    try {
      // Release DTR and RTS: on these boards they drive the reset and boot pins of the ESP32.
      await this.#port.setSignals?.({ dataTerminalReady: false, requestToSend: false });
    } catch {
      // Some adapters do not support the control signals; the console works without them.
    }
    this.#readLoop = this.#readContinuously();
  }

  writeLine(line: string): Promise<void> {
    const write = this.#writeChain.then(async () => {
      const writable = this.#port.writable;
      if (this.#closed || this.#closeRequested || writable === null) {
        throw new Error("La conexión USB está cerrada.");
      }
      const writer = writable.getWriter();
      try {
        await writer.write(encoder.encode(`${line}\n`));
      } finally {
        writer.releaseLock();
      }
    });
    this.#writeChain = write.catch(() => undefined);
    return write;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closeRequested = true;
    if (this.#readLoop === null) {
      await this.#finish(null);
      return;
    }
    try {
      await this.#reader?.cancel();
    } catch {
      // The reader may already be released; the read loop ends anyway.
    }
    await this.#readLoop;
  }

  async #readContinuously(): Promise<void> {
    const splitter = new ConsoleLineSplitter();
    let failure: string | null = null;
    while (!this.#closeRequested && this.#port.readable !== null) {
      const reader = this.#port.readable.getReader();
      this.#reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          for (const line of splitter.acceptBytes(value)) {
            this.#receiver?.acceptLine(line);
          }
        }
      } catch (error) {
        if (!isRecoverableSerialError(error)) {
          failure = `Se perdió la conexión USB: ${describeTransportError(error)}`;
          break;
        }
      } finally {
        reader.releaseLock();
        this.#reader = null;
      }
    }
    if (!this.#closeRequested && failure === null) {
      failure = "Se perdió la conexión USB.";
    }
    for (const line of splitter.flush()) {
      this.#receiver?.acceptLine(line);
    }
    await this.#finish(failure);
  }

  async #finish(failure: string | null): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#writeChain;
    try {
      await this.#port.close();
    } catch {
      // A port whose device was unplugged may refuse to close; there is nothing left to release.
    }
    this.#receiver?.acceptClosure({ requested: this.#closeRequested, message: failure });
  }
}

/** True when the browser offers Web Serial in this context (Chromium over HTTPS or localhost). */
export function isWebSerialAvailable(): boolean {
  return typeof navigator !== "undefined" && navigator.serial !== undefined;
}

/** Asks the operator to choose a serial port and returns a transport for it. */
export async function requestSerialConsoleTransport(): Promise<SerialConsoleTransport> {
  const serial = navigator.serial;
  if (serial === undefined) {
    throw new Error("Este navegador no ofrece Web Serial.");
  }
  const port = await serial.requestPort();
  return new SerialConsoleTransport(port);
}

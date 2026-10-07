/**
 * A channel to the console of one node. Both transports carry the same protocol, one console line
 * at a time (docs/protocol/console.md).
 */

export type TransportKind = "serial" | "websocket";

export interface TransportClosure {
  /** True when the panel closed the transport; false when the connection was lost. */
  readonly requested: boolean;
  /** Cause of the loss for the operator, in Spanish, or null. */
  readonly message: string | null;
}

export interface ConsoleTransportReceiver {
  /** One console line, without its line end. */
  acceptLine(line: string): void;
  /** Called once, when the transport closes for any reason. */
  acceptClosure(closure: TransportClosure): void;
}

export interface ConsoleTransport {
  readonly kind: TransportKind;
  /** Short description for the operator, such as "USB 10C4:EA60" or the WebSocket address. */
  readonly description: string;
  open(receiver: ConsoleTransportReceiver): Promise<void>;
  /** Sends one command line; the transport adds whatever line end it needs. */
  writeLine(line: string): Promise<void>;
  close(): Promise<void>;
}

/** Message of an error for the operator. */
export function describeTransportError(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return String(error);
}

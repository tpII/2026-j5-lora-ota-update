import { describe, expect, it } from "vite-plus/test";
import type {
  ConsoleTransport,
  ConsoleTransportReceiver,
} from "$lib/transports/console-transport.ts";
import { NODE_SESSION_LOG, splitFixtureLines } from "$lib/testing/console-fixtures.ts";
import { NodeConnection, type ConsoleRecord } from "./node-connection.ts";
import { ManualTimeSource } from "$lib/utils/time-source.ts";

class FakeTransport implements ConsoleTransport {
  readonly kind = "serial";
  readonly description = "USB 10C4:EA60";
  readonly written: string[] = [];
  receiver: ConsoleTransportReceiver | null = null;
  openFailure: Error | null = null;

  open(receiver: ConsoleTransportReceiver): Promise<void> {
    if (this.openFailure !== null) {
      return Promise.reject(this.openFailure);
    }
    this.receiver = receiver;
    return Promise.resolve();
  }

  writeLine(line: string): Promise<void> {
    this.written.push(line);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.receiver?.acceptClosure({ requested: true, message: null });
    return Promise.resolve();
  }

  emit(line: string): void {
    this.receiver?.acceptLine(line);
  }

  lose(message: string): void {
    this.receiver?.acceptClosure({ requested: false, message });
  }
}

function createConnection(options: { logCapacity?: number } = {}) {
  const clock = new ManualTimeSource(1_759_840_000_000);
  const transport = new FakeTransport();
  let sequence = 0;
  const connection = new NodeConnection({
    key: "usb-1",
    transport,
    timeSource: clock,
    nextSequence: () => ++sequence,
    ...options,
  });
  return { clock, transport, connection };
}

describe("NodeConnection", () => {
  it("asks for the status as soon as it opens", async () => {
    const { connection, transport } = createConnection();
    expect(connection.status).toBe("opening");
    await connection.open();
    expect(connection.status).toBe("open");
    expect(transport.written).toEqual(["status"]);
    expect(connection.log.map((record) => [record.kind, record.text])).toEqual([
      ["notice", "Conexión abierta (USB 10C4:EA60)."],
      ["command", "status"],
    ]);
  });

  it("derives the state of the node and logs every line", async () => {
    const { connection, transport, clock } = createConnection();
    await connection.open();
    for (const line of splitFixtureLines(NODE_SESSION_LOG)) {
      clock.advanceBy(1);
      transport.emit(line);
    }
    expect(connection.state).toMatchObject({ identifier: "3A7F", model: "V4.3", epoch: 12 });
    const kinds = connection.log.map((record) => record.kind);
    expect(kinds.filter((kind) => kind === "event")).toHaveLength(25);
    expect(kinds.filter((kind) => kind === "unrecognized")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "debug")).toHaveLength(14);
    const sequences = connection.log.map((record) => record.sequence);
    expect(sequences).toEqual([...sequences].sort((first, second) => first - second));
  });

  it("asks for the status again while the node does not identify itself", async () => {
    const { connection, transport, clock } = createConnection();
    await connection.open();
    clock.advanceBy(3000);
    clock.advanceBy(3000);
    expect(transport.written).toEqual(["status", "status", "status"]);
    clock.advanceBy(3000);
    expect(transport.written).toHaveLength(3);
    expect(connection.log.at(-1)).toMatchObject({ kind: "notice" });
  });

  it("stops asking once the node identifies itself", async () => {
    const { connection, transport, clock } = createConnection();
    await connection.open();
    transport.emit(
      '{"t":812,"ev":"boot","id":"3A7F","model":"V4.3","epoch":12,"firmware":"0.1.0","protocol":1,"key":"default"}',
    );
    clock.advanceBy(10_000);
    expect(transport.written).toEqual(["status"]);
    expect(clock.pendingCallCount).toBe(0);
  });

  it("keeps only the most recent records", async () => {
    const { connection, transport } = createConnection({ logCapacity: 5 });
    await connection.open();
    for (let index = 0; index < 20; index += 1) {
      transport.emit(`line ${index}`);
    }
    expect(connection.log.map((record) => record.text)).toEqual([
      "line 15",
      "line 16",
      "line 17",
      "line 18",
      "line 19",
    ]);
  });

  it("notifies every record to its subscribers", async () => {
    const { connection, transport } = createConnection();
    const received: ConsoleRecord[] = [];
    const unsubscribe = connection.subscribe((record) => received.push(record));
    await connection.open();
    transport.emit("boot 3A7F V4.3 e12");
    unsubscribe();
    transport.emit("ignored");
    expect(received.map((record) => record.kind)).toEqual(["notice", "command", "debug"]);
    expect(received[2]).toMatchObject({ connectionKey: "usb-1", text: "boot 3A7F V4.3 e12" });
  });

  it("reports the loss of the transport and refuses commands", async () => {
    const { connection, transport } = createConnection();
    const statuses: string[] = [];
    connection.subscribeToStatus((changed) => statuses.push(changed.status));
    await connection.open();
    transport.lose("Se perdió la conexión USB.");
    expect(connection.status).toBe("closed");
    expect(connection.closureMessage).toBe("Se perdió la conexión USB.");
    expect(statuses).toEqual(["open", "closed"]);
    expect(connection.log.at(-1)).toMatchObject({
      kind: "notice",
      text: "Se perdió la conexión USB.",
    });
    await expect(connection.sendCommand("radio")).rejects.toThrow("El nodo no está conectado.");
  });

  it("closes on request without an error message", async () => {
    const { connection } = createConnection();
    await connection.open();
    await connection.close();
    expect(connection.status).toBe("closed");
    expect(connection.closureMessage).toBeNull();
    expect(connection.log.at(-1)).toMatchObject({ kind: "notice", text: "Conexión cerrada." });
  });

  it("reports a transport that cannot open", async () => {
    const { connection, transport } = createConnection();
    transport.openFailure = new Error("Failed to open serial port.");
    await expect(connection.open()).rejects.toThrow("Failed to open serial port.");
    expect(connection.status).toBe("closed");
    expect(connection.closureMessage).toBe("Failed to open serial port.");
  });
});

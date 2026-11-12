import { describe, expect, it } from "vite-plus/test";
import { NodeConnection } from "$lib/node-session/node-connection.ts";
import { ManualTimeSource, flushAsyncWork } from "$lib/testing/manual-time-source.ts";
import { SimulatedConsoleTransport } from "$lib/testing/simulated-console-transport.ts";
import { SimulatedNode } from "$lib/testing/simulated-node.ts";
import { NodeDirectory } from "./node-directory.svelte.ts";

describe("NodeDirectory", () => {
  const clock = new ManualTimeSource(1_000_000);

  async function connect(
    directory: NodeDirectory,
    node: SimulatedNode,
  ): Promise<{ connection: NodeConnection; transport: SimulatedConsoleTransport }> {
    const transport = new SimulatedConsoleTransport(node);
    const connection = new NodeConnection({
      key: directory.nextKey(transport.kind),
      transport,
      timeSource: clock,
    });
    directory.add(connection);
    await connection.open();
    await node.settle();
    await flushAsyncWork();
    directory.publish();
    return { connection, transport };
  }

  it("looks up the open and identified connections by key and by identifier", async () => {
    const directory = new NodeDirectory();
    const first = new SimulatedNode("AAAA", "V2", clock);
    const second = new SimulatedNode("BBBB", "V4.3", clock);
    const { connection } = await connect(directory, first);
    await connect(directory, second);

    expect(directory.identified.map((view) => view.state.identifier)).toEqual(["AAAA", "BBBB"]);
    expect(directory.byIdentifier("BBBB")?.key).toBe("usb-2");
    expect(directory.identifiedByKey("usb-1")?.state.identifier).toBe("AAAA");
    expect(directory.selectedIdentified?.key).toBe("usb-1");
    directory.select("usb-2");
    expect(directory.selectedIdentified?.key).toBe("usb-2");

    await connection.close();
    directory.publish();
    expect(directory.byKey("usb-1")?.status).toBe("closed");
    expect(directory.identifiedByKey("usb-1")).toBeNull();
    expect(directory.byIdentifier("AAAA")).toBeNull();
    expect(directory.open.map((view) => view.key)).toEqual(["usb-2"]);
  });

  it("marks two live connections to one node as duplicated, and not a closed one", async () => {
    const directory = new NodeDirectory();
    const node = new SimulatedNode("AAAA", "V2", clock);
    const { connection: first } = await connect(directory, node);
    const { connection: second, transport } = await connect(directory, node);

    expect(directory.connections.map((view) => view.duplicated)).toEqual([true, true]);
    expect(directory.isReachedElsewhere(first)).toBe(true);
    expect(directory.byIdentifier("AAAA")?.key).toBe(first.key);

    transport.lose();
    directory.publish();
    expect(directory.connections.map((view) => view.duplicated)).toEqual([false, false]);
    expect(directory.isReachedElsewhere(first)).toBe(false);
    expect(directory.isReachedElsewhere(second)).toBe(true);
  });

  it("keeps the view of a connection that did not change", async () => {
    const directory = new NodeDirectory();
    await connect(directory, new SimulatedNode("AAAA", "V2", clock));
    const before = directory.connections;
    directory.publish();
    expect(directory.connections).toBe(before);
  });

  it("forgets only closed connections", async () => {
    const directory = new NodeDirectory();
    const { connection } = await connect(directory, new SimulatedNode("AAAA", "V2", clock));
    expect(directory.remove(connection.key)).toBe(false);
    await connection.close();
    expect(directory.remove(connection.key)).toBe(true);
    directory.publish();
    expect(directory.connections).toEqual([]);
  });
});

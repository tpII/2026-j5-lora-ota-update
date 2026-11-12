import { describe, expect, it } from "vite-plus/test";
import { reachesSameNode } from "./connection-view.ts";
import type { ConnectionStatus } from "./node-connection.ts";

function reach(status: ConnectionStatus, identifier: string | null) {
  return { status, state: { identifier } };
}

describe("reachesSameNode", () => {
  it("holds for another connection to the node until that one is closed", () => {
    const closed = reach("closed", "AAAA");
    expect(reachesSameNode(closed, reach("open", "AAAA"))).toBe(true);
    expect(reachesSameNode(closed, reach("closing", "AAAA"))).toBe(true);
    expect(reachesSameNode(reach("open", "AAAA"), reach("closed", "AAAA"))).toBe(false);
    expect(reachesSameNode(reach("open", "AAAA"), reach("open", "BBBB"))).toBe(false);
  });

  it("never holds for a connection itself or for a node not yet identified", () => {
    const connection = reach("open", "AAAA");
    expect(reachesSameNode(connection, connection)).toBe(false);
    expect(reachesSameNode(reach("open", null), reach("open", null))).toBe(false);
  });
});

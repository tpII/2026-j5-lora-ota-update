import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_OPERATOR_PUBLIC_KEY } from "./image-signing.ts";
import {
  checkImageVersion,
  highestAvailableVersion,
  operatorKeyDefinition,
  recoverProgram,
} from "./image-preparation.ts";
import type { ConnectionGraph, GraphNode } from "$lib/nodes/connection-graph.ts";
import { TEST_VECTOR_PROGRAM, TEST_VECTOR_VERSION } from "$lib/testing/image-test-vector.ts";

const NOW = TEST_VECTOR_VERSION * 1000;

function graphNode(id: string, availableVersion: number | null): GraphNode {
  return {
    id,
    model: "V2",
    connected: false,
    source: "neighbor",
    activeVersion: 0,
    availableVersion,
    vmFault: null,
    vmFailing: false,
    lastHeardHostTime: NOW,
  };
}

describe("operatorKeyDefinition", () => {
  it("writes the line of build_opt.h of docs/protocol/image.md", () => {
    expect(operatorKeyDefinition(DEFAULT_OPERATOR_PUBLIC_KEY)).toBe(
      `-DJ5_OPERATOR_PUBLIC_KEY="\\"${DEFAULT_OPERATOR_PUBLIC_KEY}\\""`,
    );
  });
});

describe("highestAvailableVersion", () => {
  it("takes the highest version the graph knows", () => {
    const graph: ConnectionGraph = {
      nodes: [graphNode("3A7F", 5), graphNode("5C21", null), graphNode("D6D8", 7)],
      links: [],
    };
    expect(highestAvailableVersion(graph)).toBe(7);
    expect(highestAvailableVersion({ nodes: [graphNode("3A7F", null)], links: [] })).toBeNull();
  });
});

describe("checkImageVersion", () => {
  const context = { targetAvailableVersion: 0, networkAvailableVersion: 0, nowMilliseconds: NOW };

  it("accepts the proposed version on a node with version 0", () => {
    expect(checkImageVersion(TEST_VECTOR_VERSION, context)).toEqual({
      acceptable: true,
      problem: null,
      warnings: [],
    });
  });

  it("refuses a version the node would reject", () => {
    expect(checkImageVersion(0, context).acceptable).toBe(false);
    expect(checkImageVersion(2 ** 32, context).acceptable).toBe(false);
    const check = checkImageVersion(7, { ...context, targetAvailableVersion: 7 });
    expect(check.acceptable).toBe(false);
    expect(check.problem).toContain("versión 7");
  });

  it("warns about the rest of the network, an unknown node and a clock ahead", () => {
    expect(checkImageVersion(8, { ...context, networkAvailableVersion: 9 }).warnings).toHaveLength(
      1,
    );
    expect(
      checkImageVersion(8, { ...context, targetAvailableVersion: null }).warnings,
    ).toHaveLength(1);
    expect(checkImageVersion(TEST_VECTOR_VERSION + 7200, context).warnings).toHaveLength(1);
  });
});

describe("recoverProgram", () => {
  it("returns the bytes of the program event", () => {
    const recovery = recoverProgram(TEST_VECTOR_PROGRAM);
    expect(recovery.valid && recovery.program.length).toBe(29);
  });

  it("refuses the empty factory program and text that is not hexadecimal", () => {
    expect(recoverProgram("").valid).toBe(false);
    expect(recoverProgram("0g").valid).toBe(false);
  });
});

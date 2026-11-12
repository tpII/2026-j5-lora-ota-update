import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_OPERATOR_PUBLIC_KEY } from "./image-signing.ts";
import { MAXIMUM_PROGRAM_SIZE } from "$lib/protocol/protocol-contract.ts";
import { formatHex } from "$lib/utils/hex.ts";
import {
  FUTURE_VERSION_TOLERANCE_SECONDS,
  checkImageVersion,
  operatorKeyDefinition,
  recoverProgram,
} from "./image-preparation.ts";
import {
  highestAvailableVersion,
  type ConnectionGraph,
  type GraphNode,
} from "$lib/node-session/connection-graph.ts";
import signedImageVector from "../../../../firmware/protocol/test-vectors/signed-image.json";

const NOW = signedImageVector.version * 1000;

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
    expect(checkImageVersion(signedImageVector.version, context)).toEqual({
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
    const latestOnTime = signedImageVector.version + FUTURE_VERSION_TOLERANCE_SECONDS;
    expect(checkImageVersion(latestOnTime, context).warnings).toEqual([]);
    expect(checkImageVersion(latestOnTime + 1, context).warnings).toHaveLength(1);
  });
});

describe("recoverProgram", () => {
  it("returns the bytes of the program event", () => {
    const recovery = recoverProgram(signedImageVector.program);
    expect(recovery.valid && formatHex(recovery.program)).toBe(signedImageVector.program);
  });

  it("refuses the empty factory program, text that is not hexadecimal and too long a program", () => {
    expect(recoverProgram("").valid).toBe(false);
    expect(recoverProgram("0g").valid).toBe(false);
    expect(recoverProgram("00".repeat(MAXIMUM_PROGRAM_SIZE)).valid).toBe(true);
    expect(recoverProgram("00".repeat(MAXIMUM_PROGRAM_SIZE + 1)).valid).toBe(false);
  });
});

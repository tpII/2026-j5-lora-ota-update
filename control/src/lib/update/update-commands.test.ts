import { describe, expect, it } from "vite-plus/test";
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import { parseConsoleLine } from "$lib/console/console-line-parser.ts";
import {
  INITIAL_NODE_STATE,
  applyConsoleEvent,
  type NodeState,
} from "$lib/node-session/node-state.ts";
import { UPDATE_VERSION } from "$lib/testing/console-fixtures.ts";
import signedImageVector from "../../../../firmware/protocol/test-vectors/signed-image.json";
import {
  loadResponseOf,
  loadedUpdateVersions,
  parseTypedUpdateCommand,
  settleLoadResponses,
  updateCommandTimesOf,
  type UpdateCommandRecord,
} from "./update-commands.ts";

function eventOf(line: string): ConsoleEvent {
  const parsed = parseConsoleLine(line);
  if (parsed.kind !== "event") {
    throw new Error(`not an event: ${line}`);
  }
  return parsed.event;
}

/** A node that received the given lines at the given host times. */
function stateAfter(...lines: readonly (readonly [number, string])[]): NodeState {
  return lines.reduce(
    (state, [hostTime, line]) => applyConsoleEvent(state, eventOf(line), hostTime),
    INITIAL_NODE_STATE,
  );
}

const IMAGE_7 = `{"t":1,"ev":"image","version":7,"size":5,"image_size":78,"via":"console","src":null,"fragments":0,"reports":0,"duration":0}`;
const LOAD_ERROR = `{"t":2,"ev":"error","cmd":"load_image","reason":"version_not_newer"}`;

const record = (
  hostTime: number,
  command: UpdateCommandRecord["command"],
  accepted?: boolean,
  connectionKey = "usb-1",
): UpdateCommandRecord => ({
  connectionKey,
  node: "5C21",
  hostTime,
  command,
  ...(accepted === undefined ? {} : { accepted }),
});

describe("parseTypedUpdateCommand", () => {
  it("reads the version of load_image and activate", () => {
    expect(parseTypedUpdateCommand(`load_image ${signedImageVector.image}`)).toEqual({
      kind: "load_image",
      version: UPDATE_VERSION,
    });
    expect(parseTypedUpdateCommand("activate 1762300800")).toEqual({
      kind: "activate",
      version: UPDATE_VERSION,
    });
    expect(parseTypedUpdateCommand("activate")).toBeNull();
    // The versions of buildActivateCommand: an image version, never 0 or beyond 32 bits.
    expect(parseTypedUpdateCommand("activate 0")).toBeNull();
    expect(parseTypedUpdateCommand("activate 4294967296")).toBeNull();
    expect(parseTypedUpdateCommand("load_image 4a35")).toBeNull();
    expect(parseTypedUpdateCommand("status")).toBeNull();
  });
});

describe("loadResponseOf", () => {
  it("accepts with the image of the version through the console after the load", () => {
    const state = stateAfter([15, IMAGE_7]);
    expect(loadResponseOf(state, { version: 7, hostTime: 10 })).toEqual({ kind: "accepted" });
    expect(loadResponseOf(state, { version: 7, hostTime: 20 })).toEqual({ kind: "waiting" });
    expect(loadResponseOf(state, { version: 8, hostTime: 10 })).toEqual({ kind: "waiting" });
  });

  it("rejects with an error of load_image after the load", () => {
    expect(loadResponseOf(stateAfter([15, LOAD_ERROR]), { version: 7, hostTime: 10 })).toEqual({
      kind: "rejected",
      error: {
        hostTime: 15,
        command: "load_image",
        reason: "version_not_newer",
        detail: null,
        code: null,
      },
    });
  });
});

describe("settleLoadResponses", () => {
  it("records the answer of each load of the connection that was waiting", () => {
    const commands = [
      record(10, { kind: "load_image", version: 7 }),
      record(12, { kind: "activate", version: 7 }),
      record(20, { kind: "load_image", version: 7 }, undefined, "ws-1"),
    ];
    expect(settleLoadResponses(commands, "usb-1", INITIAL_NODE_STATE)).toBe(commands);
    const accepted = settleLoadResponses(commands, "usb-1", stateAfter([15, IMAGE_7]));
    expect(accepted.map((command) => command.accepted)).toEqual([true, undefined, undefined]);
    expect(updateCommandTimesOf(accepted, 7)).toMatchObject({ loadHostTime: 10 });
    const rejected = settleLoadResponses(commands, "ws-1", stateAfter([25, LOAD_ERROR]));
    expect(rejected.map((command) => command.accepted)).toEqual([undefined, undefined, false]);
    expect(updateCommandTimesOf(rejected, 7)).toBeNull();
    // An answer once recorded stays.
    expect(settleLoadResponses(accepted, "usb-1", INITIAL_NODE_STATE)).toBe(accepted);
  });
});

describe("updateCommandTimesOf", () => {
  it("finds the first accepted load of a version and the first activation after it", () => {
    const commands = [
      record(10, { kind: "activate", version: 7 }),
      record(20, { kind: "load_image", version: 7 }, true),
      record(25, { kind: "load_image", version: 7 }),
      record(30, { kind: "activate", version: 7 }),
      record(40, { kind: "activate", version: 7 }),
      record(50, { kind: "load_image", version: 8 }),
      record(60, { kind: "load_image", version: 9 }, true),
    ];
    expect(updateCommandTimesOf(commands, 7)).toEqual({
      loadHostTime: 20,
      activateHostTime: 30,
      endHostTime: 60,
    });
    expect(updateCommandTimesOf(commands, 8)).toBeNull();
  });
});

describe("loadedUpdateVersions", () => {
  it("lists each accepted version once, in the order it was first sent", () => {
    expect(
      loadedUpdateVersions([
        record(10, { kind: "load_image", version: 9 }, true),
        record(20, { kind: "load_image", version: 8 }, false),
        record(30, { kind: "load_image", version: 7 }, true),
        record(40, { kind: "load_image", version: 9 }, true),
      ]),
    ).toEqual([9, 7]);
  });
});

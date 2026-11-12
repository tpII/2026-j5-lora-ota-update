import { describe, expect, it } from "vite-plus/test";
import firmwareConsoleLines from "../../../../firmware/protocol/test-vectors/firmware-console-lines.jsonl?raw";
import { CONSOLE_EVENT_NAMES, consoleEventSchema } from "./console-event.ts";
import { parseConsoleLine } from "./console-line-parser.ts";

// Every event line that the firmware writes in its host tests, written by
// firmware/tests/run_host_tests.sh, which fails when the firmware output and the file differ.
const LINES = firmwareConsoleLines.split("\n").filter((line) => line !== "");

describe("firmware console lines", () => {
  it("are all events of the contract", () => {
    const rejected = LINES.filter((line) => parseConsoleLine(line).kind !== "event");
    expect(rejected).toEqual([]);
  });

  it("are parsed by a schema for each event of the contract, and only for those", () => {
    const schemaNames = consoleEventSchema.def.options.map(
      (schema) => schema.shape.ev.def.values[0],
    );
    expect(schemaNames).toEqual(CONSOLE_EVENT_NAMES);
  });

  it("cover every event of the contract", () => {
    const emitted = new Set(LINES.map((line) => (JSON.parse(line) as { ev: string }).ev));
    expect(CONSOLE_EVENT_NAMES.filter((name) => !emitted.has(name))).toEqual([]);
  });
});

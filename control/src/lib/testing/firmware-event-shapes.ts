/**
 * The field sets that the firmware writes for each event, from the lines of its host tests
 * (firmware/protocol/test-vectors/firmware-console-lines.jsonl). console-fixtures.test.ts checks with them
 * the lines that the fixtures write by hand, and the setup of every test
 * (event-shape-check.setup.ts) the lines of every simulated node.
 */
import { parseConsoleLine } from "$lib/console/console-line-parser.ts";
import firmwareConsoleLines from "../../../../firmware/protocol/test-vectors/firmware-console-lines.jsonl?raw";

/** What tells two lines of one event apart in their fields: the type of a transmission. */
function shapeKey(object: Readonly<Record<string, unknown>>): string {
  return object.ev === "tx" ? `tx ${String(object.type)}` : String(object.ev);
}

function fieldsOf(object: Readonly<Record<string, unknown>>): string {
  return Object.keys(object).sort().join(",");
}

const FIRMWARE_SHAPES = new Map<string, Set<string>>();
for (const line of firmwareConsoleLines.split("\n")) {
  if (line === "") {
    continue;
  }
  const object = JSON.parse(line) as Record<string, unknown>;
  const shapes = FIRMWARE_SHAPES.get(shapeKey(object)) ?? new Set<string>();
  shapes.add(fieldsOf(object));
  FIRMWARE_SHAPES.set(shapeKey(object), shapes);
}

/** The event lines among `lines` whose fields are not a set the firmware writes for that event. */
export function findShapeDeviations(lines: readonly string[]): string[] {
  return lines
    .map(parseConsoleLine)
    .flatMap((parsed) => (parsed.kind === "event" ? [parsed.text] : []))
    .filter((text) => {
      const object = JSON.parse(text) as Record<string, unknown>;
      return FIRMWARE_SHAPES.get(shapeKey(object))?.has(fieldsOf(object)) !== true;
    });
}

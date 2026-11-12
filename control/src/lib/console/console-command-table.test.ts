import { describe, expect, it } from "vite-plus/test";
import {
  bareCommandLineOf,
  commandWordOf,
  consoleCommandOf,
  lineCapacityOf,
} from "./console-command-table.ts";
import { CONSOLE_LINE_CAPACITY, IMAGE_LINE_CAPACITY } from "$lib/protocol/protocol-contract.ts";

describe("commandWordOf", () => {
  it("takes the first word as the firmware splits the line, on spaces", () => {
    expect(commandWordOf("  radio sf 9 ")).toBe("radio");
    expect(commandWordOf("")).toBe("");
  });
});

describe("lineCapacityOf", () => {
  it("allows a whole image only in a load_image line, as the command table of the firmware", () => {
    expect(lineCapacityOf("load_image 4a35")).toBe(IMAGE_LINE_CAPACITY);
    expect(lineCapacityOf("  load_image")).toBe(IMAGE_LINE_CAPACITY);
    expect(lineCapacityOf("load_images 4a35")).toBe(CONSOLE_LINE_CAPACITY);
    expect(lineCapacityOf("status")).toBe(CONSOLE_LINE_CAPACITY);
    expect(lineCapacityOf("")).toBe(CONSOLE_LINE_CAPACITY);
  });
});

describe("bareCommandLineOf", () => {
  it("writes the command and the selector of a form without other arguments", () => {
    expect(bareCommandLineOf("reportStatus")).toBe("status");
    expect(bareCommandLineOf("resetRadio")).toBe("radio reset");
    expect(bareCommandLineOf("changeFragmentSize")).toBe("fragment_size");
  });

  it("refuses a form that needs arguments", () => {
    expect(() => bareCommandLineOf("holdPresence")).toThrow();
    expect(() => bareCommandLineOf("startRun")).toThrow();
  });

  it("finds the command of each action", () => {
    expect(consoleCommandOf("activateAvailableVersion").command.name).toBe("activate");
  });
});

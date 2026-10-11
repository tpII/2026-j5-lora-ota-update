import { describe, expect, it } from "vite-plus/test";
import {
  MAXIMUM_COMMAND_LENGTH,
  buildEchoCommand,
  buildPresenceOffCommand,
  buildRadioSetCommand,
  buildRunCommand,
  buildWifiCommand,
  commandWordOf,
  formatFrequencyArgument,
  type CommandResult,
  type RadioSettingChanges,
} from "./console-command.ts";

function commandOf(result: CommandResult): string {
  if (!result.valid) {
    throw new Error(
      `invalid command: ${result.problems.map((problem) => problem.field).join(", ")}`,
    );
  }
  return result.command;
}

function problemFieldsOf(result: CommandResult): string[] {
  return result.valid ? [] : result.problems.map((problem) => problem.field);
}

describe("buildRadioSetCommand", () => {
  it("writes several pairs at once, in the documented key order", () => {
    const result = buildRadioSetCommand({ bw: 500, sf: 9, freq: 915.9, cr: 5 }, "V2");
    expect(commandOf(result)).toBe("radio freq 915.9 sf 9 bw 500 cr 5");
  });

  it("writes every key the contract defines", () => {
    const result = buildRadioSetCommand(
      { freq: 927.75, sf: 12, bw: 125, cr: 8, preamble: 16, sync: 52, power: 28, lna: "on" },
      "V4.3",
    );
    expect(commandOf(result)).toBe(
      "radio freq 927.75 sf 12 bw 125 cr 8 preamble 16 sync 52 power 28 lna on",
    );
  });

  it("checks the ranges of docs/protocol/radio.md", () => {
    expect(problemFieldsOf(buildRadioSetCommand({ freq: 914.99 }, null))).toEqual(["freq"]);
    expect(problemFieldsOf(buildRadioSetCommand({ freq: 928.01 }, null))).toEqual(["freq"]);
    expect(problemFieldsOf(buildRadioSetCommand({ sf: 6 }, null))).toEqual(["sf"]);
    expect(problemFieldsOf(buildRadioSetCommand({ sf: 13 }, null))).toEqual(["sf"]);
    expect(problemFieldsOf(buildRadioSetCommand({ bw: 62.5 }, null))).toEqual(["bw"]);
    expect(problemFieldsOf(buildRadioSetCommand({ cr: 4 }, null))).toEqual(["cr"]);
    expect(problemFieldsOf(buildRadioSetCommand({ preamble: 5 }, null))).toEqual(["preamble"]);
    expect(problemFieldsOf(buildRadioSetCommand({ preamble: 65536 }, null))).toEqual(["preamble"]);
    expect(problemFieldsOf(buildRadioSetCommand({ sync: 256 }, null))).toEqual(["sync"]);
    expect(problemFieldsOf(buildRadioSetCommand({ sync: -1 }, null))).toEqual(["sync"]);
    expect(commandOf(buildRadioSetCommand({ freq: 915, sync: 0, preamble: 65535 }, null))).toBe(
      "radio freq 915 preamble 65535 sync 0",
    );
  });

  it("checks the transmit power against the board model", () => {
    expect(commandOf(buildRadioSetCommand({ power: 2 }, "V2"))).toBe("radio power 2");
    expect(commandOf(buildRadioSetCommand({ power: 17 }, "V2"))).toBe("radio power 17");
    expect(commandOf(buildRadioSetCommand({ power: 20 }, "V2"))).toBe("radio power 20");
    expect(problemFieldsOf(buildRadioSetCommand({ power: 18 }, "V2"))).toEqual(["power"]);
    expect(problemFieldsOf(buildRadioSetCommand({ power: 19 }, "V2"))).toEqual(["power"]);
    expect(problemFieldsOf(buildRadioSetCommand({ power: 1 }, "V2"))).toEqual(["power"]);
    expect(problemFieldsOf(buildRadioSetCommand({ power: 21 }, "V2"))).toEqual(["power"]);
    expect(problemFieldsOf(buildRadioSetCommand({ power: 3 }, "V4.3"))).toEqual(["power"]);
    expect(commandOf(buildRadioSetCommand({ power: 4 }, "V4.3"))).toBe("radio power 4");
    expect(commandOf(buildRadioSetCommand({ power: 28 }, "V4.3"))).toBe("radio power 28");
    expect(problemFieldsOf(buildRadioSetCommand({ power: 29 }, "V4.3"))).toEqual(["power"]);
    expect(problemFieldsOf(buildRadioSetCommand({ power: 10.5 }, "V4.3"))).toEqual(["power"]);
  });

  it("accepts the LNA only on the V4.3", () => {
    expect(commandOf(buildRadioSetCommand({ lna: "bypass" }, "V4.3"))).toBe("radio lna bypass");
    expect(problemFieldsOf(buildRadioSetCommand({ lna: "on" }, "V2"))).toEqual(["lna"]);
  });

  it("reports every invalid value together", () => {
    expect(problemFieldsOf(buildRadioSetCommand({ sf: 5, bw: 100, power: 30 }, "V2"))).toEqual([
      "sf",
      "bw",
      "power",
    ]);
  });

  it("refuses a command without values", () => {
    expect(problemFieldsOf(buildRadioSetCommand({}, "V2"))).toEqual(["radio"]);
  });

  it("refuses the null or NaN of an empty form field", () => {
    const emptyFields = { freq: null, preamble: Number.NaN } as unknown as RadioSettingChanges;
    expect(problemFieldsOf(buildRadioSetCommand(emptyFields, "V2"))).toEqual(["freq", "preamble"]);
  });
});

describe("formatFrequencyArgument", () => {
  it("keeps at most three decimals and no trailing zeros", () => {
    expect(formatFrequencyArgument(915.9)).toBe("915.9");
    expect(formatFrequencyArgument(915.25)).toBe("915.25");
    expect(formatFrequencyArgument(915.1234)).toBe("915.123");
    expect(formatFrequencyArgument(920)).toBe("920");
  });
});

describe("buildEchoCommand", () => {
  it("writes the destination in uppercase and the optional size", () => {
    expect(commandOf(buildEchoCommand("5c21"))).toBe("echo 5C21");
    expect(commandOf(buildEchoCommand("5C21", 4))).toBe("echo 5C21 4");
    expect(commandOf(buildEchoCommand("5C21", 239))).toBe("echo 5C21 239");
  });

  it("refuses reserved identifiers and sizes out of range", () => {
    expect(problemFieldsOf(buildEchoCommand("FFFF"))).toEqual(["id"]);
    expect(problemFieldsOf(buildEchoCommand("0000"))).toEqual(["id"]);
    expect(problemFieldsOf(buildEchoCommand("5C2"))).toEqual(["id"]);
    expect(problemFieldsOf(buildEchoCommand("5C21", 3))).toEqual(["size"]);
    expect(problemFieldsOf(buildEchoCommand("5C21", 240))).toEqual(["size"]);
  });
});

describe("buildRunCommand", () => {
  it("writes count, size and interval", () => {
    expect(commandOf(buildRunCommand(300, 239, 0))).toBe("run 300 239 0");
    expect(commandOf(buildRunCommand(1, 8, 60000))).toBe("run 1 8 60000");
    expect(commandOf(buildRunCommand(65535, 239, 0))).toBe("run 65535 239 0");
  });

  it("checks the documented ranges", () => {
    expect(problemFieldsOf(buildRunCommand(0, 7, 60001))).toEqual(["count", "size", "interval"]);
    expect(problemFieldsOf(buildRunCommand(65536, 240, -1))).toEqual(["count", "size", "interval"]);
    expect(problemFieldsOf(buildRunCommand(10.5, 100, 0))).toEqual(["count"]);
  });
});

describe("buildPresenceOffCommand", () => {
  it("holds the HELLO messages for whole seconds from 1 to 3600", () => {
    expect(commandOf(buildPresenceOffCommand(1))).toBe("presence off 1");
    expect(commandOf(buildPresenceOffCommand(3600))).toBe("presence off 3600");
    expect(problemFieldsOf(buildPresenceOffCommand(0))).toEqual(["seconds"]);
    expect(problemFieldsOf(buildPresenceOffCommand(3601))).toEqual(["seconds"]);
    expect(problemFieldsOf(buildPresenceOffCommand(1.5))).toEqual(["seconds"]);
  });
});

describe("simple commands", () => {
  it("builds the WiFi commands", () => {
    expect(buildWifiCommand("on")).toBe("wifi on");
    expect(buildWifiCommand("off")).toBe("wifi off");
  });

  it("extracts the command word the firmware reports in errors", () => {
    expect(commandWordOf("  radio sf 9 ")).toBe("radio");
    expect(commandWordOf("")).toBe("");
  });

  it("knows the line limit of the firmware", () => {
    expect(MAXIMUM_COMMAND_LENGTH).toBe(200);
  });
});

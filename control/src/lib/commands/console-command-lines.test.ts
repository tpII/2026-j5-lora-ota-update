import { describe, expect, it } from "vite-plus/test";
import {
  FRAGMENT_SIZE_QUERY_COMMAND,
  HELP_COMMAND,
  PRESENCE_ON_COMMAND,
  PROGRAM_COMMAND,
  RADIO_QUERY_COMMAND,
  RADIO_RESET_COMMAND,
  RESEND_COMMAND,
  RUN_STOP_COMMAND,
  STATUS_COMMAND,
  buildActivateCommand,
  buildEchoCommand,
  buildFragmentSizeCommand,
  buildLoadImageCommand,
  buildLoadRegistersCommand,
  buildPresenceOffCommand,
  buildRadioSetCommand,
  buildRunCommand,
  buildWifiCommand,
  type CommandResult,
} from "./console-command.ts";
import type { BoardModel } from "$lib/console/console-event.ts";
import { assembleImage, encodeImageHeader } from "$lib/image/image-format.ts";
import { parseHex } from "$lib/utils/hex.ts";
import {
  BANDWIDTHS_KILOHERTZ,
  BOARD_MODELS,
  DEFAULT_FREQUENCY_MEGAHERTZ,
  IMAGE_SIGNATURE_SIZE,
  MAXIMUM_CODING_RATE_DENOMINATOR,
  MAXIMUM_ECHO_SIZE,
  MAXIMUM_FRAGMENT_SIZE,
  MAXIMUM_FREQUENCY_MEGAHERTZ,
  MAXIMUM_IMAGE_VERSION,
  MAXIMUM_PREAMBLE_LENGTH,
  MAXIMUM_PRESENCE_HOLD_SECONDS,
  MAXIMUM_REGISTER_VALUE,
  MAXIMUM_RUN_COUNT,
  MAXIMUM_RUN_INTERVAL_MILLISECONDS,
  MAXIMUM_SPREADING_FACTOR,
  MAXIMUM_SYNC_WORD,
  MAXIMUM_TEST_SIZE,
  MINIMUM_CODING_RATE_DENOMINATOR,
  MINIMUM_ECHO_SIZE,
  MINIMUM_FRAGMENT_SIZE,
  MINIMUM_FREQUENCY_MEGAHERTZ,
  MINIMUM_IMAGE_VERSION,
  MINIMUM_PREAMBLE_LENGTH,
  MINIMUM_PRESENCE_HOLD_SECONDS,
  MINIMUM_REGISTER_VALUE,
  MINIMUM_RUN_COUNT,
  MINIMUM_RUN_INTERVAL_MILLISECONDS,
  MINIMUM_SPREADING_FACTOR,
  MINIMUM_SYNC_WORD,
  MINIMUM_TEST_SIZE,
  PROGRAM_CAPACITY,
} from "$lib/protocol/protocol-contract.ts";
import { transmitPowerRangeOf } from "$lib/radio/radio-settings.ts";
import {
  TEST_VECTOR_PATHS,
  synchronizeTestVector,
} from "../../../../tools/generate_protocol_sources.mjs";
import signedImageVector from "../../../../firmware/protocol/test-vectors/signed-image.json";

/** A command line of the panel, with the board model it is meant for, or null for any. */
interface CommandLineVector {
  readonly builder: string;
  readonly model: BoardModel | null;
  readonly line: string;
}

function built(builder: string, result: CommandResult, model: BoardModel | null = null) {
  if (!result.valid) {
    throw new Error(`${builder} rejected its arguments: ${JSON.stringify(result.problems)}`);
  }
  return { builder, model, line: result.command };
}

function constant(name: string, line: string): CommandLineVector {
  return { builder: name, model: null, line };
}

/** Each radio key at the lowest and at the highest value that the board model takes. */
function radioLines(model: BoardModel): CommandLineVector[] {
  const power = transmitPowerRangeOf(model);
  const lna = model === "V4.3";
  return [
    built(
      "buildRadioSetCommand",
      buildRadioSetCommand(
        {
          freq: MINIMUM_FREQUENCY_MEGAHERTZ,
          sf: MINIMUM_SPREADING_FACTOR,
          bw: BANDWIDTHS_KILOHERTZ[0],
          cr: MINIMUM_CODING_RATE_DENOMINATOR,
          preamble: MINIMUM_PREAMBLE_LENGTH,
          sync: MINIMUM_SYNC_WORD,
          power: power.minimum,
          ...(lna ? { lna: "bypass" as const } : {}),
        },
        model,
      ),
      model,
    ),
    built(
      "buildRadioSetCommand",
      buildRadioSetCommand(
        {
          freq: MAXIMUM_FREQUENCY_MEGAHERTZ,
          sf: MAXIMUM_SPREADING_FACTOR,
          bw: BANDWIDTHS_KILOHERTZ[BANDWIDTHS_KILOHERTZ.length - 1],
          cr: MAXIMUM_CODING_RATE_DENOMINATOR,
          preamble: MAXIMUM_PREAMBLE_LENGTH,
          sync: MAXIMUM_SYNC_WORD,
          power: Math.max(power.maximum, ...power.additionalValues),
          ...(lna ? { lna: "on" as const } : {}),
        },
        model,
      ),
      model,
    ),
  ];
}

/** The largest image the builder takes, with a signature of zeros, which the node rejects. */
function largestImage(): Uint8Array {
  return assembleImage(
    encodeImageHeader(MAXIMUM_IMAGE_VERSION, PROGRAM_CAPACITY),
    new Uint8Array(PROGRAM_CAPACITY),
    new Uint8Array(IMAGE_SIGNATURE_SIZE),
  );
}

function signedImage(): Uint8Array {
  const image = parseHex(signedImageVector.image);
  if (image === null) {
    throw new Error("the signed image vector is not hexadecimal");
  }
  return image;
}

/** Every command line the builders produce, at the limits of each argument. */
const COMMAND_LINES: readonly CommandLineVector[] = [
  constant("HELP_COMMAND", HELP_COMMAND),
  constant("STATUS_COMMAND", STATUS_COMMAND),
  constant("RADIO_QUERY_COMMAND", RADIO_QUERY_COMMAND),
  constant("RADIO_RESET_COMMAND", RADIO_RESET_COMMAND),
  ...BOARD_MODELS.flatMap(radioLines),
  built("buildRadioSetCommand", buildRadioSetCommand({ freq: DEFAULT_FREQUENCY_MEGAHERTZ }, null)),
  built("buildRadioSetCommand", buildRadioSetCommand({ freq: 927.75 }, null)),
  built("buildEchoCommand", buildEchoCommand("3a7f")),
  built("buildEchoCommand", buildEchoCommand("00F4", MINIMUM_ECHO_SIZE)),
  built("buildEchoCommand", buildEchoCommand("FFFE", MAXIMUM_ECHO_SIZE)),
  built(
    "buildRunCommand",
    buildRunCommand(MINIMUM_RUN_COUNT, MINIMUM_TEST_SIZE, MINIMUM_RUN_INTERVAL_MILLISECONDS),
  ),
  built(
    "buildRunCommand",
    buildRunCommand(MAXIMUM_RUN_COUNT, MAXIMUM_TEST_SIZE, MAXIMUM_RUN_INTERVAL_MILLISECONDS),
  ),
  constant("RUN_STOP_COMMAND", RUN_STOP_COMMAND),
  { builder: "buildWifiCommand", model: null, line: buildWifiCommand("on") },
  { builder: "buildWifiCommand", model: null, line: buildWifiCommand("off") },
  constant("RESEND_COMMAND", RESEND_COMMAND),
  constant("PRESENCE_ON_COMMAND", PRESENCE_ON_COMMAND),
  built("buildPresenceOffCommand", buildPresenceOffCommand(MINIMUM_PRESENCE_HOLD_SECONDS)),
  built("buildPresenceOffCommand", buildPresenceOffCommand(MAXIMUM_PRESENCE_HOLD_SECONDS)),
  built(
    "buildLoadRegistersCommand",
    buildLoadRegistersCommand([MINIMUM_REGISTER_VALUE, -1, 0, MAXIMUM_REGISTER_VALUE]),
  ),
  built("buildLoadImageCommand", buildLoadImageCommand(signedImage())),
  built("buildLoadImageCommand", buildLoadImageCommand(largestImage())),
  built("buildActivateCommand", buildActivateCommand(MINIMUM_IMAGE_VERSION)),
  built("buildActivateCommand", buildActivateCommand(MAXIMUM_IMAGE_VERSION)),
  constant("FRAGMENT_SIZE_QUERY_COMMAND", FRAGMENT_SIZE_QUERY_COMMAND),
  built("buildFragmentSizeCommand", buildFragmentSizeCommand(MINIMUM_FRAGMENT_SIZE)),
  built("buildFragmentSizeCommand", buildFragmentSizeCommand(MAXIMUM_FRAGMENT_SIZE)),
  constant("PROGRAM_COMMAND", PROGRAM_COMMAND),
];

const CONTENT = COMMAND_LINES.map((vector) => JSON.stringify(vector) + "\n").join("");

describe("console command lines", () => {
  it("are those of firmware/protocol/test-vectors/console-command-lines.jsonl", () => {
    // The firmware host tests run each line through the command table of the node. After a change
    // of a builder, run the panel tests with UPDATE_TEST_VECTORS=1 and then
    // node tools/generate_protocol_sources.mjs from the repository root.
    expect(synchronizeTestVector(TEST_VECTOR_PATHS.consoleCommandLines, CONTENT)).toBe(CONTENT);
  });
});

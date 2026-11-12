// Generates the protocol sources of the firmware and of the control panel from the machine-readable
// contract (docs/adrs/0013-machine-readable-protocol-contract.md):
//
//   firmware/protocol/contract.json        -> firmware/src/protocol/protocol_contract.h
//                                 -> control/src/lib/protocol/protocol-contract.ts
//   firmware/protocol/test-vectors/*.json  -> firmware/tests/generated_test_vectors.h
//
// firmware/protocol/test-vectors/console-command-lines.jsonl is written by a test of the control panel from
// its command builders (control/src/lib/commands/console-command-lines.test.ts), through
// synchronizeTestVector().
//
// The generated text goes through clang-format, which mise.toml pins, and the formatter of Vite+
// from the panel dependencies (control/node_modules, installed by mise run setup:control).
//
// Usage: node tools/generate_protocol_sources.mjs [--check]
// Without arguments it writes the generated files. With --check it writes nothing and exits with
// status 1, naming each file, when a generated file differs from what it would write, or when a
// document no longer states a value of the contract that DOCUMENT_MENTIONS lists.

import { spawnSync } from "node:child_process";
import { createHmac, createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listBuildProfiles } from "./list_build_profiles.mjs";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CONTRACT_PATH = "firmware/protocol/contract.json";
const SKETCH_PROJECT_PATH = "firmware/sketch.yaml";
export const TEST_VECTOR_PATHS = {
  consoleCommandLines: "firmware/protocol/test-vectors/console-command-lines.jsonl",
  frame: "firmware/protocol/test-vectors/frame.json",
  signedImage: "firmware/protocol/test-vectors/signed-image.json",
  responseDeadlines: "firmware/protocol/test-vectors/response-deadlines.json",
  timeOnAir: "firmware/protocol/test-vectors/time-on-air.json",
  virtualMachine: "firmware/protocol/test-vectors/virtual-machine.json",
};
export const GENERATED_PATHS = {
  firmwareHeader: "firmware/src/protocol/protocol_contract.h",
  panelModule: "control/src/lib/protocol/protocol-contract.ts",
  testVectorHeader: "firmware/tests/generated_test_vectors.h",
};

const GENERATOR_PATH = "tools/generate_protocol_sources.mjs";
const COLUMN_LIMIT = 100;

// ---------------------------------------------------------------------------------------------
// Reading and checking the contract

class ContractError extends Error {}

function ensure(condition, message) {
  if (!condition) {
    throw new ContractError(`${CONTRACT_PATH}: ${message}`);
  }
}

// A number written either as a JSON number or as a hexadecimal string such as "0xFFFF".
function numberOf(value, path) {
  if (typeof value === "number") {
    return value;
  }
  ensure(typeof value === "string" && /^0x[0-9A-Fa-f]+$/.test(value), `${path} is not a number`);
  return Number.parseInt(value.slice(2), 16);
}

function ensureAscending(offsets, limit, path) {
  let previous = -1;
  for (const [field, offset] of Object.entries(offsets)) {
    ensure(Number.isInteger(offset) && offset > previous, `${path}.${field} is out of order`);
    previous = offset;
  }
  ensure(previous < limit, `${path} goes past the end of the body`);
}

function ensureRange(range, path) {
  ensure(
    range.minimum <= range.default && range.default <= range.maximum,
    `${path}.default is out of range`,
  );
}

function ceilingDivision(dividend, divisor) {
  return Math.floor((dividend + divisor - 1) / divisor);
}

// "echo_request" -> "EchoRequest".
function upperCamelCase(name) {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("");
}

function lowerCamelCase(name) {
  return name[0].toLowerCase() + name.slice(1);
}

// "LnaMode" -> "LNA_MODE".
function upperSnakeCase(typeName) {
  return typeName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

// Every value of the contract that the generated files expose, base and derived, with the names
// and types they take in each language.
function describeContract(contract) {
  const versions = contract.versions;
  const frame = contract.frame;
  const hello = contract.hello;
  const echo = contract.echo;
  const test = contract.test;
  const fragment = contract.fragment;
  const report = contract.report;
  const image = contract.image;
  const vm = contract.virtualMachine;
  const radio = contract.radio;
  const consoleContract = contract.console;
  const timings = contract.timings;
  const vocabularies = contract.vocabularies;

  const frameOverhead = frame.headerSize + frame.tagSize;
  const maximumPayloadSize = frame.maximumFrameSize - frameOverhead;
  ensure(maximumPayloadSize > 0, "the frame header and tag leave no room for a body");
  ensureAscending(frame.headerOffsets, frame.headerSize, "frame.headerOffsets");
  ensure(
    Number.isInteger(frame.trackedSources) && frame.trackedSources > 0,
    "frame.trackedSources must be a positive integer",
  );

  const maximumImageSize = image.headerSize + vm.programCapacity + image.signatureSize;
  const minimumImageSize = image.headerSize + image.minimumProgramSize + image.signatureSize;
  const signedMessageSize = image.headerSize + image.programDigestSize;
  const imageMagic = image.magic.map((byte, index) => numberOf(byte, `image.magic[${index}]`));
  ensure(imageMagic.length === 2, "image.magic must have two bytes");
  ensureAscending(image.offsets, image.headerSize, "image.offsets");
  ensure(
    image.minimumVersion >= 1 && image.maximumVersion <= 0xffffffff,
    "image versions out of range",
  );

  const maximumFragmentSize = maximumPayloadSize - fragment.headerSize;
  ensure(maximumFragmentSize <= 0xff, "the fragment size must fit one byte");
  ensure(fragment.minimumSize <= maximumFragmentSize, "fragment.minimumSize exceeds the payload");
  ensureAscending(fragment.offsets, fragment.headerSize, "fragment.offsets");
  const maximumFragmentCount = ceilingDivision(maximumImageSize, fragment.minimumSize);
  ensure(maximumFragmentCount <= 0xff, "the fragment count must fit one byte");
  const maximumReportBitmapSize = ceilingDivision(maximumFragmentCount, 8);
  const maximumReportSize = report.fixedSize + maximumReportBitmapSize;
  ensure(maximumReportSize <= maximumPayloadSize, "the largest report does not fit a frame");
  ensureAscending(report.offsets, report.fixedSize, "report.offsets");

  const maximumHelloSize = hello.fixedSize + hello.maximumNeighbors * hello.neighborSize;
  ensure(maximumHelloSize <= maximumPayloadSize, "the largest HELLO does not fit a frame");
  ensureAscending(hello.offsets, hello.fixedSize, "hello.offsets");
  ensureAscending(hello.neighborOffsets, hello.neighborSize, "hello.neighborOffsets");
  const vmFaultMask = numberOf(hello.vmStatus.faultMask, "hello.vmStatus.faultMask");
  const vmFailingBit = numberOf(hello.vmStatus.failingBit, "hello.vmStatus.failingBit");
  ensure((vmFaultMask & vmFailingBit) === 0, "the vm byte fields overlap");

  ensureAscending(echo.offsets, echo.replyFieldsSize, "echo.offsets");
  ensure(
    echo.replyFieldsSize <= echo.defaultSize && echo.defaultSize <= maximumPayloadSize,
    "echo.defaultSize is out of range",
  );
  ensureAscending(test.offsets, test.fieldsSize, "test.offsets");
  ensure(test.fieldsSize <= maximumPayloadSize, "the TEST fields do not fit a frame");
  ensure(test.maximumRunIntervalMilliseconds <= 0xffff, "the run interval must fit two bytes");
  ensure(test.maximumRunCount <= 0xffff, "the run count must fit two bytes");

  const imageLineCapacity =
    consoleContract.imageLine.hexadecimalDigitsPerByte * maximumImageSize +
    consoleContract.imageLine.commandWordAllowance;
  // The allowance covers the command word of the firmware and panel tables and its space.
  ensure(
    consoleContract.imageLine.commandWordAllowance >= "load_image ".length,
    "console.imageLine.commandWordAllowance does not hold the load_image command word",
  );

  const faults = vm.faults;
  faults.forEach((fault, index) =>
    ensure(fault.code === index, `fault ${fault.name} breaks the code order`),
  );
  ensure(faults[0].name === "none", "the first fault code must be none");
  ensure(faults.at(-1).code <= vmFaultMask, "a fault code does not fit the vm byte");

  const formNames = vm.operandForms.map((form) => form.name);
  for (const effect of vm.instructionEffects) {
    for (const form of effect.forms) {
      ensure(formNames.includes(form), `effect ${effect.name} names the unknown form ${form}`);
    }
  }
  const opcodes = new Set();
  for (const instruction of vm.instructions) {
    const opcode = numberOf(instruction.opcode, `instruction ${instruction.mnemonic}`);
    ensure(!opcodes.has(opcode), `opcode ${instruction.opcode} is repeated`);
    ensure(formNames.includes(instruction.form), `${instruction.mnemonic} has an unknown form`);
    // The effect says which operands the VM reads, so the form must give them.
    const effect = vm.instructionEffects.find((candidate) => candidate.name === instruction.effect);
    ensure(effect !== undefined, `${instruction.mnemonic} has an unknown effect`);
    ensure(
      effect.forms.includes(instruction.form),
      `${instruction.mnemonic} has the effect ${instruction.effect}, which no ${instruction.form} instruction can have`,
    );
    opcodes.add(opcode);
  }

  const frequency = radio.frequencyMegahertz;
  ensureRange(frequency, "radio.frequencyMegahertz");
  ensure(
    Number.isInteger(frequency.rangeDecimals) &&
      frequency.rangeDecimals >= 0 &&
      [frequency.minimum, frequency.maximum].every(
        (limit) => Number(limit.toFixed(frequency.rangeDecimals)) === limit,
      ),
    "radio.frequencyMegahertz.rangeDecimals does not write the range exactly",
  );
  ensureRange(radio.spreadingFactor, "radio.spreadingFactor");
  ensureRange(radio.codingRateDenominator, "radio.codingRateDenominator");
  ensureRange(radio.preambleLength, "radio.preambleLength");
  const syncWord = {
    ...radio.syncWord,
    default: numberOf(radio.syncWord.default, "radio.syncWord.default"),
  };
  ensureRange(syncWord, "radio.syncWord");
  ensure(
    radio.bandwidthsKilohertz.includes(radio.defaultBandwidthKilohertz),
    "default bandwidth unknown",
  );
  ensure(
    radio.bandwidthsKilohertz.includes(radio.onAir.bandwidthKilohertz),
    "on-air bandwidth unknown",
  );
  ensure(vocabularies.lnaModes.includes(radio.defaultLnaMode), "default LNA mode unknown");
  ensure(
    frequency.minimum <= radio.onAir.minimumCenterMegahertz &&
      radio.onAir.maximumCenterMegahertz <= frequency.maximum,
    "the on-air centers leave the frequency range",
  );
  for (const reason of vocabularies.settingUpdateReasons) {
    ensure(
      vocabularies.errorReasons.includes(reason),
      `setting update reason ${reason} is no error reason`,
    );
  }

  const boardModels = contract.boardModels;
  for (const board of boardModels) {
    const power = board.transmitPowerDbm;
    const reachable = [];
    for (let dbm = power.minimum; dbm <= power.maximum; dbm += 1) {
      reachable.push(dbm);
    }
    reachable.push(...power.additionalValues);
    ensure(
      reachable.includes(radio.defaultTransmitPowerDbm),
      `${board.name} cannot use the default power`,
    );
    ensure(board.frontEndGainSteps.length > 0, `${board.name} needs a front-end gain step`);
    board.frontEndGainSteps.forEach((step, index) =>
      ensure(
        step.minimumAntennaDbm <= step.maximumAntennaDbm &&
          (index === 0 ||
            board.frontEndGainSteps[index - 1].maximumAntennaDbm < step.minimumAntennaDbm),
        `${board.name} has its front-end gain steps out of order`,
      ),
    );
    ensure(/^SX\d{4}$/.test(board.transceiver), `${board.name} needs the name of its transceiver`);
    for (const limit of board.dutyCycleLimits) {
      ensure(
        limit.minimumAntennaDbm <= limit.maximumAntennaDbm &&
          reachable.includes(limit.minimumAntennaDbm) &&
          reachable.includes(limit.maximumAntennaDbm) &&
          limit.maximumDutyCyclePercent > 0 &&
          limit.maximumDutyCyclePercent < 100,
        `${board.name} has a duty cycle limit out of its transmit power`,
      );
    }
    for (const dbm of reachable) {
      const steps = board.frontEndGainSteps.filter(
        (step) => step.minimumAntennaDbm <= dbm && dbm <= step.maximumAntennaDbm,
      );
      ensure(steps.length === 1, `${board.name} needs exactly one gain step for ${dbm} dBm`);
    }
  }

  ensure(
    typeof timings.neighborExpiry.expiresAtBoundary === "boolean",
    "timings.neighborExpiry.expiresAtBoundary must be true or false",
  );
  ensure(
    timings.helloJitterMilliseconds < timings.helloPeriodMilliseconds &&
      timings.firstHelloMinimumDelayMilliseconds <= timings.firstHelloMaximumDelayMilliseconds,
    "inconsistent HELLO timings",
  );

  const registerValue = vm.registerValue;
  // The firmware reads register values as 32-bit patterns (console/argument_reader.h): a signed or
  // an unsigned 32-bit number.
  ensure(
    registerValue.minimum === -(2 ** 31) && registerValue.maximum === 2 ** 32 - 1,
    "virtualMachine.registerValue must span the signed and the unsigned 32-bit numbers",
  );
  const commands = describeConsoleCommands(
    consoleContract,
    radio,
    vm,
    imageLineCapacity,
    vocabularies.errorReasons,
  );

  const webSocketUrl = `ws://${consoleContract.webSocket.host}${consoleContract.webSocket.path}`;
  const accessPointAddress = consoleContract.webSocket.host.split(".").map(Number);
  ensure(
    accessPointAddress.length === 4 &&
      accessPointAddress.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255),
    "console.webSocket.host must be an IPv4 address",
  );
  const broadcastNodeId = numberOf(contract.nodeIdentifiers.broadcast, "nodeIdentifiers.broadcast");
  const noNodeId = numberOf(contract.nodeIdentifiers.none, "nodeIdentifiers.none");
  const nodeIdDigits = contract.nodeIdentifiers.hexadecimalDigits;
  const nodeIdText = (id) => id.toString(16).toUpperCase().padStart(nodeIdDigits, "0");

  const anyModelPower = {
    minimum: Math.min(...boardModels.map((board) => board.transmitPowerDbm.minimum)),
    maximum: Math.max(
      ...boardModels.flatMap((board) => [
        board.transmitPowerDbm.maximum,
        ...board.transmitPowerDbm.additionalValues,
      ]),
    ),
  };

  const range = (minimum, maximum) =>
    Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);

  // cppCount asks for <TYPE>_COUNT in the firmware header, for a firmware caller that walks the
  // enumerators; the panel always gets the tuple.
  const vocabulary = (typeName, tupleName, names, comment, options = {}) => ({
    kind: "enum",
    typeName,
    tupleName,
    comment,
    ...options,
    entries: names.map((name, index) => ({ identifier: upperCamelCase(name), name, code: index })),
  });

  // ---------------------------------------------------------------------------------------------
  // The definitions, in the order of the generated files.

  const definitions = [];
  const section = (title) => definitions.push({ kind: "section", title });
  const constant = (base, cppType, value, options = {}) =>
    definitions.push({ kind: "constant", base, cppType, value, ...options });
  const list = (base, cppType, values, options = {}) =>
    definitions.push({ kind: "list", base, cppType, values, ...options });
  const cpp = (text) => definitions.push({ kind: "cpp", text });
  const ts = (text) => definitions.push({ kind: "ts", text });
  // The offsets of the frame and of the bodies are read only by the codecs of the firmware; those
  // of the image, by the panel too, which builds and reads images.
  /** @type {(prefix: string, offsets: object, comment: string, options?: object) => void} */
  const offsetConstants = (prefix, offsets, comment, options = { cppOnly: true }) =>
    Object.entries(offsets).forEach(([field, offset], index) =>
      constant(`${prefix}_${upperSnakeCase(field)}_OFFSET`, "size_t", offset, {
        comment: index === 0 ? comment : undefined,
        group: true,
        ...options,
      }),
    );

  section("Versions");
  constant("PROTOCOL_VERSION", "uint8_t", versions.frameProtocol, {
    cppOnly: true,
    comment:
      "Version of the frame protocol (docs/protocol/frame.md). It enters the authentication tag, " +
      "and the boot event reports it as protocol.",
  });

  section("Console vocabularies (docs/protocol/console.md)");
  definitions.push(
    vocabulary(
      "ConsoleEvent",
      "CONSOLE_EVENTS",
      vocabularies.events,
      "Field ev of every event, in the order of docs/protocol/console.md.",
      { cppCount: true },
    ),
    vocabulary(
      "LnaMode",
      "LNA_MODES",
      vocabularies.lnaModes,
      "LNA mode of the V4.3, as the radio event and command write it.",
    ),
    vocabulary(
      "ImageArrival",
      "IMAGE_ARRIVALS",
      vocabularies.imageArrivals,
      "Field via of the image event.",
    ),
    vocabulary(
      "BurstCause",
      "BURST_CAUSES",
      vocabularies.burstCauses,
      "Field cause of the burst_start event.",
    ),
    vocabulary(
      "ActivationCause",
      "ACTIVATION_CAUSES",
      vocabularies.activationCauses,
      "Field cause of the activation event.",
    ),
    vocabulary(
      "ImageRejectionReason",
      "IMAGE_REJECTION_REASONS",
      vocabularies.imageRejectionReasons,
      "Reason of the image_rejected event and first word of the detail of invalid_image.",
    ),
    vocabulary(
      "DropReason",
      "DROP_REASONS",
      vocabularies.dropReasons,
      "Field reason of the drop event, in the order of the checks.",
    ),
    vocabulary(
      "ErrorReason",
      "ERROR_REASONS",
      vocabularies.errorReasons,
      "Field reason of the error event.",
    ),
    vocabulary(
      "RunEndReason",
      "RUN_END_REASONS",
      vocabularies.runEndReasons,
      "Field reason of the run_end event.",
    ),
    vocabulary(
      "WifiState",
      "WIFI_STATES",
      vocabularies.wifiStates,
      "Field state of the wifi event.",
    ),
    vocabulary(
      "PresenceState",
      "PRESENCE_STATES",
      vocabularies.presenceStates,
      "Field state of the presence event.",
    ),
    vocabulary(
      "KeyKind",
      "KEY_KINDS",
      vocabularies.keyKinds,
      "Fields key and operator_key of the boot event.",
    ),
  );
  definitions.push({
    kind: "subset",
    base: "SETTING_UPDATE_REASONS",
    typeName: "ErrorReason",
    names: vocabularies.settingUpdateReasons,
    cppOnly: true,
    comment: "Reasons of the error event that a rejected radio setting can give.",
  });

  section("Node identifiers (docs/protocol/frame.md)");
  constant("NODE_ID_HEXADECIMAL_DIGITS", "size_t", nodeIdDigits, {
    comment: "A node identifier is written as this many uppercase hexadecimal digits.",
  });
  constant("BROADCAST_NODE_ID", "uint16_t", broadcastNodeId, {
    format: "hex4",
    cppOnly: true,
    comment: "Destination of a frame for every node.",
  });
  constant("NO_NODE_ID", "uint16_t", noNodeId, {
    format: "hex4",
    cppOnly: true,
    comment: "Reserved like the broadcast identifier: no node takes it, so it stands for no node.",
  });
  constant("BROADCAST_IDENTIFIER", "", nodeIdText(broadcastNodeId), {
    tsOnly: true,
    comment: "BROADCAST_NODE_ID as the console writes it.",
  });
  constant("NO_NODE_IDENTIFIER", "", nodeIdText(noNodeId), {
    tsOnly: true,
    comment: "NO_NODE_ID as the console would write it.",
  });

  section("Frame (docs/protocol/frame.md)");
  constant("FRAME_HEADER_SIZE", "size_t", frame.headerSize, { cppOnly: true });
  constant("FRAME_TAG_SIZE", "size_t", frame.tagSize, { cppOnly: true });
  constant("FRAME_OVERHEAD", "size_t", frameOverhead, {
    comment: "FRAME_HEADER_SIZE + FRAME_TAG_SIZE.",
  });
  constant("MAXIMUM_FRAME_SIZE", "size_t", frame.maximumFrameSize, { cppOnly: true });
  constant("MAXIMUM_PAYLOAD_SIZE", "size_t", maximumPayloadSize, {
    cppOnly: true,
    comment: "MAXIMUM_FRAME_SIZE - FRAME_OVERHEAD.",
  });
  offsetConstants("FRAME", frame.headerOffsets, "Offsets in the frame header.");
  constant("MAXIMUM_TRACKED_SOURCES", "size_t", frame.trackedSources, {
    cppOnly: true,
    comment:
      "Sources whose last frame a node remembers to discard repeated frames; a full table replaces " +
      "the source heard least recently.",
  });
  definitions.push({
    kind: "enum",
    typeName: "MessageType",
    tupleName: "MESSAGE_TYPES",
    wire: true,
    hexadecimalCodes: true,
    comment: "Field type of the frame header, with the names of the tx event.",
    entries: frame.messageTypes.map((type) => ({
      identifier: upperCamelCase(type.name),
      name: type.name,
      code: numberOf(type.code, `message type ${type.name}`),
    })),
  });

  section("Board models (docs/protocol/radio.md)");
  definitions.push({
    kind: "enum",
    typeName: "BoardModel",
    tupleName: "BOARD_MODELS",
    wire: true,
    comment: "Field model of the HELLO, with the names of the console events.",
    entries: boardModels.map((board) => ({
      identifier: board.identifier,
      name: board.name,
      code: board.code,
    })),
  });
  // Each side reads the board models through its table: cppBoardTable and tsBoardTables.
  cpp(cppBoardTable(boardModels));
  ts(tsBoardTables(boardModels, anyModelPower));

  section("HELLO body (docs/protocol/frame.md)");
  constant("HELLO_FIXED_SIZE", "size_t", hello.fixedSize);
  constant("HELLO_NEIGHBOR_SIZE", "size_t", hello.neighborSize);
  constant("MAXIMUM_NEIGHBORS", "size_t", hello.maximumNeighbors, {
    comment: "Neighbors that a HELLO lists at most.",
  });
  constant("MAXIMUM_HELLO_SIZE", "size_t", maximumHelloSize, {
    cppOnly: true,
    comment: "HELLO_FIXED_SIZE + MAXIMUM_NEIGHBORS * HELLO_NEIGHBOR_SIZE.",
  });
  offsetConstants("HELLO", hello.offsets, "Offsets in the body.");
  offsetConstants(
    "HELLO_NEIGHBOR",
    hello.neighborOffsets,
    "Offsets in each neighbor entry, which follow the fixed part.",
  );
  constant("VM_STATUS_FAULT_MASK", "uint8_t", vmFaultMask, {
    format: "hex2",
    cppOnly: true,
    comment:
      "Bits of the byte vm of the HELLO with the code of the last VmFault since the activation.",
  });
  constant("VM_STATUS_FAILING_BIT", "uint8_t", vmFailingBit, {
    format: "hex2",
    cppOnly: true,
    comment:
      "Bit of the byte vm set when the last tick ended in a fault; the bits above it are reserved.",
  });

  section("ECHO_REQUEST and ECHO_REPLY bodies (docs/protocol/frame.md)");
  constant("ECHO_REPLY_FIELDS_SIZE", "size_t", echo.replyFieldsSize, { cppOnly: true });
  offsetConstants(
    "ECHO",
    echo.offsets,
    "Offsets in the body of the reply; the request carries only the number.",
  );
  constant("MINIMUM_ECHO_SIZE", "uint16_t", echo.replyFieldsSize, {
    group: true,
    comment: "Body length of the echo command: ECHO_REPLY_FIELDS_SIZE to MAXIMUM_PAYLOAD_SIZE.",
  });
  constant("MAXIMUM_ECHO_SIZE", "uint16_t", maximumPayloadSize);
  constant("DEFAULT_ECHO_SIZE", "uint16_t", echo.defaultSize);

  section("TEST body and the run command (docs/protocol/frame.md)");
  constant("TEST_FIELDS_SIZE", "size_t", test.fieldsSize, { cppOnly: true });
  offsetConstants("TEST", test.offsets, "Offsets in the body.");
  constant("MINIMUM_TEST_SIZE", "uint16_t", test.fieldsSize, {
    group: true,
    comment: "Body length of the run command: TEST_FIELDS_SIZE to MAXIMUM_PAYLOAD_SIZE.",
  });
  constant("MAXIMUM_TEST_SIZE", "uint16_t", maximumPayloadSize);
  constant("MINIMUM_RUN_COUNT", "uint16_t", test.minimumRunCount, {
    group: true,
    comment: "Packets of a run.",
  });
  constant("MAXIMUM_RUN_COUNT", "uint16_t", test.maximumRunCount);
  constant("MINIMUM_RUN_INTERVAL", "uint32_t", test.minimumRunIntervalMilliseconds, {
    unit: "ms",
    group: true,
    comment: "Time between the end of a packet of a run and the start of the next.",
  });
  constant("MAXIMUM_RUN_INTERVAL", "uint32_t", test.maximumRunIntervalMilliseconds, { unit: "ms" });

  section("FRAGMENT and REPORT bodies (docs/protocol/frame.md and ADR 0009)");
  constant("FRAGMENT_HEADER_SIZE", "size_t", fragment.headerSize);
  offsetConstants(
    "FRAGMENT",
    fragment.offsets,
    "Offsets in the body; the data follows the header.",
  );
  constant("MINIMUM_FRAGMENT_SIZE", "uint8_t", fragment.minimumSize, {
    comment: "Smallest fragment size that the fragment_size command accepts.",
  });
  constant("MAXIMUM_FRAGMENT_SIZE", "uint8_t", maximumFragmentSize, {
    comment: "MAXIMUM_PAYLOAD_SIZE - FRAGMENT_HEADER_SIZE.",
  });
  constant("DEFAULT_FRAGMENT_SIZE", "uint8_t", maximumFragmentSize, {
    comment: "Fragment size of the complete bursts after a boot.",
  });
  constant("MAXIMUM_FRAGMENT_COUNT", "uint8_t", maximumFragmentCount, {
    cppOnly: true,
    comment:
      "Fragments of the largest image at the smallest size: MAXIMUM_IMAGE_SIZE / MINIMUM_FRAGMENT_SIZE, rounded up.",
  });
  constant("REPORT_FIXED_SIZE", "size_t", report.fixedSize);
  offsetConstants(
    "REPORT",
    report.offsets,
    "Offsets in the body; the bitmap of missing fragments follows the fixed part.",
  );
  constant("MAXIMUM_REPORT_BITMAP_SIZE", "size_t", maximumReportBitmapSize, {
    cppOnly: true,
    comment: "MAXIMUM_FRAGMENT_COUNT / 8, rounded up.",
  });
  constant("MAXIMUM_REPORT_SIZE", "size_t", maximumReportSize, { cppOnly: true });

  section("Image (docs/protocol/image.md)");
  list("IMAGE_MAGIC", "uint8_t", imageMagic, { format: "hex2", cppComment: '"J5".' });
  constant("IMAGE_FLAGS", "uint8_t", image.flags, {
    comment: "The only value of the reserved flags.",
  });
  constant("IMAGE_HEADER_SIZE", "size_t", image.headerSize);
  offsetConstants("IMAGE", image.offsets, "Offsets in the header.", {});
  constant("IMAGE_SIGNATURE_SIZE", "size_t", image.signatureSize, {
    comment: "Ed25519 signature of the operator.",
  });
  constant("IMAGE_PROGRAM_DIGEST_SIZE", "size_t", image.programDigestSize, {
    cppOnly: true,
    comment: "SHA-256 of the program.",
  });
  constant("IMAGE_SIGNED_MESSAGE_SIZE", "size_t", signedMessageSize, {
    comment: "What the operator signs: the header and the SHA-256 of the program.",
  });
  constant("OPERATOR_PUBLIC_KEY_SIZE", "size_t", image.operatorPublicKeySize, {
    comment: "Ed25519 public key.",
  });
  constant("MINIMUM_PROGRAM_SIZE", "size_t", image.minimumProgramSize, {
    comment: "Length of the program.",
  });
  constant("MAXIMUM_PROGRAM_SIZE", "size_t", vm.programCapacity, { comment: "PROGRAM_CAPACITY." });
  constant("MINIMUM_IMAGE_SIZE", "size_t", minimumImageSize, {
    comment: "IMAGE_HEADER_SIZE + MINIMUM_PROGRAM_SIZE + IMAGE_SIGNATURE_SIZE.",
  });
  constant("MAXIMUM_IMAGE_SIZE", "size_t", maximumImageSize, {
    comment: "IMAGE_HEADER_SIZE + PROGRAM_CAPACITY + IMAGE_SIGNATURE_SIZE.",
  });
  ensure(
    image.formatDefects.every(
      (defect) => /^[a-z][A-Za-z]*$/.test(defect.name) && typeof defect.detail === "string",
    ),
    "image.formatDefects needs a name in lowerCamelCase and a detail for each",
  );
  cpp(cppImageFormatDefects(image.formatDefects));
  ts(tsImageFormatDefects(image.formatDefects));
  constant("MINIMUM_IMAGE_VERSION", "uint32_t", image.minimumVersion, {
    group: true,
    comment: "Version of an image; version 0 is the factory program, which has no image.",
  });
  constant("MAXIMUM_IMAGE_VERSION", "uint32_t", image.maximumVersion);

  section("Virtual machine (docs/protocol/virtual-machine.md)");
  constant("PROGRAM_CAPACITY", "size_t", vm.programCapacity, {
    comment:
      "Program memory, in bytes. The image, the image line and the fragment count grow with it.",
  });
  constant("REGISTER_COUNT", "uint8_t", vm.registerCount);
  constant("MINIMUM_REGISTER_VALUE", "int64_t", registerValue.minimum, {
    group: true,
    tsOnly: true,
    comment:
      "Value of load_registers: a signed or an unsigned 32-bit number, kept as its bit pattern.",
  });
  constant("MAXIMUM_REGISTER_VALUE", "int64_t", registerValue.maximum, { tsOnly: true });
  constant(
    "REGISTER_VALUE_DETAIL",
    "const char *",
    `${registerValue.minimum}..${registerValue.maximum} or 0x hexadecimal`,
    { comment: "Detail of the out_of_range error for a register value." },
  );
  constant("VM_TICK_PERIOD", "uint32_t", vm.tickPeriodMilliseconds, {
    unit: "ms",
    comment: "Time between the starts of two ticks.",
  });
  constant("VM_INSTRUCTIONS_PER_POLL", "uint32_t", vm.instructionsPerPoll, {
    cppOnly: true,
    comment: "Instructions that one pass of the main loop runs at most, between radio services.",
  });
  constant("VM_MAXIMUM_INSTRUCTIONS_PER_TICK", "uint32_t", vm.maximumInstructionsPerTick, {
    comment: "A tick that reaches this many instructions ends with the fault instruction_limit.",
  });
  definitions.push({
    kind: "enum",
    typeName: "Opcode",
    tupleName: "OPCODES",
    wire: true,
    cppOnly: true,
    hexadecimalCodes: true,
    noNames: true,
    comment:
      "Group 0x0n holds the configuration instructions, 0x1n the arithmetic ones and 0x2n the logic " +
      "ones; 0x3n is reserved for control. In groups 0x1n and 0x2n an even opcode takes a 32-bit " +
      "immediate and the next odd one a source register.",
    entries: vm.instructions.map((instruction) => ({
      identifier: instruction.identifier,
      name: instruction.mnemonic,
      code: numberOf(instruction.opcode, instruction.mnemonic),
    })),
  });
  definitions.push({
    kind: "enum",
    typeName: "OperandForm",
    tupleName: "OPERAND_FORMS",
    noNames: true,
    comment:
      "Operands of an instruction: none, one register, a register and an immediate or two registers.",
    entries: vm.operandForms.map((form, index) => ({
      identifier: upperCamelCase(form.name),
      name: form.name,
      code: index,
    })),
  });
  definitions.push({
    kind: "enum",
    typeName: "InstructionEffect",
    tupleName: "INSTRUCTION_EFFECTS",
    noNames: true,
    cppOnly: true,
    comment:
      "What an instruction does: stop the tick, print a register, write its first register or " +
      "write it after a division, which faults on a zero divisor. Each effect admits the operand " +
      "forms of the contract that give it the registers it reads.",
    entries: vm.instructionEffects.map((effect, index) => ({
      identifier: upperCamelCase(effect.name),
      name: effect.name,
      code: index,
    })),
  });
  cpp(cppInstructionTable(vm));
  ts(tsInstructionTable(vm));
  definitions.push({
    kind: "enum",
    typeName: "VmFault",
    tupleName: "VM_FAULTS",
    wire: true,
    cppCount: true,
    tupleSkipsFirst: true,
    comment:
      "Fault that ends a tick, with the names of the vm_fault event. The code travels in the byte vm " +
      "of the HELLO; None is code 0 and never appears on the console, which writes null instead.",
    entries: faults.map((fault) => ({
      identifier: upperCamelCase(fault.name),
      name: fault.name,
      code: fault.code,
    })),
  });

  section("Radio settings (docs/protocol/radio.md)");
  constant("MINIMUM_FREQUENCY", "float", frequency.minimum, {
    unit: "MHz",
    group: true,
    comment: "Center frequency.",
  });
  constant("MAXIMUM_FREQUENCY", "float", frequency.maximum, { unit: "MHz" });
  constant("DEFAULT_FREQUENCY", "float", frequency.default, { unit: "MHz" });
  constant("FREQUENCY_RANGE_DECIMALS", "int", frequency.rangeDecimals, {
    cppOnly: true,
    comment: "Decimals with which the limits of the frequency are written.",
  });
  constant("MINIMUM_SPREADING_FACTOR", "uint8_t", radio.spreadingFactor.minimum, {
    group: true,
    comment: "Spreading factor.",
  });
  constant("MAXIMUM_SPREADING_FACTOR", "uint8_t", radio.spreadingFactor.maximum);
  constant("DEFAULT_SPREADING_FACTOR", "uint8_t", radio.spreadingFactor.default);
  list(
    "SPREADING_FACTORS",
    "uint8_t",
    range(radio.spreadingFactor.minimum, radio.spreadingFactor.maximum),
    { tsOnly: true },
  );
  list("BANDWIDTHS", "uint16_t", radio.bandwidthsKilohertz, {
    unit: "kHz",
    group: true,
    comment: "Bandwidth.",
  });
  constant("DEFAULT_BANDWIDTH", "uint16_t", radio.defaultBandwidthKilohertz, {
    unit: "kHz",
    cppOnly: true,
  });
  constant("MINIMUM_CODING_RATE_DENOMINATOR", "uint8_t", radio.codingRateDenominator.minimum, {
    group: true,
    comment: "Coding rate as its denominator: 5 means 4/5.",
  });
  constant("MAXIMUM_CODING_RATE_DENOMINATOR", "uint8_t", radio.codingRateDenominator.maximum);
  constant("DEFAULT_CODING_RATE_DENOMINATOR", "uint8_t", radio.codingRateDenominator.default);
  list(
    "CODING_RATE_DENOMINATORS",
    "uint8_t",
    range(radio.codingRateDenominator.minimum, radio.codingRateDenominator.maximum),
    { tsOnly: true },
  );
  constant("MINIMUM_PREAMBLE_LENGTH", "uint16_t", radio.preambleLength.minimum, {
    group: true,
    comment: "Preamble length in symbols.",
  });
  constant("MAXIMUM_PREAMBLE_LENGTH", "uint16_t", radio.preambleLength.maximum);
  constant("DEFAULT_PREAMBLE_LENGTH", "uint16_t", radio.preambleLength.default);
  constant("MINIMUM_SYNC_WORD", "uint8_t", syncWord.minimum, {
    group: true,
    comment: "Sync word, as an integer.",
  });
  constant("MAXIMUM_SYNC_WORD", "uint8_t", syncWord.maximum);
  constant("DEFAULT_SYNC_WORD", "uint8_t", syncWord.default, { format: "hex2", cppOnly: true });
  constant("DEFAULT_TRANSMIT_POWER", "int8_t", radio.defaultTransmitPowerDbm, {
    unit: "dBm",
    cppOnly: true,
    comment: "At the antenna connector, on every board model.",
  });
  constant("DEFAULT_LNA_MODE", "LnaMode", radio.defaultLnaMode, { format: "enumerator" });
  definitions.push(
    vocabulary(
      "RadioSettingKey",
      "RADIO_SETTING_KEYS",
      radio.settingKeys,
      "Keys of the radio command.",
      { cppCount: true },
    ),
  );
  constant("ON_AIR_BANDWIDTH", "uint16_t", radio.onAir.bandwidthKilohertz, {
    unit: "kHz",
    group: true,
    tsOnly: true,
    comment:
      "Limits of ADR 0004 for transmitting with an antenna. The firmware does not enforce them; the " +
      "operator does.",
  });
  constant("ON_AIR_MAXIMUM_POWER", "int8_t", radio.onAir.maximumPowerDbm, {
    unit: "dBm",
    tsOnly: true,
  });
  constant("ON_AIR_MINIMUM_CENTER", "float", radio.onAir.minimumCenterMegahertz, {
    unit: "MHz",
    tsOnly: true,
  });
  constant("ON_AIR_MAXIMUM_CENTER", "float", radio.onAir.maximumCenterMegahertz, {
    unit: "MHz",
    tsOnly: true,
  });
  ts(tsDefaultRadioSettings(radio, syncWord.default));

  section("Console (docs/protocol/console.md)");
  constant("CONSOLE_BAUD_RATE", "uint32_t", consoleContract.baudRate);
  constant("CONSOLE_LINE_CAPACITY", "size_t", consoleContract.lineCapacity, {
    comment: "Longest command line, except load_image.",
  });
  constant("IMAGE_LINE_CAPACITY", "size_t", imageLineCapacity, {
    comment:
      `Longest load_image line: ${consoleContract.imageLine.hexadecimalDigitsPerByte} hexadecimal ` +
      `digits per byte of MAXIMUM_IMAGE_SIZE, plus ${consoleContract.imageLine.commandWordAllowance} ` +
      'characters for the command word "load_image " and a margin.',
  });
  constant("CONSOLE_WEBSOCKET_PATH", "const char *", consoleContract.webSocket.path, {
    cppOnly: true,
    comment: "Path of the console on the WebSocket server of a node.",
  });
  list("ACCESS_POINT_ADDRESS", "uint8_t", accessPointAddress, {
    cppOnly: true,
    comment: "IPv4 address of a node on its own access point, where the WebSocket server listens.",
  });
  constant("CONSOLE_WEBSOCKET_URL", "const char *", webSocketUrl, {
    tsOnly: true,
    comment: "Console of a node on its own access point.",
  });
  constant("ACCESS_POINT_NAME_PREFIX", "const char *", consoleContract.accessPointNamePrefix, {
    group: true,
    tsOnly: true,
    comment: "The access point of a node is named with this prefix and the node identifier.",
  });
  constant(
    "ACCESS_POINT_NAME_FORMAT",
    "const char *",
    `${consoleContract.accessPointNamePrefix}%0${nodeIdDigits}X`,
    {
      cppOnly: true,
      comment: `Name of the access point of a node: "${consoleContract.accessPointNamePrefix}" and the node identifier.`,
    },
  );
  constant(
    "ACCESS_POINT_NAME_LENGTH",
    "size_t",
    consoleContract.accessPointNamePrefix.length + nodeIdDigits,
    { cppOnly: true },
  );
  constant("ERROR_COMMAND_WORD_LENGTH", "size_t", consoleContract.errorCommandWordLength, {
    comment:
      "The cmd field of an error for a line that names no command keeps at most this many " +
      "characters of its first word.",
  });
  cpp(cppCommandTable(commands, consoleContract.commandPreconditions));
  ts(tsCommandTable(commands, consoleContract.commandPreconditions));
  constant("RSSI_DECIMALS", "int", consoleContract.decimals.rssi, {
    group: true,
    comment: "Decimals of the values the events report.",
  });
  constant("SNR_DECIMALS", "int", consoleContract.decimals.snr);
  constant("FREQUENCY_DECIMALS", "int", consoleContract.decimals.frequency);
  constant("PACKET_DELIVERY_RATIO_DECIMALS", "int", consoleContract.decimals.packetDeliveryRatio);

  section("Timings (docs/protocol/frame.md and docs/protocol/console.md)");
  constant("HELLO_PERIOD", "uint32_t", timings.helloPeriodMilliseconds, {
    unit: "ms",
    group: true,
    comment: "A node sends a HELLO every period, give or take the jitter at random.",
  });
  constant("HELLO_JITTER", "uint32_t", timings.helloJitterMilliseconds, { unit: "ms" });
  constant("FIRST_HELLO_MINIMUM_DELAY", "uint32_t", timings.firstHelloMinimumDelayMilliseconds, {
    unit: "ms",
    group: true,
    comment: "The first HELLO after a boot or a suspension leaves within this window.",
  });
  constant("FIRST_HELLO_MAXIMUM_DELAY", "uint32_t", timings.firstHelloMaximumDelayMilliseconds, {
    unit: "ms",
  });
  constant("NEIGHBOR_EXPIRY", "uint32_t", timings.neighborExpiry.milliseconds, {
    unit: "ms",
    comment:
      "A neighbor leaves the table when no packet of it arrives for this long; see isNeighborExpired.",
  });
  cpp(cppNeighborExpiry(timings.neighborExpiry));
  ts(tsNeighborExpiry(timings.neighborExpiry));
  constant("MINIMUM_PRESENCE_HOLD", "uint32_t", timings.minimumPresenceHoldSeconds, {
    unit: "s",
    group: true,
    comment: "Limits, in seconds, of the hold of the HELLO messages that presence off accepts.",
  });
  constant("MAXIMUM_PRESENCE_HOLD", "uint32_t", timings.maximumPresenceHoldSeconds, { unit: "s" });
  constant("RESPONSE_MARGIN", "uint32_t", timings.responseMarginMilliseconds, {
    unit: "ms",
    comment: "Margin of the echo_lost and run_end deadlines; see the functions below.",
  });
  cpp(cppResponseDeadlines());
  ts(tsResponseDeadlines());
  constant("TRANSFER_MARGIN", "uint32_t", timings.transferMarginMilliseconds, {
    unit: "ms",
    comment: "Added to the burst end and to the report repeat deadlines.",
  });

  return definitions;
}

// ---------------------------------------------------------------------------------------------
// Names and literals

const UNIT_SUFFIXES = {
  ms: { cpp: "_MS", ts: "_MILLISECONDS" },
  s: { cpp: "_S", ts: "_SECONDS" },
  MHz: { cpp: "_MHZ", ts: "_MEGAHERTZ" },
  kHz: { cpp: "_KHZ", ts: "_KILOHERTZ" },
  dBm: { cpp: "_DBM", ts: "_DBM" },
};

function constantName(definition, language) {
  if (definition.unit === undefined) {
    return definition.base;
  }
  return definition.base + UNIT_SUFFIXES[definition.unit][language];
}

function hexadecimal(value, digits, uppercase) {
  const text = value.toString(16).padStart(digits, "0");
  return `0x${uppercase ? text.toUpperCase() : text}`;
}

function cppLiteral(value, definition) {
  if (definition.format === "hex2" || definition.format === "hex4") {
    return hexadecimal(value, Number(definition.format.slice(3)), true);
  }
  if (definition.format === "enumerator") {
    return `${definition.cppType}::${upperCamelCase(value)}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (definition.cppType === "float") {
    return `${Number.isInteger(value) ? value.toFixed(1) : String(value)}f`;
  }
  return String(value);
}

function tsLiteral(value, definition) {
  if (definition.format === "hex2" || definition.format === "hex4") {
    return hexadecimal(value, Number(definition.format.slice(3)), false);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}

function tsKey(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

// Splits text into lines of at most width characters, at spaces.
function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length > 0 ? `${line} ${word}` : word;
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines;
}

function cppComment(text, indent = "") {
  if (text === undefined) {
    return [];
  }
  return wrap(text, COLUMN_LIMIT - indent.length - 3).map((line) => `${indent}// ${line}`);
}

function tsComment(text, indent = "") {
  if (text === undefined) {
    return [];
  }
  const single = `${indent}/** ${text} */`;
  if (single.length <= COLUMN_LIMIT) {
    return [single];
  }
  return [
    `${indent}/**`,
    ...wrap(text, COLUMN_LIMIT - indent.length - 3).map((line) => `${indent} * ${line}`),
    `${indent} */`,
  ];
}

// An array or object literal on one line; the formatter of the panel lays it out.
function tsJoin(prefix, shape, items, suffix) {
  const [open, close] = shape === "object" ? ["{", "}"] : ["[", "]"];
  const padding = shape === "object" && items.length > 0 ? " " : "";
  return [`${prefix}${open}${padding}${items.join(", ")}${padding}${close}${suffix}`];
}

function cppTypePrefix(type) {
  return type.endsWith("*") ? type : `${type} `;
}

function sectionComment(title) {
  return `// ${"-".repeat(COLUMN_LIMIT - 3)}\n// ${title}`;
}

/**
 * A braced list on one line, or one item per line with its comment; clang-format lays it out.
 * @param {string} prefix
 * @param {string[]} items
 * @param {string} suffix
 * @param {string[]} [comments]
 */
function cppJoin(prefix, items, suffix, comments) {
  if (comments === undefined) {
    return [`${prefix}{${items.join(", ")}}${suffix}`];
  }
  return [
    `${prefix}{`,
    ...items.map((item, index) => `    ${item}, // ${comments[index]}`),
    `}${suffix}`,
  ];
}

// ---------------------------------------------------------------------------------------------
// Pieces written by hand for each language

// One row per board model, and the functions that read it, so that a consumer that needs "the
// powers of model X" reads the row instead of switching over the models.
function cppBoardTable(boardModels) {
  const maximumAdditional = Math.max(
    1,
    ...boardModels.map((board) => board.transmitPowerDbm.additionalValues.length),
  );
  const maximumSteps = Math.max(...boardModels.map((board) => board.frontEndGainSteps.length));
  const lines = [];
  lines.push(
    `constexpr size_t MAXIMUM_ADDITIONAL_TRANSMIT_POWERS = ${maximumAdditional};`,
    `constexpr size_t MAXIMUM_FRONT_END_GAIN_STEPS = ${maximumSteps};`,
    "",
    "// Gain of the front end between the transceiver and the antenna connector, for a range of antenna",
    "// power.",
    "struct FrontEndGainStep {",
    "  int8_t minimumAntennaDbm;",
    "  int8_t maximumAntennaDbm;",
    "  int8_t gainDb;",
    "};",
    "",
    "// What sets one board model apart for the radio settings.",
    "struct BoardModelDescription {",
    "  BoardModel model;",
    "  // Transmit power at the antenna connector: the continuous range and the values accepted",
    "  // outside it.",
    "  int8_t minimumTransmitPowerDbm;",
    "  int8_t maximumTransmitPowerDbm;",
    "  uint8_t additionalTransmitPowerCount;",
    "  int8_t additionalTransmitPowersDbm[MAXIMUM_ADDITIONAL_TRANSMIT_POWERS];",
    "  // The LNA that the radio setting lna controls.",
    "  bool hasLowNoiseAmplifier;",
    "  // In ascending order of antenna power, one for each reachable power.",
    "  uint8_t frontEndGainStepCount;",
    "  FrontEndGainStep frontEndGainSteps[MAXIMUM_FRONT_END_GAIN_STEPS];",
    "};",
    "",
    "// Every board model, in the order of the enumerators.",
    "constexpr BoardModelDescription BOARD_MODEL_DESCRIPTIONS[] = {",
  );
  for (const board of boardModels) {
    const power = board.transmitPowerDbm;
    const steps = board.frontEndGainSteps.map(
      (step) => `{${step.minimumAntennaDbm}, ${step.maximumAntennaDbm}, ${step.gainDb}}`,
    );
    const fields = [
      `BoardModel::${board.identifier}`,
      power.minimum,
      power.maximum,
      power.additionalValues.length,
      `{${power.additionalValues.join(", ")}}`,
      board.hasLowNoiseAmplifier,
      steps.length,
      `{${steps.join(", ")}}`,
    ];
    lines.push(`    {${fields.join(", ")}},`);
  }
  lines.push(
    "};",
    "",
    "// The row of the model, or the first row for a value outside the enumeration.",
    "constexpr const BoardModelDescription &describeBoardModel(BoardModel model) {",
    "  for (const BoardModelDescription &description : BOARD_MODEL_DESCRIPTIONS) {",
    "    if (description.model == model) {",
    "      return description;",
    "    }",
    "  }",
    "  return BOARD_MODEL_DESCRIPTIONS[0];",
    "}",
    "",
    "// Whether the board model delivers antennaDbm at the antenna connector.",
    "constexpr bool isTransmitPowerReachable(BoardModel model, int antennaDbm) {",
    "  const BoardModelDescription &description = describeBoardModel(model);",
    "  if (antennaDbm >= description.minimumTransmitPowerDbm &&",
    "      antennaDbm <= description.maximumTransmitPowerDbm) {",
    "    return true;",
    "  }",
    "  for (uint8_t index = 0; index < description.additionalTransmitPowerCount; ++index) {",
    "    if (antennaDbm == description.additionalTransmitPowersDbm[index]) {",
    "      return true;",
    "    }",
    "  }",
    "  return false;",
    "}",
    "",
    "// Transceiver setting that delivers antennaDbm at the antenna connector, for a reachable power:",
    "// the gain of the front end of the board model, if any, is subtracted.",
    "constexpr int transceiverPowerFor(BoardModel model, int antennaDbm) {",
    "  const BoardModelDescription &description = describeBoardModel(model);",
    "  const uint8_t last = description.frontEndGainStepCount - 1;",
    "  for (uint8_t index = 0; index < last; ++index) {",
    "    if (antennaDbm <= description.frontEndGainSteps[index].maximumAntennaDbm) {",
    "      return antennaDbm - description.frontEndGainSteps[index].gainDb;",
    "    }",
    "  }",
    "  return antennaDbm - description.frontEndGainSteps[last].gainDb;",
    "}",
    "",
    "// Whether the board model has the LNA that the radio setting lna controls.",
    "constexpr bool hasLowNoiseAmplifier(BoardModel model) {",
    "  return describeBoardModel(model).hasLowNoiseAmplifier;",
    "}",
  );
  return lines.join("\n");
}

function tsBoardTables(boardModels, anyModelPower) {
  const lines = [];
  lines.push(
    "/** Transmit power at the antenna connector, in dBm, that each board model delivers. */",
    "export const TRANSMIT_POWER_RANGES = {",
  );
  for (const board of boardModels) {
    const power = board.transmitPowerDbm;
    lines.push(
      ...tsJoin(
        `  ${tsKey(board.name)}: `,
        "object",
        [
          `minimum: ${power.minimum}`,
          `maximum: ${power.maximum}`,
          `additionalValues: [${power.additionalValues.join(", ")}]`,
        ],
        ",",
      ),
    );
  }
  lines.push("} as const;", "");
  lines.push(
    "/** Hull of the ranges of every board model, for a node whose model is not known yet. */",
    ...tsJoin(
      "export const ANY_MODEL_TRANSMIT_POWER_RANGE = ",
      "object",
      [
        `minimum: ${anyModelPower.minimum}`,
        `maximum: ${anyModelPower.maximum}`,
        "additionalValues: []",
      ],
      " as const;",
    ),
    "",
  );
  lines.push(
    "/**",
    " * Gain of the front end between the transceiver and the antenna connector, by ranges of antenna",
    " * power: the radio event reports the transceiver setting as chip = power - gain.",
    " */",
    "export const FRONT_END_GAIN_STEPS = {",
  );
  for (const board of boardModels) {
    const steps = board.frontEndGainSteps.map(
      (step) =>
        `{ minimumAntennaDbm: ${step.minimumAntennaDbm}, maximumAntennaDbm: ${step.maximumAntennaDbm}, gainDb: ${step.gainDb} }`,
    );
    lines.push(...tsJoin(`  ${tsKey(board.name)}: `, "array", steps, ","));
  }
  lines.push("} as const;", "");
  lines.push(
    "/**",
    " * Ranges of antenna power at which the datasheet of the transceiver of each board model limits",
    " * the duty cycle.",
    " */",
    "export const TRANSMIT_DUTY_CYCLE_LIMITS = {",
  );
  for (const board of boardModels) {
    const limits = board.dutyCycleLimits.map(
      (limit) =>
        `{ minimumAntennaDbm: ${limit.minimumAntennaDbm}, maximumAntennaDbm: ${limit.maximumAntennaDbm}, maximumDutyCyclePercent: ${limit.maximumDutyCyclePercent} }`,
    );
    lines.push(...tsJoin(`  ${tsKey(board.name)}: `, "array", limits, ","));
  }
  lines.push("} as const;", "");
  lines.push(
    "/** LoRa transceiver of each board model. */",
    ...tsJoin(
      "export const TRANSCEIVERS = ",
      "object",
      boardModels.map((board) => `${tsKey(board.name)}: ${JSON.stringify(board.transceiver)}`),
      " as const;",
    ),
    "",
  );
  const amplified = boardModels
    .filter((board) => board.hasLowNoiseAmplifier)
    .map((board) => JSON.stringify(board.name));
  lines.push(
    "/** Board models with the LNA that the radio setting lna controls. */",
    ...tsJoin("export const LOW_NOISE_AMPLIFIER_BOARD_MODELS = ", "array", amplified, " as const;"),
  );
  return lines.join("\n");
}

// The checks of the image format, in the order the node makes them, with the text that follows
// "format: " in the detail of invalid_image.
function cppImageFormatDefects(defects) {
  return [
    "// What is wrong with the format of an image, in the order of the checks.",
    "enum class ImageFormatDefect : uint8_t {",
    ...defects.map((defect) => `  ${upperCamelCase(defect.name)},`),
    "};",
    "",
    '// Text of the defect in the detail of invalid_image, after "format: ".',
    "constexpr const char *imageFormatDefectDetail(ImageFormatDefect defect) {",
    "  switch (defect) {",
    ...defects.flatMap((defect) => [
      `  case ImageFormatDefect::${upperCamelCase(defect.name)}:`,
      `    return ${JSON.stringify(defect.detail)};`,
    ]),
    "  }",
    '  return "";',
    "}",
  ].join("\n");
}

function tsImageFormatDefects(defects) {
  return [
    "/**",
    " * What is wrong with the format of an image, in the order of the checks, with the text that",
    ' * follows "format: " in the detail of invalid_image.',
    " */",
    ...tsJoin(
      "export const IMAGE_FORMAT_DEFECTS = ",
      "object",
      defects.map((defect) => `${defect.name}: ${JSON.stringify(defect.detail)}`),
      " as const;",
    ),
  ].join("\n");
}

function cppInstructionTable(vm) {
  const lines = [];
  lines.push(
    "// Length in bytes of an instruction of the form, opcode included.",
    "constexpr size_t operandFormLength(OperandForm form) {",
    "  switch (form) {",
  );
  for (const form of vm.operandForms) {
    lines.push(`  case OperandForm::${upperCamelCase(form.name)}:`, `    return ${form.length};`);
  }
  lines.push("  }", "  return 0;", "}", "");
  lines.push(
    "struct InstructionEncoding {",
    "  Opcode opcode;",
    "  OperandForm form;",
    "  InstructionEffect effect;",
    "};",
    "",
    "// Every instruction, in opcode order.",
    "constexpr InstructionEncoding INSTRUCTION_ENCODINGS[] = {",
  );
  for (const instruction of vm.instructions) {
    lines.push(
      `    {Opcode::${instruction.identifier}, OperandForm::${upperCamelCase(instruction.form)}, InstructionEffect::${upperCamelCase(instruction.effect)}},`,
    );
  }
  lines.push("};");
  return lines.join("\n");
}

function tsInstructionTable(vm) {
  const lines = [];
  lines.push(
    "/** Length in bytes of an instruction of each form, opcode included. */",
    ...tsJoin(
      "export const OPERAND_FORM_LENGTHS = ",
      "object",
      vm.operandForms.map((form) => `${tsKey(form.name)}: ${form.length}`),
      " as const;",
    ),
    "",
    "/** Every instruction, in opcode order. */",
    "export const INSTRUCTION_ENCODINGS = [",
  );
  for (const instruction of vm.instructions) {
    const opcode = numberOf(instruction.opcode, instruction.mnemonic);
    lines.push(
      `  { mnemonic: ${JSON.stringify(instruction.mnemonic)}, opcode: ${hexadecimal(opcode, 2, false)}, form: ${JSON.stringify(instruction.form)}, effect: ${JSON.stringify(instruction.effect)} },`,
    );
  }
  lines.push("] as const;");
  return lines.join("\n");
}

function tsDefaultRadioSettings(radio, syncWord) {
  return [
    "/** Settings every node boots with, with the field names of the radio event. */",
    "export const DEFAULT_RADIO_SETTINGS = {",
    `  freq: ${radio.frequencyMegahertz.default},`,
    `  sf: ${radio.spreadingFactor.default},`,
    `  bw: ${radio.defaultBandwidthKilohertz},`,
    `  cr: ${radio.codingRateDenominator.default},`,
    `  preamble: ${radio.preambleLength.default},`,
    `  sync: ${hexadecimal(syncWord, 2, false)},`,
    `  power: ${radio.defaultTransmitPowerDbm},`,
    `  lna: ${JSON.stringify(radio.defaultLnaMode)},`,
    "} as const;",
  ].join("\n");
}

function cppNeighborExpiry(expiry) {
  const operator = expiry.expiresAtBoundary ? ">=" : ">";
  return [
    `// True when a neighbor last heard elapsedMillis ago has expired, ${expiry.expiresAtBoundary ? "from NEIGHBOR_EXPIRY_MS on" : "only past NEIGHBOR_EXPIRY_MS"}.`,
    "constexpr bool isNeighborExpired(uint32_t elapsedMillis) {",
    `  return elapsedMillis ${operator} NEIGHBOR_EXPIRY_MS;`,
    "}",
  ].join("\n");
}

function tsNeighborExpiry(expiry) {
  const operator = expiry.expiresAtBoundary ? ">=" : ">";
  return [
    "/**",
    ` * True when a neighbor last heard \`elapsedMilliseconds\` ago has expired, ${expiry.expiresAtBoundary ? "from" : "only past"}`,
    ` * NEIGHBOR_EXPIRY_MILLISECONDS${expiry.expiresAtBoundary ? " on" : ""}, as in the firmware.`,
    " */",
    "export function isNeighborExpired(elapsedMilliseconds: number): boolean {",
    `  return elapsedMilliseconds ${operator} NEIGHBOR_EXPIRY_MILLISECONDS;`,
    "}",
  ].join("\n");
}

// The two deadlines a node measures from the time on air of a frame (docs/protocol/console.md),
// each written once as an expression that both languages render. The time on air counts in whole
// milliseconds, rounded up.
const parameter = (index) => ({ kind: "parameter", index });
const roundedUpMilliseconds = (microseconds) => ({ kind: "milliseconds", of: microseconds });
const twice = (term) => ({ kind: "twice", of: term });
const sum = (...terms) => ({ kind: "sum", terms });
const RESPONSE_MARGIN = { kind: "margin" };

const RESPONSE_DEADLINES = [
  {
    names: { cpp: "echoLossDeadlineMillis", ts: "echoLossDeadlineMilliseconds" },
    parameters: [{ cpp: "requestTimeOnAirMicros", ts: "requestTimeOnAirMicroseconds" }],
    comment:
      "Time from the start of an echo request on the air until the requester reports echo_lost: " +
      "twice the time on air of the request in whole milliseconds, rounded up, plus the margin",
    expression: sum(twice(roundedUpMilliseconds(parameter(0))), RESPONSE_MARGIN),
  },
  {
    names: { cpp: "runReceptionDeadlineMillis", ts: "runReceptionDeadlineMilliseconds" },
    parameters: [
      { cpp: "intervalMillis", ts: "intervalMilliseconds" },
      { cpp: "packetTimeOnAirMicros", ts: "packetTimeOnAirMicroseconds" },
    ],
    comment:
      "Time from a TEST packet of a run until the receiver ends the run with run_end when no other " +
      "arrives: twice the sum of the interval and the time on air of the packet in whole " +
      "milliseconds, rounded up, plus the margin",
    expression: sum(twice(sum(parameter(0), roundedUpMilliseconds(parameter(1)))), RESPONSE_MARGIN),
  },
];

// The text of an expression in a language, with its precedence: 1 for a sum, 2 for a product or a
// quotient, 3 for an operand that needs no parentheses.
function renderDeadline(expression, deadline, language) {
  const operand = (child, precedence) => {
    const rendered = renderDeadline(child, deadline, language);
    return rendered.precedence >= precedence ? rendered.text : `(${rendered.text})`;
  };
  switch (expression.kind) {
    case "parameter":
      return { text: deadline.parameters[expression.index][language], precedence: 3 };
    case "margin":
      return {
        text: language === "cpp" ? "RESPONSE_MARGIN_MS" : "RESPONSE_MARGIN_MILLISECONDS",
        precedence: 3,
      };
    case "milliseconds":
      return language === "cpp"
        ? {
            text: `${operand(sum(expression.of, { kind: "literal", value: 999 }), 2)} / 1000`,
            precedence: 2,
          }
        : { text: `Math.ceil(${operand(expression.of, 3)} / 1000)`, precedence: 3 };
    case "literal":
      return { text: String(expression.value), precedence: 3 };
    case "twice":
      // The operand goes in parentheses unless it is a single value: 2 * a / b is not 2 * (a / b)
      // in integer arithmetic.
      return { text: `2 * ${operand(expression.of, 3)}`, precedence: 2 };
    case "sum":
      return {
        text: expression.terms.map((term) => operand(term, 1)).join(" + "),
        precedence: 1,
      };
    default:
      throw new Error(`unknown deadline expression ${expression.kind}`);
  }
}

// The value of a deadline expression, to check the shared vectors against the formula.
function evaluateDeadline(expression, values, margin) {
  switch (expression.kind) {
    case "parameter":
      return values[expression.index];
    case "margin":
      return margin;
    case "milliseconds":
      return Math.ceil(evaluateDeadline(expression.of, values, margin) / 1000);
    case "twice":
      return 2 * evaluateDeadline(expression.of, values, margin);
    case "sum":
      return expression.terms.reduce(
        (total, term) => total + evaluateDeadline(term, values, margin),
        0,
      );
    default:
      throw new Error(`unknown deadline expression ${expression.kind}`);
  }
}

function cppResponseDeadlines() {
  return RESPONSE_DEADLINES.map((deadline) =>
    [
      ...cppComment(`${deadline.comment} (RESPONSE_MARGIN_MS).`),
      `constexpr uint32_t ${deadline.names.cpp}(${deadline.parameters.map((entry) => `uint32_t ${entry.cpp}`).join(", ")}) {`,
      `  return ${renderDeadline(deadline.expression, deadline, "cpp").text};`,
      "}",
    ].join("\n"),
  ).join("\n\n");
}

function tsResponseDeadlines() {
  return RESPONSE_DEADLINES.map((deadline) =>
    [
      ...tsComment(
        `${deadline.comment} (RESPONSE_MARGIN_MILLISECONDS), as the firmware computes it.`,
      ),
      `export function ${deadline.names.ts}(${deadline.parameters.map((entry) => `${entry.ts}: number`).join(", ")}): number {`,
      `  return ${renderDeadline(deadline.expression, deadline, "ts").text};`,
      "}",
    ].join("\n"),
  ).join("\n\n");
}

// The console commands with their argument counts resolved: a count is a number, or the name of
// a count that follows from the contract ("registerCount", "settingKeyPairs").
function describeConsoleCommands(consoleContract, radio, vm, imageLineCapacity, errorReasons) {
  const preconditions = consoleContract.commandPreconditions.map(
    (precondition) => precondition.name,
  );
  ensure(
    preconditions.length <= 8 && new Set(preconditions).size === preconditions.length,
    "console.commandPreconditions must be at most eight different names",
  );
  for (const precondition of consoleContract.commandPreconditions) {
    const path = `console.commandPreconditions.${precondition.name}`;
    ensure(/^[a-z][A-Za-z]*$/.test(precondition.name), `${path} needs a name in lowerCamelCase`);
    ensure(typeof precondition.description === "string", `${path} needs a description`);
    ensure(
      errorReasons.includes(precondition.refusal.reason),
      `${path} is refused with an unknown error reason`,
    );
    ensure(
      precondition.refusal.detail === null || typeof precondition.refusal.detail === "string",
      `${path} needs a detail that is a string or null`,
    );
  }
  ensure(
    Number.isInteger(consoleContract.errorCommandWordLength) &&
      consoleContract.errorCommandWordLength > 0,
    "console.errorCommandWordLength must be a positive integer",
  );
  const namedCounts = {
    registerCount: vm.registerCount,
    settingKeyPairs: 2 * radio.settingKeys.length,
  };
  const count = (value, path) => {
    if (typeof value === "string") {
      ensure(namedCounts[value] !== undefined, `${path} names the unknown count ${value}`);
      return { value: namedCounts[value], name: value };
    }
    ensure(Number.isInteger(value) && value >= 0 && value <= 0xff, `${path} must fit one byte`);
    return { value, name: null };
  };
  const names = new Set();
  const actions = new Set();
  const commands = consoleContract.commands.map((command) => {
    const path = `console.commands.${command.name}`;
    ensure(/^[a-z_]+$/.test(command.name), `${path} needs a name in lowercase snake_case`);
    ensure(!names.has(command.name), `${path} is repeated`);
    names.add(command.name);
    ensure(
      command.name.length <= consoleContract.imageLine.commandWordAllowance - 1,
      `${path} does not fit the command word allowance of the image line`,
    );
    ensure(
      command.usage === command.name || command.usage.startsWith(`${command.name} `),
      `${path} has a usage that does not start with the command`,
    );
    ensure(command.forms.length > 0, `${path} needs a form`);
    const forms = command.forms.map((form, index) => {
      const formPath = `${path}.forms[${index}]`;
      ensure(/^[a-z][A-Za-z]*$/.test(form.action), `${formPath} needs an action in lowerCamelCase`);
      ensure(!actions.has(form.action), `${formPath} repeats the action ${form.action}`);
      actions.add(form.action);
      const [minimum, maximum] = form.arguments.map((value) => count(value, formPath));
      ensure(minimum.value <= maximum.value, `${formPath} has more minimum than maximum arguments`);
      const formPreconditions = form.preconditions ?? [];
      for (const precondition of formPreconditions) {
        ensure(
          preconditions.includes(precondition),
          `${formPath} names the unknown precondition ${precondition}`,
        );
      }
      return {
        selector: form.selector ?? null,
        minimumArguments: minimum,
        maximumArguments: maximum,
        // In the order of console.commandPreconditions, which is the order of the checks.
        preconditions: preconditions.filter((name) => formPreconditions.includes(name)),
        action: form.action,
      };
    });
    if (forms.some((form) => form.maximumArguments.name === "settingKeyPairs")) {
      ensure(
        command.usage.endsWith(`(${radio.settingKeys.join(" ")})`),
        `${path} must list the keys of radio.settingKeys in its usage`,
      );
    }
    if (forms.some((form) => form.maximumArguments.name === "registerCount")) {
      const registers = Array.from({ length: vm.registerCount }, (_, index) => `<r${index + 1}>`);
      ensure(
        command.usage === `${command.name} ${registers.join(" ")}`,
        `${path} must name one argument per register in its usage`,
      );
    }
    return {
      name: command.name,
      usage: command.usage,
      carriesImage: command.carriesImage === true,
      lineCapacity:
        command.carriesImage === true ? imageLineCapacity : consoleContract.lineCapacity,
      forms,
    };
  });
  ensure(
    commands.filter((command) => command.carriesImage).length === 1,
    "exactly one console command carries an image",
  );
  return commands;
}

// The checks before a form of a command, in the order they run, each with what the node must
// meet and the error it answers when it does not.
function preconditionComment(preconditions) {
  const clauses = preconditions.map(
    (precondition) =>
      `${precondition.name}: ${precondition.description}, or else ${precondition.refusal.reason}` +
      (precondition.refusal.detail === null ? "" : ` "${precondition.refusal.detail}"`),
  );
  return `Checks that run before a form of a command, in this order: ${clauses.join("; ")}.`;
}

function cppCommandTable(commands, preconditions) {
  const preconditionName = (name) => upperSnakeCase(upperCamelCase(name));
  const lines = [
    ...cppComment(preconditionComment(preconditions)),
    "enum class CommandPrecondition : uint8_t {",
    ...preconditions.map((precondition) => `  ${upperCamelCase(precondition.name)},`),
    "};",
    "",
    "// A precondition and the error a command answers when the node does not meet it.",
    "struct CommandPreconditionCheck {",
    "  CommandPrecondition precondition;",
    "  ErrorReason refusalReason;",
    "  const char *refusalDetail; // or nullptr",
    "};",
    "",
    "// Every precondition, in the order of the checks.",
    "constexpr CommandPreconditionCheck COMMAND_PRECONDITIONS[] = {",
    ...preconditions.map((precondition) => {
      const detail = precondition.refusal.detail;
      return `    {CommandPrecondition::${upperCamelCase(precondition.name)}, ErrorReason::${upperCamelCase(precondition.refusal.reason)}, ${detail === null ? "nullptr" : JSON.stringify(detail)}},`;
    }),
    "};",
    "",
    "// The preconditions of a form, as one bit per precondition.",
    "using CommandPreconditions = uint8_t;",
    "constexpr CommandPreconditions NO_PRECONDITIONS = 0;",
    "constexpr CommandPreconditions preconditionFlag(CommandPrecondition precondition) {",
    "  return static_cast<CommandPreconditions>(1 << static_cast<uint8_t>(precondition));",
    "}",
    ...preconditions.map(
      (precondition) =>
        `constexpr CommandPreconditions ${preconditionName(precondition.name)} = preconditionFlag(CommandPrecondition::${upperCamelCase(precondition.name)});`,
    ),
    "",
    "// What a form of a command does; the firmware binds a handler to each action.",
    "enum class CommandAction : uint8_t {",
    ...commands.flatMap((command) =>
      command.forms.map((form) => `  ${upperCamelCase(form.action)},`),
    ),
    "};",
    "",
    "// One way of calling a command: the arguments it takes and the checks before its action.",
    "struct CommandForm {",
    "  const char *selector; // first argument that selects the form, or nullptr for any",
    "  uint8_t minimumArguments;",
    "  uint8_t maximumArguments;",
    "  CommandPreconditions preconditions;",
    "  CommandAction action;",
    "};",
    "",
    `constexpr size_t MAXIMUM_COMMAND_FORMS = ${Math.max(...commands.map((command) => command.forms.length))};`,
    "",
    "// A console command. A line takes the first form whose selector and argument count match it;",
    "// a line that matches none is a usage error.",
    "struct ConsoleCommand {",
    "  const char *name;",
    "  const char *usage; // help lists it, and usage errors carry it as their detail",
    "  size_t maximumLineLength;",
    "  uint8_t formCount;",
    "  CommandForm forms[MAXIMUM_COMMAND_FORMS];",
    "};",
    "",
    '// The console commands (docs/protocol/console.md, "Comandos"), in the order help lists them.',
    "constexpr ConsoleCommand CONSOLE_COMMANDS[] = {",
  ];
  for (const command of commands) {
    const formFields = command.forms.map((form) => [
      form.selector === null ? "nullptr" : JSON.stringify(form.selector),
      String(form.minimumArguments.value),
      String(form.maximumArguments.value),
      form.preconditions.length === 0
        ? "NO_PRECONDITIONS"
        : form.preconditions.map(preconditionName).join(" | "),
      `CommandAction::${upperCamelCase(form.action)}`,
    ]);
    const forms = formFields.map((fields) => `{${fields.join(", ")}}`);
    const fields = [
      JSON.stringify(command.name),
      JSON.stringify(command.usage),
      command.carriesImage ? "IMAGE_LINE_CAPACITY" : "CONSOLE_LINE_CAPACITY",
      String(forms.length),
    ];
    lines.push(`    {${fields.join(", ")}, {${forms.join(", ")}}},`);
  }
  lines.push("};");
  return lines.join("\n");
}

function tsCommandTable(commands, preconditions) {
  const lines = [
    ...tsComment(preconditionComment(preconditions)),
    ...tsJoin(
      "export const COMMAND_PRECONDITIONS = ",
      "array",
      preconditions.map(
        (precondition) =>
          `{ name: ${JSON.stringify(precondition.name)}, refusalReason: ${JSON.stringify(precondition.refusal.reason)}, refusalDetail: ${JSON.stringify(precondition.refusal.detail)} }`,
      ),
      " as const;",
    ),
    "",
    "/**",
    ' * The console commands (docs/protocol/console.md, "Comandos"), in the order help lists them, with',
    " * the characters a line of each may take. A line takes the first form whose selector and argument",
    " * count match it; a line that matches none is a usage error.",
    " */",
    "export const CONSOLE_COMMANDS = [",
  ];
  for (const command of commands) {
    lines.push(
      "  {",
      `    name: ${JSON.stringify(command.name)},`,
      `    usage: ${JSON.stringify(command.usage)},`,
      `    lineCapacity: ${command.lineCapacity},`,
      "    forms: [",
    );
    for (const form of command.forms) {
      lines.push(
        "      {",
        `        selector: ${form.selector === null ? "null" : JSON.stringify(form.selector)},`,
        `        minimumArguments: ${form.minimumArguments.value},`,
        `        maximumArguments: ${form.maximumArguments.value},`,
        ...tsJoin(
          "        preconditions: ",
          "array",
          form.preconditions.map((name) => JSON.stringify(name)),
          ",",
        ),
        `        action: ${JSON.stringify(form.action)},`,
        "      },",
      );
    }
    lines.push("    ],", "  },");
  }
  lines.push("] as const;");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Emitters

function generatedNotice(source) {
  return `Generated by ${GENERATOR_PATH} from ${source}. Do not edit: change the source and run node ${GENERATOR_PATH}.`;
}

function cppEnum(definition) {
  const lines = [...cppComment(definition.comment)];
  const name = upperSnakeCase(definition.typeName);
  const explicit = definition.wire === true;
  const width = definition.hexadecimalCodes ? 2 : 0;
  lines.push(`enum class ${definition.typeName} : uint8_t {`);
  for (const entry of definition.entries) {
    if (!explicit) {
      lines.push(`  ${entry.identifier},`);
      continue;
    }
    const code = width > 0 ? hexadecimal(entry.code, width, true) : String(entry.code);
    lines.push(`  ${entry.identifier} = ${code},`);
  }
  lines.push("};");
  if (definition.noNames) {
    return lines.join("\n");
  }
  const functionName = `${lowerCamelCase(definition.typeName)}Name`;
  const parameter = lowerCamelCase(definition.typeName.replace(/^.*?([A-Z][a-z]+)$/, "$1"));
  if (definition.cppCount) {
    lines.push(`constexpr size_t ${name}_COUNT = ${definition.entries.length};`);
  }
  lines.push(
    "",
    `// Name as the console writes it, or nullptr for a value outside the enumeration.`,
    `constexpr const char *${functionName}(${definition.typeName} ${parameter}) {`,
    `  switch (${parameter}) {`,
  );
  for (const entry of definition.entries) {
    lines.push(
      `  case ${definition.typeName}::${entry.identifier}:`,
      `    return ${JSON.stringify(entry.name)};`,
    );
  }
  lines.push("  }", "  return nullptr;", "}");
  if (explicit) {
    lines.push(
      "",
      `// Whether a byte received on the air is the code of a ${definition.typeName}.`,
      `constexpr bool isKnown${definition.typeName}(uint8_t code) {`,
      `  return ${functionName}(static_cast<${definition.typeName}>(code)) != nullptr;`,
      "}",
    );
  }
  return lines.join("\n");
}

// The panel reads the names of an enumeration, never its codes: it does not decode frames.
function tsEnum(definition) {
  const lines = [...tsComment(definition.comment)];
  const entries = definition.tupleSkipsFirst ? definition.entries.slice(1) : definition.entries;
  lines.push(
    ...tsJoin(
      `export const ${definition.tupleName} = `,
      "array",
      entries.map((entry) => JSON.stringify(entry.name)),
      " as const;",
    ),
  );
  return lines.join("\n");
}

function cppDefinition(definition) {
  switch (definition.kind) {
    case "section":
      return sectionComment(definition.title);
    case "constant": {
      if (definition.tsOnly) {
        return null;
      }
      const declaration = `constexpr ${cppTypePrefix(definition.cppType)}${constantName(definition, "cpp")} = ${cppLiteral(definition.value, definition)};`;
      return [...cppComment(definition.comment), declaration].join("\n");
    }
    case "list": {
      if (definition.tsOnly) {
        return null;
      }
      return [
        ...cppComment(definition.cppComment ?? definition.comment),
        ...cppJoin(
          `constexpr ${cppTypePrefix(definition.cppType)}${constantName(definition, "cpp")}[] = `,
          definition.values.map((value) => cppLiteral(value, definition)),
          ";",
        ),
      ].join("\n");
    }
    case "subset":
      return [
        ...cppComment(definition.comment),
        ...cppJoin(
          `constexpr ${definition.typeName} ${definition.base}[] = `,
          definition.names.map((name) => `${definition.typeName}::${upperCamelCase(name)}`),
          ";",
        ),
      ].join("\n");
    case "enum":
      return cppEnum(definition);
    case "cpp":
      return definition.text;
    default:
      return null;
  }
}

function tsDefinition(definition) {
  switch (definition.kind) {
    case "section":
      return sectionComment(definition.title);
    case "constant": {
      if (definition.cppOnly) {
        return null;
      }
      const declaration = `export const ${constantName(definition, "ts")} = ${tsLiteral(definition.value, definition)};`;
      return [...tsComment(definition.comment), declaration].join("\n");
    }
    case "list":
      if (definition.cppOnly) {
        return null;
      }
      return [
        ...tsComment(definition.comment),
        ...tsJoin(
          `export const ${constantName(definition, "ts")} = `,
          "array",
          definition.values.map((value) => tsLiteral(value, definition)),
          " as const;",
        ),
      ].join("\n");
    case "subset":
      if (definition.cppOnly) {
        return null;
      }
      return [
        ...tsComment(definition.comment),
        ...tsJoin(
          `export const ${definition.base} = `,
          "array",
          definition.names.map((name) => JSON.stringify(name)),
          " as const;",
        ),
      ].join("\n");
    case "enum":
      return definition.cppOnly ? null : tsEnum(definition);
    case "ts":
      return definition.text;
    default:
      return null;
  }
}

// Blank lines between definitions, except that a constant without a comment joins the constants
// before it when they have no comment either or when their comment covers a group. A section with
// nothing for the language is left out.
function joinDefinitions(definitions, render) {
  const rendered = definitions
    .map((definition) => ({ definition, text: render(definition) }))
    .filter(({ text }) => text !== null)
    .filter(
      ({ definition }, index, all) =>
        definition.kind !== "section" ||
        (index + 1 < all.length && all[index + 1].definition.kind !== "section"),
    );
  let output = "";
  let previousOpensGroup = false;
  for (const { definition, text } of rendered) {
    const isConstant = definition.kind === "constant" || definition.kind === "list";
    const joins = isConstant && previousOpensGroup && !text.includes("\n");
    if (output.length > 0) {
      output += joins ? "\n" : "\n\n";
    }
    output += text;
    previousOpensGroup =
      isConstant && (joins || definition.comment === undefined || definition.group === true);
  }
  return output;
}

function generateFirmwareHeader(definitions) {
  return [
    ...cppComment(generatedNotice(CONTRACT_PATH)),
    "",
    "#ifndef J5_PROTOCOL_CONTRACT_H",
    "#define J5_PROTOCOL_CONTRACT_H",
    "",
    "#include <stddef.h>",
    "#include <stdint.h>",
    "",
    "namespace firmware {",
    "",
    joinDefinitions(definitions, cppDefinition),
    "",
    "} // namespace firmware",
    "",
    "#endif",
    "",
  ].join("\n");
}

function generatePanelModule(definitions) {
  return [
    ...cppComment(generatedNotice(CONTRACT_PATH)),
    "",
    joinDefinitions(definitions, tsDefinition),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Test vectors for the firmware host tests

function ensureVector(condition, path, message) {
  if (!condition) {
    throw new ContractError(`${path}: ${message}`);
  }
}

function cppStringConstant(name, value) {
  return `constexpr const char *${name} = ${JSON.stringify(value)};`;
}

// Checks each frame of the vector against the contract and computes its tag with the HMAC-SHA256
// of Node, independently of the firmware: the tag covers the protocol version, which does not
// travel, followed by the header and the body (docs/protocol/frame.md).
function checkFrameVector(vector, contract) {
  const path = TEST_VECTOR_PATHS.frame;
  const frame = contract.frame;
  ensureVector(
    vector.protocolVersion === contract.versions.frameProtocol,
    path,
    "protocolVersion is not versions.frameProtocol of the contract",
  );
  const messageCodes = frame.messageTypes.map((type) => numberOf(type.code, type.name));
  for (const entry of vector.frames) {
    const header = Buffer.alloc(frame.headerSize);
    const type = numberOf(entry.type, `${entry.name}.type`);
    ensureVector(messageCodes.includes(type), path, `${entry.name} has an unknown message type`);
    header.writeUInt8(type, frame.headerOffsets.type);
    header.writeUInt16LE(
      numberOf(entry.source, `${entry.name}.source`),
      frame.headerOffsets.source,
    );
    header.writeUInt16LE(
      numberOf(entry.destination, `${entry.name}.destination`),
      frame.headerOffsets.destination,
    );
    header.writeUInt8(entry.epoch, frame.headerOffsets.epoch);
    header.writeUInt16LE(entry.sequence, frame.headerOffsets.sequence);
    const authenticated = Buffer.concat([header, Buffer.from(entry.body, "hex")]);
    const tag = createHmac("sha256", vector.networkKey)
      .update(Buffer.from([vector.protocolVersion]))
      .update(authenticated)
      .digest()
      .subarray(0, frame.tagSize);
    ensureVector(
      entry.frame === Buffer.concat([authenticated, tag]).toString("hex"),
      path,
      `${entry.name}: frame is not the header, the body and the HMAC-SHA256 tag`,
    );
    ensureVector(
      entry.frame.length <= 2 * frame.maximumFrameSize,
      path,
      `${entry.name} is longer than a frame`,
    );
  }
}

// The seed of an Ed25519 private key in PEM, as hexadecimal digits.
function operatorSeedOf(signingKey) {
  const key = createPrivateKey(signingKey);
  ensureVector(
    key.asymmetricKeyType === "ed25519",
    TEST_VECTOR_PATHS.signedImage,
    "signingKey is not an Ed25519 key",
  );
  return Buffer.from(String(key.export({ format: "jwk" }).d), "base64url").toString("hex");
}

function cppInteger32(value) {
  return value === -2147483648 ? "-2147483647 - 1" : String(value);
}

function generateTestVectorHeader(vectors, contract, signingKey) {
  const { consoleCommandLines, frame, responseDeadlines, signedImage, timeOnAir, virtualMachine } =
    vectors;
  const registerCount = contract.virtualMachine.registerCount;
  const defaultLimit = contract.virtualMachine.maximumInstructionsPerTick;

  ensureVector(
    signedImage.image === signedImage.header + signedImage.program + signedImage.signature,
    TEST_VECTOR_PATHS.signedImage,
    "image is not header, program and signature",
  );
  ensureVector(
    signedImage.program.length === 2 * signedImage.programLength,
    TEST_VECTOR_PATHS.signedImage,
    "programLength does not match program",
  );
  for (const run of virtualMachine.runs) {
    ensureVector(
      run.registers.length === registerCount && run.expected.registers.length === registerCount,
      TEST_VECTOR_PATHS.virtualMachine,
      `${run.name} needs ${registerCount} registers`,
    );
  }

  checkFrameVector(frame, contract);

  const sections = [];
  sections.push(
    [
      ...cppComment(
        `Frames (${TEST_VECTOR_PATHS.frame}), authenticated with the network key ` +
          `${JSON.stringify(frame.networkKey)} and the protocol version ${frame.protocolVersion}; ` +
          "the generator checks each tag with the HMAC-SHA256 of Node.",
      ),
      `constexpr const char *FRAME_VECTOR_NETWORK_KEY = ${JSON.stringify(frame.networkKey)};`,
      "",
      "struct FrameVector {",
      "  const char *name;",
      "  uint8_t type;",
      "  uint16_t source;",
      "  uint16_t destination;",
      "  uint8_t epoch;",
      "  uint16_t sequence;",
      "  const char *body;",
      "  const char *frame; // header, body and tag",
      "};",
      "",
      "constexpr FrameVector FRAME_VECTORS[] = {",
      ...frame.frames.map((entry) => {
        const fields = [
          JSON.stringify(entry.name),
          hexadecimal(numberOf(entry.type, entry.name), 2, true),
          hexadecimal(numberOf(entry.source, entry.name), 4, true),
          hexadecimal(numberOf(entry.destination, entry.name), 4, true),
          String(entry.epoch),
          String(entry.sequence),
          JSON.stringify(entry.body),
          JSON.stringify(entry.frame),
        ];
        return ["    {", ...fields.map((field) => `        ${field},`), "    },"].join("\n");
      }),
      "};",
      `constexpr size_t FRAME_VECTOR_COUNT = ${frame.frames.length};`,
    ].join("\n"),
  );
  const imageConstants = [
    ["SIGNED_IMAGE_VECTOR_PROGRAM", signedImage.program],
    ["SIGNED_IMAGE_VECTOR_HEADER", signedImage.header],
    ["SIGNED_IMAGE_VECTOR_SIGNED_MESSAGE", signedImage.signedMessage],
    ["SIGNED_IMAGE_VECTOR_SIGNATURE", signedImage.signature],
    ["SIGNED_IMAGE_VECTOR_IMAGE", signedImage.image],
  ];
  sections.push(
    [
      ...cppComment(
        `Signed image (${TEST_VECTOR_PATHS.signedImage}), signed with ${signedImage.signingKey}.`,
      ),
      ...cppComment(`${signedImage.assembly}.`),
      `constexpr size_t SIGNED_IMAGE_VECTOR_PROGRAM_LENGTH = ${signedImage.programLength};`,
      `constexpr uint32_t SIGNED_IMAGE_VECTOR_VERSION = ${signedImage.version};`,
      ...cppComment(
        `Seed of the Ed25519 key of ${signedImage.signingKey}, for the images that the tests sign.`,
      ),
      cppStringConstant("DEFAULT_OPERATOR_KEY_SEED", operatorSeedOf(signingKey)),
      ...imageConstants.map(([name, value]) => cppStringConstant(name, value)),
    ].join("\n"),
  );

  sections.push(
    [
      ...cppComment(`Time on air reference cases (${TEST_VECTOR_PATHS.timeOnAir}).`),
      "struct TimeOnAirVector {",
      "  size_t frameLength;",
      "  uint8_t spreadingFactor;",
      "  uint16_t bandwidthKhz;",
      "  uint8_t codingRateDenominator;",
      "  uint16_t preambleLength;",
      "  double expectedMillis;",
      "  uint32_t expectedMicros;",
      "};",
      "",
      ...cppJoin(
        "constexpr TimeOnAirVector TIME_ON_AIR_VECTORS[] = ",
        timeOnAir.cases.map(
          (entry) =>
            `{${entry.frameLength}, ${entry.spreadingFactor}, ${entry.bandwidthKilohertz}, ${entry.codingRateDenominator}, ${entry.preambleLength}, ${entry.expectedMilliseconds}, ${entry.expectedMicroseconds}}`,
        ),
        ";",
        timeOnAir.cases.map(
          (entry) =>
            `${entry.frameLength} bytes at SF${entry.spreadingFactor}, ${entry.bandwidthKilohertz} kHz, CR 4/${entry.codingRateDenominator}`,
        ),
      ),
      `constexpr size_t TIME_ON_AIR_VECTOR_COUNT = ${timeOnAir.cases.length};`,
    ].join("\n"),
  );

  const margin = contract.timings.responseMarginMilliseconds;
  const deadlineCases = RESPONSE_DEADLINES.map((deadline) => {
    const cases = responseDeadlines[deadline.names.ts];
    ensureVector(
      Array.isArray(cases) && cases.length > 0,
      TEST_VECTOR_PATHS.responseDeadlines,
      `${deadline.names.ts} needs cases`,
    );
    for (const entry of cases) {
      const values = deadline.parameters.map((name) => entry[name.ts]);
      ensureVector(
        values.every((value) => Number.isInteger(value) && value >= 0),
        TEST_VECTOR_PATHS.responseDeadlines,
        `a case of ${deadline.names.ts} needs ${deadline.parameters.map((name) => name.ts).join(" and ")}`,
      );
      ensureVector(
        evaluateDeadline(deadline.expression, values, margin) === entry.expectedMilliseconds,
        TEST_VECTOR_PATHS.responseDeadlines,
        `${deadline.names.ts}(${values.join(", ")}) is not ${entry.expectedMilliseconds} with the ` +
          "margin of the contract",
      );
    }
    return { deadline, cases };
  });
  const [echoLossCases, runReceptionCases] = deadlineCases.map(({ deadline, cases }) =>
    cases.map(
      (entry) =>
        `    {${[...deadline.parameters.map((name) => entry[name.ts]), entry.expectedMilliseconds].join(", ")}},`,
    ),
  );
  sections.push(
    [
      ...cppComment(
        `Response deadlines (${TEST_VECTOR_PATHS.responseDeadlines}), which the control panel ` +
          "checks too.",
      ),
      "struct EchoLossDeadlineVector {",
      "  uint32_t requestTimeOnAirMicros;",
      "  uint32_t expectedMillis;",
      "};",
      "",
      "constexpr EchoLossDeadlineVector ECHO_LOSS_DEADLINE_VECTORS[] = {",
      ...echoLossCases,
      "};",
      "",
      "struct RunReceptionDeadlineVector {",
      "  uint32_t intervalMillis;",
      "  uint32_t packetTimeOnAirMicros;",
      "  uint32_t expectedMillis;",
      "};",
      "",
      "constexpr RunReceptionDeadlineVector RUN_RECEPTION_DEADLINE_VECTORS[] = {",
      ...runReceptionCases,
      "};",
    ].join("\n"),
  );

  const maximumPrints = Math.max(
    1,
    ...virtualMachine.runs.map((run) => run.expected.prints.length),
  );
  const runs = virtualMachine.runs.map((run) => {
    const prints = run.expected.prints.map(
      (print) => `{${print.register}, ${cppInteger32(print.value)}}`,
    );
    const registers = (values) => `{${values.map(cppInteger32).join(", ")}}`;
    const fields = [
      JSON.stringify(run.name),
      JSON.stringify(run.program),
      registers(run.registers),
      String(run.instructionLimit ?? defaultLimit),
      String(run.ticks),
      JSON.stringify(run.expected.step),
      String(prints.length),
      `{${prints.join(", ")}}`,
      registers(run.expected.registers),
      run.expected.fault === null ? "nullptr" : JSON.stringify(run.expected.fault),
      String(run.expected.faultAddress ?? 0),
      String(run.expected.tickNumber),
    ];
    return ["    {", ...fields.map((field) => `        ${field},`), "    },"].join("\n");
  });
  sections.push(
    [
      ...cppComment(
        `Programs run on the virtual machine (${TEST_VECTOR_PATHS.virtualMachine}). Each run loads the ` +
          "program, sets the registers and runs whole ticks; the prints of every tick are kept in order.",
      ),
      `constexpr size_t VECTOR_REGISTER_COUNT = ${registerCount};`,
      `constexpr size_t MAXIMUM_VECTOR_PRINTS = ${maximumPrints};`,
      "",
      "struct PrintVector {",
      "  uint8_t registerNumber; // 1 to 4",
      "  int32_t value;",
      "};",
      "",
      "struct VirtualMachineRunVector {",
      "  const char *name;",
      "  const char *program;",
      "  int32_t registers[VECTOR_REGISTER_COUNT];",
      "  uint32_t instructionLimit;",
      "  uint32_t ticks;",
      '  const char *step; // "halted" or "faulted", for the last tick',
      "  size_t printCount;",
      "  PrintVector prints[MAXIMUM_VECTOR_PRINTS];",
      "  int32_t expectedRegisters[VECTOR_REGISTER_COUNT];",
      "  const char *fault; // name of the vm_fault event, or nullptr",
      "  uint16_t faultAddress;",
      "  uint32_t tickNumber;",
      "};",
      "",
      "constexpr VirtualMachineRunVector VIRTUAL_MACHINE_RUN_VECTORS[] = {",
      ...runs,
      "};",
      `constexpr size_t VIRTUAL_MACHINE_RUN_VECTOR_COUNT = ${runs.length};`,
    ].join("\n"),
  );

  sections.push(
    [
      ...cppComment(
        "Programs that the load rejects, with the address and the fault of the first bad instruction.",
      ),
      "struct ProgramCheckVector {",
      "  const char *name;",
      "  const char *program;",
      "  bool valid;",
      "  size_t address;",
      "  const char *fault;",
      "};",
      "",
      "constexpr ProgramCheckVector PROGRAM_CHECK_VECTORS[] = {",
      ...virtualMachine.checks.map(
        (check) =>
          `    {${JSON.stringify(check.name)}, ${JSON.stringify(check.program)}, ${check.valid}, ${check.address}, ${JSON.stringify(check.fault)}},`,
      ),
      "};",
      `constexpr size_t PROGRAM_CHECK_VECTOR_COUNT = ${virtualMachine.checks.length};`,
    ].join("\n"),
  );

  const modelNames = contract.boardModels.map((board) => board.name);
  for (const entry of consoleCommandLines) {
    ensureVector(
      typeof entry.builder === "string" && typeof entry.line === "string",
      TEST_VECTOR_PATHS.consoleCommandLines,
      "every line needs a builder and a line",
    );
    ensureVector(
      entry.model === null || modelNames.includes(entry.model),
      TEST_VECTOR_PATHS.consoleCommandLines,
      `${entry.line.slice(0, 40)} names an unknown board model`,
    );
  }
  const modelIdentifier = (name) =>
    contract.boardModels.find((board) => board.name === name).identifier;
  sections.push(
    [
      ...cppComment(
        `Command lines that the builders of the control panel produce ` +
          `(${TEST_VECTOR_PATHS.consoleCommandLines}), each with the board model it is meant for.`,
      ),
      "struct ConsoleCommandLineVector {",
      "  const char *builder;",
      "  bool modelKnown;",
      "  BoardModel model; // when modelKnown",
      "  const char *line;",
      "};",
      "",
      "constexpr ConsoleCommandLineVector CONSOLE_COMMAND_LINE_VECTORS[] = {",
      ...consoleCommandLines.map((entry) =>
        [
          "    {",
          `        ${JSON.stringify(entry.builder)},`,
          `        ${entry.model !== null},`,
          `        BoardModel::${modelIdentifier(entry.model ?? modelNames[0])},`,
          `        ${JSON.stringify(entry.line)},`,
          "    },",
        ].join("\n"),
      ),
      "};",
      `constexpr size_t CONSOLE_COMMAND_LINE_VECTOR_COUNT = ${consoleCommandLines.length};`,
    ].join("\n"),
  );

  return [
    ...cppComment(generatedNotice("firmware/protocol/test-vectors")),
    "",
    "#ifndef J5_GENERATED_TEST_VECTORS_H",
    "#define J5_GENERATED_TEST_VECTORS_H",
    "",
    "#include <stddef.h>",
    "#include <stdint.h>",
    "",
    '#include "protocol/protocol_contract.h"',
    "",
    "namespace firmware {",
    "",
    sections.join("\n\n"),
    "",
    "} // namespace firmware",
    "",
    "#endif",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Values that the documents repeat

// The prose of the documents repeats values of the contract. Each mention is a phrase of a document
// with the values it states between braces; --check fails when the document no longer holds the
// phrase with the current values. Between the braces:
//
//   - a term is a constant by its name in the firmware header (MAXIMUM_PAYLOAD_SIZE), a path into
//     contract.json whose array elements go by their identifier or their index
//     (boardModels.HeltecV2.transmitPowerDbm.minimum), or a decimal number;
//   - terms may be joined by +, -, * and /, evaluated from left to right (HELLO_PERIOD_MS/1000 is
//     the period in seconds);
//   - a final :es writes the number as Argentine Spanish prose does: decimal comma, minus sign and,
//     beyond four digits, groups of three separated by a space; :es.N also fixes N decimals.
//
// Without :es a value is written as String() writes it. The widths of the field tables and the codes
// of the enumerations are not listed.

// The paths of the board models and of the front-end gain steps of the V4.3.
const V2 = "boardModels.HeltecV2";
const V4_3 = "boardModels.HeltecV43";
const V4_3_GAIN = (step) => `${V4_3}.frontEndGainSteps.${step}`;
const DOCUMENT_MENTIONS = {
  "docs/protocol/frame.md": [
    "Contrato entre nodos, versión {PROTOCOL_VERSION} del protocolo.",
    "| `payload` | 0 a {MAXIMUM_PAYLOAD_SIZE} |",
    "La trama ocupa {FRAME_OVERHEAD} bytes más el cuerpo, con un total de {MAXIMUM_FRAME_SIZE} como máximo.",
    "Al menos {FRAME_OVERHEAD} bytes",
    "se completa con ceros hasta el largo pedido, de {MINIMUM_ECHO_SIZE} a {MAXIMUM_ECHO_SIZE} bytes",
    "Ceros hasta el largo pedido, de {MINIMUM_TEST_SIZE} a {MAXIMUM_TEST_SIZE} bytes",
    "| `size` | 1 | Tamaño del fragmento, de {MINIMUM_FRAGMENT_SIZE} a {MAXIMUM_FRAGMENT_SIZE} bytes |",
    "no alcanza para {MINIMUM_IMAGE_SIZE} bytes",
    "más allá de {MAXIMUM_IMAGE_SIZE} bytes",
    "de {MINIMUM_FRAGMENT_SIZE} a {MAXIMUM_FRAGMENT_SIZE} bytes |",
    "de 1 a {MAXIMUM_FRAGMENT_COUNT} |",
    "({DEFAULT_FRAGMENT_SIZE} bytes por defecto)",
    "`tag` contiene los primeros {FRAME_TAG_SIZE} bytes de HMAC-SHA256",
    "La tabla admite {MAXIMUM_TRACKED_SOURCES} orígenes",
    "El cuerpo ocupa {HELLO_FIXED_SIZE} bytes más {HELLO_NEIGHBOR_SIZE} por vecino.",
    "si su largo no es `{REPORT_FIXED_SIZE} + ⌈count / 8⌉`",
    "Cada nodo emite un HELLO cada {HELLO_PERIOD_MS/1000} s, con una variación aleatoria de ±{HELLO_JITTER_MS*100/HELLO_PERIOD_MS} %",
    "Un vecino sale de la tabla si pasan {NEIGHBOR_EXPIRY_MS/1000} s sin recibir ningún paquete suyo",
    "veces el tiempo de aire de un fragmento completo, más {TRANSFER_MARGIN_MS} ms. Si al llegar",
    "tiempo de aire del reporte más el de un fragmento completo, más {TRANSFER_MARGIN_MS} ms, el receptor repite",
  ],
  "docs/protocol/image.md": [
    "| `version` | 4 | Versión de la imagen, de {MINIMUM_IMAGE_VERSION} a {MAXIMUM_IMAGE_VERSION} |",
    "| `length` | 2 | Largo del programa en bytes, de {MINIMUM_PROGRAM_SIZE} a {MAXIMUM_PROGRAM_SIZE} |",
    "Los primeros {IMAGE_HEADER_SIZE} bytes forman la cabecera. Una imagen ocupa entre {MINIMUM_IMAGE_SIZE} y {MAXIMUM_IMAGE_SIZE} bytes.",
    "| `signature` | {IMAGE_SIGNATURE_SIZE} | Firma Ed25519 del operador |",
    "de un mensaje de {IMAGE_SIGNED_MESSAGE_SIZE} bytes",
    "el largo total es `{IMAGE_HEADER_SIZE} + length + {IMAGE_SIGNATURE_SIZE}`",
    "`length` va de {MINIMUM_PROGRAM_SIZE} a {MAXIMUM_PROGRAM_SIZE};",
    "registros de 1 a {REGISTER_COUNT}",
  ],
  "docs/protocol/virtual-machine.md": [
    "| R1 a R{REGISTER_COUNT} | Registros de 32 bits con signo",
    "| Memoria de programa | {PROGRAM_CAPACITY} bytes (`programCapacity`",
    "El nodo arranca un tick cada {VM_TICK_PERIOD_MS/1000} s",
    "en porciones de {VM_INSTRUCTIONS_PER_POLL} instrucciones por vuelta del bucle principal",
    "Un tick que ejecuta {VM_MAXIMUM_INSTRUCTIONS_PER_TICK:es} instrucciones termina con la falla `instruction_limit`.",
    "Los registros se codifican de 1 a {REGISTER_COUNT}",
  ],
  "docs/protocol/radio.md": [
    "| Frecuencia central | {DEFAULT_FREQUENCY_MHZ:es} MHz | `freq` |",
    "| Factor de dispersión | SF{DEFAULT_SPREADING_FACTOR} | `sf` |",
    "| Ancho de banda | {DEFAULT_BANDWIDTH_KHZ} kHz | `bw` |",
    "| Tasa de código | 4/{DEFAULT_CODING_RATE_DENOMINATOR} | `cr` (se indica el denominador: `{DEFAULT_CODING_RATE_DENOMINATOR}`) |",
    "| Preámbulo | {DEFAULT_PREAMBLE_LENGTH} símbolos | `preamble` |",
    "| Palabra de sincronismo | {radio.syncWord.default} (privada) | `sync` |",
    "| Potencia de transmisión | +{DEFAULT_TRANSMIT_POWER_DBM} dBm en el conector de antena | `power` |",
    "| `freq` | {MINIMUM_FREQUENCY_MHZ:es.1} a {MAXIMUM_FREQUENCY_MHZ:es.1} MHz |",
    "| `sf` | {MINIMUM_SPREADING_FACTOR} a {MAXIMUM_SPREADING_FACTOR} |",
    "| `bw` | {radio.bandwidthsKilohertz.0}, {radio.bandwidthsKilohertz.1} o {radio.bandwidthsKilohertz.2} kHz |",
    "| `cr` | {MINIMUM_CODING_RATE_DENOMINATOR} a {MAXIMUM_CODING_RATE_DENOMINATOR} (de 4/{MINIMUM_CODING_RATE_DENOMINATOR} a 4/{MAXIMUM_CODING_RATE_DENOMINATOR}) |",
    "| `preamble` | {MINIMUM_PREAMBLE_LENGTH} a {MAXIMUM_PREAMBLE_LENGTH} símbolos |",
    "| `sync` | {MINIMUM_SYNC_WORD} a {MAXIMUM_SYNC_WORD} |",
    `| \`power\` | V2: {${V2}.transmitPowerDbm.minimum} a {${V2}.transmitPowerDbm.maximum} o {${V2}.transmitPowerDbm.additionalValues.0} dBm. V4.3: {${V4_3}.transmitPowerDbm.minimum} a {${V4_3}.transmitPowerDbm.maximum} dBm |`,
    `A {${V2}.dutyCycleLimits.0.minimumAntennaDbm} dBm, la hoja de datos del {${V2}.transceiver} limita el ciclo de trabajo al {${V2}.dutyCycleLimits.0.maximumDutyCyclePercent} %.`,
    `| {${V4_3_GAIN(0)}.minimumAntennaDbm-${V4_3_GAIN(0)}.gainDb:es} a {${V4_3_GAIN(0)}.maximumAntennaDbm-${V4_3_GAIN(0)}.gainDb:es} dBm | {${V4_3_GAIN(0)}.gainDb} dB | {${V4_3_GAIN(0)}.minimumAntennaDbm} a {${V4_3_GAIN(0)}.maximumAntennaDbm} dBm |`,
    `| {${V4_3_GAIN(1)}.minimumAntennaDbm-${V4_3_GAIN(1)}.gainDb:es} dBm | {${V4_3_GAIN(1)}.gainDb} dB | {${V4_3_GAIN(1)}.minimumAntennaDbm} dBm |`,
    `| {${V4_3_GAIN(2)}.minimumAntennaDbm-${V4_3_GAIN(2)}.gainDb:es} dBm | {${V4_3_GAIN(2)}.gainDb} dB | {${V4_3_GAIN(2)}.minimumAntennaDbm} dBm |`,
    "En el aire solo se usan canales de {ON_AIR_BANDWIDTH_KHZ} kHz y hasta unos {ON_AIR_MAXIMUM_POWER_DBM} dBm",
  ],
  "docs/protocol/console.md": [
    "Serie USB a {CONSOLE_BAUD_RATE} baudios",
    "WebSocket en `{CONSOLE_WEBSOCKET_URL}`",
    "se corta en sus primeros {ERROR_COMMAND_WORD_LENGTH} caracteres",
    "La línea supera los {CONSOLE_LINE_CAPACITY} caracteres, o en `load_image` los {IMAGE_LINE_CAPACITY} de una imagen completa.",
    'lleva más de {MAXIMUM_IMAGE_SIZE} bytes responde `invalid_image` con `"format: longer than {MAXIMUM_IMAGE_SIZE} bytes"`',
    "de {MINIMUM_ECHO_SIZE} a {MAXIMUM_ECHO_SIZE}; por defecto, {DEFAULT_ECHO_SIZE}.",
    "paquetes TEST ({MINIMUM_RUN_COUNT} a {MAXIMUM_RUN_COUNT}) con un cuerpo de `largo` bytes ({MINIMUM_TEST_SIZE} a {MAXIMUM_TEST_SIZE}), separados por `intervalo` milisegundos ({MINIMUM_RUN_INTERVAL_MS} a {MAXIMUM_RUN_INTERVAL_MS})",
    "como máximo ({MINIMUM_PRESENCE_HOLD_S} a {MAXIMUM_PRESENCE_HOLD_S})",
    "de {MINIMUM_FRAGMENT_SIZE} a {MAXIMUM_FRAGMENT_SIZE} bytes, y emite `transfer`. Al arrancar vale {DEFAULT_FRAGMENT_SIZE}",
    "Las líneas tienen como máximo {CONSOLE_LINE_CAPACITY} caracteres, salvo `load_image`, que admite una imagen completa: {IMAGE_LINE_CAPACITY} caracteres con la imagen de {MAXIMUM_IMAGE_SIZE} bytes.",
    "El plazo es el doble del tiempo de aire de la trama, redondeado hacia arriba al milisegundo antes de duplicarlo, más {RESPONSE_MARGIN_MS} ms.",
    "El plazo es el doble de la suma del intervalo y el tiempo de aire de la trama, con el tiempo de aire redondeado hacia arriba al milisegundo, más {RESPONSE_MARGIN_MS} ms.",
    "| `presence on` | Reanuda los HELLO; el primero sale entre {FIRST_HELLO_MINIMUM_DELAY_MS/1000} y {FIRST_HELLO_MAXIMUM_DELAY_MS/1000} s después, como al arrancar |",
    "salvo que el operador los haya suspendido, y el primero sale entre {FIRST_HELLO_MINIMUM_DELAY_MS/1000} y {FIRST_HELLO_MAXIMUM_DELAY_MS/1000} s después, como al arrancar.",
  ],
  "docs/adrs/0004-only-500-khz-channels-on-air.md": [
    `por debajo del mínimo de las dos placas: +{${V2}.transmitPowerDbm.minimum} dBm la V2 y unos +{${V4_3}.transmitPowerDbm.minimum} dBm la V4.3. Por eso, con antena solo se usan canales de {ON_AIR_BANDWIDTH_KHZ} kHz`,
    "Van centrados entre {ON_AIR_MINIMUM_CENTER_MHZ:es} y {ON_AIR_MAXIMUM_CENTER_MHZ:es} MHz y admiten unos {ON_AIR_MAXIMUM_POWER_DBM} dBm como máximo",
  ],
  "docs/adrs/0005-frame-without-hop-count.md": [
    "El cuerpo admite hasta {MAXIMUM_PAYLOAD_SIZE} bytes ({MAXIMUM_FRAME_SIZE} − {FRAME_OVERHEAD}).",
  ],
  "docs/adrs/0007-operator-hello-hold-with-expiry.md": [
    "plazo, de {MINIMUM_PRESENCE_HOLD_S} a {MAXIMUM_PRESENCE_HOLD_S} s",
    "Si la prueba dura más de {NEIGHBOR_EXPIRY_MS/1000} s, los vecinos",
  ],
  "docs/adrs/0008-register-virtual-machine.md": [
    "una memoria de programa de {PROGRAM_CAPACITY} bytes, definida por `programCapacity`",
    "El programa activo corre un tick cada {VM_TICK_PERIOD_MS/1000} s",
    "en porciones de {VM_INSTRUCTIONS_PER_POLL} instrucciones por vuelta, intercaladas con la radio, y un tope de {VM_MAXIMUM_INSTRUCTIONS_PER_TICK:es} instrucciones por tick",
  ],
  "docs/adrs/0009-self-describing-fragments.md": [
    "Una imagen (cabecera, hasta {MAXIMUM_PROGRAM_SIZE} bytes de programa y la firma Ed25519 de {IMAGE_SIGNATURE_SIZE} bytes) ocupa alrededor de {MAXIMUM_IMAGE_SIZE/1000:es.1} KB",
    "el cuerpo de una trama admite {MAXIMUM_PAYLOAD_SIZE} bytes",
    "Cada fragmento empieza con una cabecera de {FRAGMENT_HEADER_SIZE} bytes",
    "Le siguen hasta {MAXIMUM_FRAGMENT_SIZE} bytes de la imagen.",
    "{DEFAULT_FRAGMENT_SIZE} bytes por defecto y {MINIMUM_FRAGMENT_SIZE} como mínimo",
    "llega a {MAXIMUM_FRAGMENT_COUNT} fragmentos y su mapa de bits, a {MAXIMUM_REPORT_BITMAP_SIZE} bytes",
  ],
  "docs/adrs/0010-receiver-driven-repair.md": [
    "sale de su tabla de vecinos, a los {NEIGHBOR_EXPIRY_MS/1000} s sin escucharlo",
  ],
  "docs/adrs/0012-image-format-and-operator-key.md": [
    "una cabecera de {IMAGE_HEADER_SIZE} bytes con el número mágico",
    "la firma Ed25519 de {IMAGE_SIGNATURE_SIZE} bytes. El número mágico",
  ],
};

// The constants of the contract by their names in the firmware header, with their values.
function contractValues(definitions) {
  return Object.fromEntries(
    definitions
      .filter((definition) => definition.kind === "constant")
      .map((definition) => [constantName(definition, "cpp"), definition.value]),
  );
}

// The value of a path of contract.json, such as boardModels.HeltecV2.transmitPowerDbm.minimum.
function contractPathValue(contract, path) {
  let value = contract;
  for (const segment of path.split(".")) {
    if (Array.isArray(value) && !/^\d+$/.test(segment)) {
      value = value.find((element) => element.identifier === segment);
    } else {
      value = value?.[segment];
    }
    ensure(value !== undefined, `a document mention names the unknown contract path ${path}`);
  }
  return value;
}

// A number as Argentine Spanish prose writes it, with the given decimals or as few as it needs.
function spanishNumber(value, decimals) {
  const text = decimals === undefined ? String(Math.abs(value)) : Math.abs(value).toFixed(decimals);
  const [integer, fraction] = text.split(".");
  const grouped = integer.length > 4 ? integer.replace(/\B(?=(\d{3})+$)/g, " ") : integer;
  return (value < 0 ? "−" : "") + grouped + (fraction === undefined ? "" : `,${fraction}`);
}

const MENTION_OPERATIONS = {
  "+": (left, right) => left + right,
  "-": (left, right) => left - right,
  "*": (left, right) => left * right,
  "/": (left, right) => left / right,
};

// The text of the expression between the braces of a mention.
function renderMentionValue(expression, values, contract) {
  const [arithmetic, format] = expression.split(":");
  const termValue = (term) => {
    if (/^\d+$/.test(term)) {
      return Number(term);
    }
    if (/^[A-Z][A-Z0-9_]*$/.test(term)) {
      ensure(term in values, `a document mention names the unknown constant ${term}`);
      return values[term];
    }
    return contractPathValue(contract, term);
  };
  const [first, ...rest] = arithmetic.split(/([+\-*/])/);
  let value = termValue(first);
  for (let index = 0; index < rest.length; index += 2) {
    const operand = termValue(rest[index + 1]);
    value = MENTION_OPERATIONS[rest[index]](value, operand);
  }
  if (format === undefined) {
    return String(value);
  }
  ensure(/^es(\.\d)?$/.test(format), `a document mention has the unknown format ${format}`);
  return spanishNumber(value, format === "es" ? undefined : Number(format.slice(3)));
}

// The mentions that a document no longer holds, as messages.
function checkDocumentMentions(contract, definitions, readDocument) {
  const values = contractValues(definitions);
  const problems = [];
  for (const [path, mentions] of Object.entries(DOCUMENT_MENTIONS)) {
    const text = readDocument(path) ?? "";
    for (const mention of mentions) {
      const phrase = mention.replace(/\{([^{}]+)\}/g, (_, expression) =>
        renderMentionValue(expression, values, contract),
      );
      if (!text.includes(phrase)) {
        problems.push(`${path} no longer says "${phrase}", from "${mention}"`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Entry points

// A .json file, or a .jsonl file as the list of the values of its lines.
function readJson(root, path) {
  const text = readFileSync(join(root, path), "utf8");
  if (path.endsWith(".jsonl")) {
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  }
  return JSON.parse(text);
}

/**
 * The contract, the test vectors and the signing key, read from the repository at root.
 * @param {string} [root]
 */
export function readProtocolInputs(root = REPOSITORY_ROOT) {
  const testVectors = Object.fromEntries(
    Object.entries(TEST_VECTOR_PATHS).map(([key, path]) => [key, readJson(root, path)]),
  );
  return {
    contract: readJson(root, CONTRACT_PATH),
    testVectors,
    // The development key of the operator, which signs the image vector and the images that the
    // host tests build.
    signingKey: readFileSync(join(root, testVectors.signedImage.signingKey), "utf8"),
    buildProfiles: listBuildProfiles(readFileSync(join(root, SKETCH_PROJECT_PATH), "utf8")),
  };
}

// Runs a formatter over text on its standard input and returns what it writes. remedy names the
// command that installs what the formatter needs when it is present but fails.
function runFormatter(command, argumentsList, directory, text, remedy) {
  const result = spawnSync(command, argumentsList, {
    cwd: directory,
    input: text,
    encoding: "utf8",
    // Plain error messages, without terminal colors.
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error !== undefined) {
    throw new ContractError(
      `${command} could not run (${result.error.message}); run mise install, which installs the ` +
        "tools that mise.toml pins",
    );
  }
  if (result.status !== 0) {
    throw new ContractError(
      `${command} could not format the generated text; ${remedy}\n${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

// The generated text goes through the formatters that check the sources, so the generator keeps no
// layout rules of its own: clang-format, which mise.toml pins, for the firmware, and the formatter
// of vp check for the panel. vp fmt runs in control/ and loads its vite.config.ts, so it needs the
// panel dependencies, and the formatter that runs is the vite-plus of control/node_modules, which
// control/pnpm-workspace.yaml pins.
function formatSource(path, content, root) {
  if (path.endsWith(".h")) {
    return runFormatter(
      "clang-format",
      [`--style=file:${join(root, ".clang-format")}`, `--assume-filename=${path}`],
      root,
      content,
      "check .clang-format and the version of clang-format that mise.toml pins",
    );
  }
  const panelDirectory = join(root, "control");
  const remedy = existsSync(join(panelDirectory, "node_modules"))
    ? "check the dependencies of the panel, which mise run setup:control installs"
    : "the dependencies of the panel are missing: run mise run setup:control";
  return runFormatter(
    "vp",
    ["fmt", `--stdin-filepath=${relative(panelDirectory, join(root, path))}`],
    panelDirectory,
    content,
    remedy,
  );
}

/**
 * The generated files, with paths relative to the repository root, formatted with the formatters
 * of the repository at root.
 * @param {ReturnType<typeof readProtocolInputs>} inputs
 * @param {string} [root]
 * @returns {{ path: string, content: string }[]}
 */
export function generateProtocolSources(inputs, root = REPOSITORY_ROOT) {
  const definitions = describeContract(inputs.contract);
  const boardProfiles = inputs.contract.boardModels.map((board) => board.buildProfile);
  ensure(
    boardProfiles.length === inputs.buildProfiles.length &&
      boardProfiles.every((profile) => inputs.buildProfiles.includes(profile)),
    `the buildProfile of the board models must be the profiles of ${SKETCH_PROJECT_PATH} ` +
      `(${inputs.buildProfiles.join(", ")})`,
  );
  return [
    { path: GENERATED_PATHS.firmwareHeader, content: generateFirmwareHeader(definitions) },
    { path: GENERATED_PATHS.panelModule, content: generatePanelModule(definitions) },
    {
      path: GENERATED_PATHS.testVectorHeader,
      content: generateTestVectorHeader(inputs.testVectors, inputs.contract, inputs.signingKey),
    },
  ].map((source) => ({ ...source, content: formatSource(source.path, source.content, root) }));
}

function readIfPresent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * For a test vector that a test of the control panel derives, such as the command lines of its
 * builders: with UPDATE_TEST_VECTORS=1 in the environment, first writes content to the file at
 * path, relative to root. Returns the text of the file, or null when it does not exist.
 * @param {string} path
 * @param {string} content
 * @param {string} [root]
 * @returns {string | null}
 */
export function synchronizeTestVector(path, content, root = REPOSITORY_ROOT) {
  const file = join(root, path);
  if (process.env.UPDATE_TEST_VECTORS === "1") {
    writeFileSync(file, content);
  }
  return readIfPresent(file);
}

/**
 * Paths of the generated files that are missing or differ from what the generator would write.
 * @param {string} [root]
 * @returns {string[]}
 */
export function findStaleProtocolSources(root = REPOSITORY_ROOT) {
  return generateProtocolSources(readProtocolInputs(root), root)
    .filter((source) => readIfPresent(join(root, source.path)) !== source.content)
    .map((source) => source.path);
}

/**
 * The mentions of contract values that the documents no longer hold, as messages: a document that
 * changes the phrase, or a contract change that leaves its number behind.
 * @param {string} [root]
 * @returns {string[]}
 */
export function findStaleDocumentMentions(root = REPOSITORY_ROOT) {
  const contract = readJson(root, CONTRACT_PATH);
  return checkDocumentMentions(contract, describeContract(contract), (path) =>
    readIfPresent(join(root, path)),
  );
}

/**
 * Writes every generated file and returns the paths that changed.
 * @param {string} [root]
 * @returns {string[]}
 */
export function writeProtocolSources(root = REPOSITORY_ROOT) {
  const changed = [];
  for (const source of generateProtocolSources(readProtocolInputs(root), root)) {
    const path = join(root, source.path);
    if (readIfPresent(path) !== source.content) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source.content);
      changed.push(source.path);
    }
  }
  return changed;
}

function main(argumentsList) {
  const check = argumentsList.includes("--check");
  const unknown = argumentsList.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    console.error(`usage: node ${GENERATOR_PATH} [--check]`);
    return 2;
  }
  try {
    if (check) {
      const stale = findStaleProtocolSources();
      for (const path of stale) {
        console.error(`${path} is stale: run node ${GENERATOR_PATH}`);
      }
      const mentions = findStaleDocumentMentions();
      for (const problem of mentions) {
        console.error(problem);
      }
      return stale.length > 0 || mentions.length > 0 ? 1 : 0;
    }
    for (const path of writeProtocolSources()) {
      console.log(`wrote ${path}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof ContractError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

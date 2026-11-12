/**
 * Builders for the console commands of docs/protocol/console.md. Each builder validates its
 * arguments with the ranges of the contract before producing the command line, so the operator
 * learns about a mistake before the node answers with an `error` event. The command table itself
 * is in $lib/console/console-command-table.ts.
 */
import { bareCommandLineOf, consoleCommandOf } from "$lib/console/console-command-table.ts";
import {
  lnaModeSchema,
  nodeIdentifierSchema,
  type BoardModel,
  type WifiState,
} from "$lib/console/console-event.ts";
import {
  BANDWIDTHS_KILOHERTZ,
  BROADCAST_IDENTIFIER,
  CODING_RATE_DENOMINATORS,
  CONSOLE_LINE_CAPACITY,
  FREQUENCY_DECIMALS,
  IMAGE_LINE_CAPACITY,
  LNA_MODES,
  LOW_NOISE_AMPLIFIER_BOARD_MODELS,
  MAXIMUM_CODING_RATE_DENOMINATOR,
  MAXIMUM_ECHO_SIZE,
  MAXIMUM_FRAGMENT_SIZE,
  MAXIMUM_FREQUENCY_MEGAHERTZ,
  MAXIMUM_IMAGE_SIZE,
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
  MINIMUM_IMAGE_SIZE,
  MINIMUM_IMAGE_VERSION,
  MINIMUM_PREAMBLE_LENGTH,
  MINIMUM_PRESENCE_HOLD_SECONDS,
  MINIMUM_REGISTER_VALUE,
  MINIMUM_RUN_COUNT,
  MINIMUM_RUN_INTERVAL_MILLISECONDS,
  MINIMUM_SPREADING_FACTOR,
  MINIMUM_SYNC_WORD,
  MINIMUM_TEST_SIZE,
  NO_NODE_IDENTIFIER,
  NODE_ID_HEXADECIMAL_DIGITS,
  RADIO_SETTING_KEYS,
  REGISTER_COUNT,
  SPREADING_FACTORS,
} from "$lib/protocol/protocol-contract.ts";
import {
  hasLowNoiseAmplifier,
  isTransmitPowerReachable,
  transmitPowerRangeOf,
  type RadioSettingChanges,
} from "$lib/radio/radio-settings.ts";
import { decodeImage, isImageVersion } from "$lib/image/image-format.ts";
import {
  formatCodingRate,
  formatConjunction,
  formatDisjunction,
  formatLimit,
} from "$lib/utils/format.ts";
import { formatHex } from "$lib/utils/hex.ts";
import { describeProgramFault } from "$lib/vm/fault-descriptions.ts";

export const HELP_COMMAND = bareCommandLineOf("listCommands");
export const STATUS_COMMAND = bareCommandLineOf("reportStatus");
export const RADIO_QUERY_COMMAND = bareCommandLineOf("reportRadio");
export const RADIO_RESET_COMMAND = bareCommandLineOf("resetRadio");
export const RUN_STOP_COMMAND = bareCommandLineOf("stopRun");
export const RESEND_COMMAND = bareCommandLineOf("resendLastFrame");
export const PRESENCE_ON_COMMAND = bareCommandLineOf("releasePresence");
/** Asks for the `transfer` event without changing the fragment size. */
export const FRAGMENT_SIZE_QUERY_COMMAND = bareCommandLineOf("changeFragmentSize");
/** Asks for the `program` event with the active program. */
export const PROGRAM_COMMAND = bareCommandLineOf("reportProgram");
/** The only command whose line may reach IMAGE_LINE_CAPACITY characters. */
export const LOAD_IMAGE_COMMAND = consoleCommandOf("loadImage").command.name;
export const ACTIVATE_COMMAND = consoleCommandOf("activateAvailableVersion").command.name;

export interface CommandProblem {
  /** Argument that has the problem, with the name it has in the command. */
  readonly field: string;
  /** Description for the operator, in Spanish. */
  readonly message: string;
}

export type CommandResult =
  | { readonly valid: true; readonly command: string }
  | { readonly valid: false; readonly problems: readonly CommandProblem[] };

function accept(command: string): CommandResult {
  if (command.length > CONSOLE_LINE_CAPACITY) {
    return reject([
      {
        field: "command",
        message: `El comando supera los ${CONSOLE_LINE_CAPACITY} caracteres que admite el nodo.`,
      },
    ]);
  }
  return { valid: true, command };
}

function reject(problems: readonly CommandProblem[]): CommandResult {
  return { valid: false, problems };
}

function isIntegerBetween(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

/**
 * Writes a frequency without trailing zeros and with at most FREQUENCY_DECIMALS decimals, as the
 * firmware reports it.
 */
export function formatFrequencyArgument(megahertz: number): string {
  return String(Number(megahertz.toFixed(FREQUENCY_DECIMALS)));
}

/** Checks each value of a `radio` command against the ranges of the board model, when known. */
export function validateRadioSettingChanges(
  changes: RadioSettingChanges,
  model: BoardModel | null,
): CommandProblem[] {
  const problems: CommandProblem[] = [];
  const { freq, sf, bw, cr, preamble, sync, power, lna } = changes;
  if (
    freq !== undefined &&
    !(
      Number.isFinite(freq) &&
      freq >= MINIMUM_FREQUENCY_MEGAHERTZ &&
      freq <= MAXIMUM_FREQUENCY_MEGAHERTZ
    )
  ) {
    problems.push({
      field: "freq",
      message: `La frecuencia va de ${formatLimit(MINIMUM_FREQUENCY_MEGAHERTZ, 1)} a ${formatLimit(MAXIMUM_FREQUENCY_MEGAHERTZ, 1)} MHz.`,
    });
  }
  if (sf !== undefined && !(SPREADING_FACTORS as readonly number[]).includes(sf)) {
    problems.push({
      field: "sf",
      message: `El factor de dispersión va de ${MINIMUM_SPREADING_FACTOR} a ${MAXIMUM_SPREADING_FACTOR}.`,
    });
  }
  if (bw !== undefined && !(BANDWIDTHS_KILOHERTZ as readonly number[]).includes(bw)) {
    problems.push({
      field: "bw",
      message: `El ancho de banda es de ${formatDisjunction(BANDWIDTHS_KILOHERTZ.map(String))} kHz.`,
    });
  }
  if (cr !== undefined && !(CODING_RATE_DENOMINATORS as readonly number[]).includes(cr)) {
    problems.push({
      field: "cr",
      message:
        `La tasa de código va de ${formatCodingRate(MINIMUM_CODING_RATE_DENOMINATOR)} a ${formatCodingRate(MAXIMUM_CODING_RATE_DENOMINATOR)} ` +
        `(denominador de ${MINIMUM_CODING_RATE_DENOMINATOR} a ${MAXIMUM_CODING_RATE_DENOMINATOR}).`,
    });
  }
  if (
    preamble !== undefined &&
    !isIntegerBetween(preamble, MINIMUM_PREAMBLE_LENGTH, MAXIMUM_PREAMBLE_LENGTH)
  ) {
    problems.push({
      field: "preamble",
      message: `El preámbulo va de ${formatLimit(MINIMUM_PREAMBLE_LENGTH)} a ${formatLimit(MAXIMUM_PREAMBLE_LENGTH)} símbolos.`,
    });
  }
  if (sync !== undefined && !isIntegerBetween(sync, MINIMUM_SYNC_WORD, MAXIMUM_SYNC_WORD)) {
    problems.push({
      field: "sync",
      message: `La palabra de sincronismo va de ${MINIMUM_SYNC_WORD} a ${MAXIMUM_SYNC_WORD}.`,
    });
  }
  if (power !== undefined && !isTransmitPowerReachable(model, power)) {
    problems.push({ field: "power", message: describeTransmitPowerProblem(model) });
  }
  if (lna !== undefined) {
    if (model !== null && !hasLowNoiseAmplifier(model)) {
      problems.push({
        field: "lna",
        message: `El LNA solo existe en la ${formatConjunction(LOW_NOISE_AMPLIFIER_BOARD_MODELS)}.`,
      });
    } else if (!lnaModeSchema.safeParse(lna).success) {
      problems.push({ field: "lna", message: `El LNA admite ${formatDisjunction(LNA_MODES)}.` });
    }
  }
  return problems;
}

function describeTransmitPowerProblem(model: BoardModel | null): string {
  const range = transmitPowerRangeOf(model);
  if (model === null) {
    return `La potencia va de ${range.minimum} a ${range.maximum} dBm según el modelo de placa.`;
  }
  const additional = range.additionalValues.map((power) => ` o ${power} dBm`).join("");
  return `La ${model} entrega de ${range.minimum} a ${range.maximum} dBm${additional} en el conector de antena.`;
}

/** `radio <key> <value> [<key> <value> ...]`: changes several settings at once. */
export function buildRadioSetCommand(
  changes: RadioSettingChanges,
  model: BoardModel | null,
): CommandResult {
  const keys = RADIO_SETTING_KEYS.filter((key) => changes[key] !== undefined);
  if (keys.length === 0) {
    return reject([{ field: "radio", message: "No hay ningún parámetro para cambiar." }]);
  }
  // Validate first: a form may hand over null or NaN for an empty field.
  const problems = validateRadioSettingChanges(changes, model);
  if (problems.length > 0) {
    return reject(problems);
  }
  const pairs = keys.map((key) => {
    const value = changes[key];
    return `${key} ${key === "freq" ? formatFrequencyArgument(value as number) : String(value)}`;
  });
  return accept(`radio ${pairs.join(" ")}`);
}

/** A node identifier as the operator types it, the way the console takes it: "3a7f " is "3A7F". */
export function normalizeNodeIdentifier(text: string): string {
  return text.trim().toUpperCase();
}

/** `echo <id> [size]`: asks node `destination` for an echo with a body of `size` bytes. */
export function buildEchoCommand(destination: string, size?: number): CommandResult {
  const problems: CommandProblem[] = [];
  const identifier = normalizeNodeIdentifier(destination);
  if (
    !nodeIdentifierSchema.safeParse(identifier).success ||
    identifier === NO_NODE_IDENTIFIER ||
    identifier === BROADCAST_IDENTIFIER
  ) {
    problems.push({
      field: "id",
      message: `El destino es un identificador de ${NODE_ID_HEXADECIMAL_DIGITS} dígitos hexadecimales, distinto de ${NO_NODE_IDENTIFIER} y ${BROADCAST_IDENTIFIER}.`,
    });
  }
  if (size !== undefined && !isIntegerBetween(size, MINIMUM_ECHO_SIZE, MAXIMUM_ECHO_SIZE)) {
    problems.push({
      field: "size",
      message: `El largo del eco va de ${MINIMUM_ECHO_SIZE} a ${MAXIMUM_ECHO_SIZE} bytes.`,
    });
  }
  if (problems.length > 0) {
    return reject(problems);
  }
  return accept(size === undefined ? `echo ${identifier}` : `echo ${identifier} ${size}`);
}

/** `run <count> <size> <interval>`: transmits a test run. */
export function buildRunCommand(count: number, size: number, interval: number): CommandResult {
  const problems: CommandProblem[] = [];
  if (!isIntegerBetween(count, MINIMUM_RUN_COUNT, MAXIMUM_RUN_COUNT)) {
    problems.push({
      field: "count",
      message: `La cantidad de paquetes va de ${formatLimit(MINIMUM_RUN_COUNT)} a ${formatLimit(MAXIMUM_RUN_COUNT)}.`,
    });
  }
  if (!isIntegerBetween(size, MINIMUM_TEST_SIZE, MAXIMUM_TEST_SIZE)) {
    problems.push({
      field: "size",
      message: `El largo del cuerpo va de ${MINIMUM_TEST_SIZE} a ${MAXIMUM_TEST_SIZE} bytes.`,
    });
  }
  if (
    !isIntegerBetween(
      interval,
      MINIMUM_RUN_INTERVAL_MILLISECONDS,
      MAXIMUM_RUN_INTERVAL_MILLISECONDS,
    )
  ) {
    problems.push({
      field: "interval",
      message: `El intervalo va de ${formatLimit(MINIMUM_RUN_INTERVAL_MILLISECONDS)} a ${formatLimit(MAXIMUM_RUN_INTERVAL_MILLISECONDS)} ms.`,
    });
  }
  if (problems.length > 0) {
    return reject(problems);
  }
  return accept(`run ${count} ${size} ${interval}`);
}

/** `presence off <seconds>`: holds the HELLO messages, at most for `seconds`. */
export function buildPresenceOffCommand(seconds: number): CommandResult {
  if (!isIntegerBetween(seconds, MINIMUM_PRESENCE_HOLD_SECONDS, MAXIMUM_PRESENCE_HOLD_SECONDS)) {
    return reject([
      {
        field: "seconds",
        message: `La suspensión de los HELLO va de ${formatLimit(MINIMUM_PRESENCE_HOLD_SECONDS)} a ${formatLimit(MAXIMUM_PRESENCE_HOLD_SECONDS)} s.`,
      },
    ]);
  }
  return accept(`presence off ${seconds}`);
}

/**
 * `load_registers <r1> ... <rN>`, one value per register (REGISTER_COUNT): the values go in
 * decimal; above 2³¹ − 1 the node keeps the bit pattern.
 */
export function buildLoadRegistersCommand(values: readonly number[]): CommandResult {
  const problems: CommandProblem[] = [];
  for (let index = 0; index < REGISTER_COUNT; ++index) {
    const value = values[index];
    if (
      value === undefined ||
      !isIntegerBetween(value, MINIMUM_REGISTER_VALUE, MAXIMUM_REGISTER_VALUE)
    ) {
      problems.push({
        field: `r${index + 1}`,
        message: `R${index + 1} es un entero de 32 bits: de ${formatLimit(MINIMUM_REGISTER_VALUE)} a ${formatLimit(MAXIMUM_REGISTER_VALUE)}.`,
      });
    }
  }
  if (problems.length > 0) {
    return reject(problems);
  }
  return accept(`load_registers ${values.slice(0, REGISTER_COUNT).join(" ")}`);
}

/**
 * `load_image <image>`: a signed image (docs/protocol/image.md) in hexadecimal, the only command
 * longer than CONSOLE_LINE_CAPACITY characters. The structure is checked here; the signature only
 * by the node.
 */
export function buildLoadImageCommand(image: Uint8Array): CommandResult {
  if (image.length < MINIMUM_IMAGE_SIZE || image.length > MAXIMUM_IMAGE_SIZE) {
    return reject([
      {
        field: "image",
        message: `La imagen ocupa de ${MINIMUM_IMAGE_SIZE} a ${MAXIMUM_IMAGE_SIZE} bytes.`,
      },
    ]);
  }
  const decoding = decodeImage(image);
  if (!decoding.valid) {
    return reject([
      {
        field: "image",
        message:
          decoding.reason === "format"
            ? decoding.message
            : `El programa no pasa la validación de la VM: ${describeProgramFault(decoding.fault, decoding.address)}.`,
      },
    ]);
  }
  const command = `${LOAD_IMAGE_COMMAND} ${formatHex(image)}`;
  if (command.length > IMAGE_LINE_CAPACITY) {
    return reject([
      {
        field: "command",
        message: `El comando supera los ${IMAGE_LINE_CAPACITY} caracteres que admite el nodo.`,
      },
    ]);
  }
  return { valid: true, command };
}

/** `activate <version>`: activates the available version, which has to be `version`. */
export function buildActivateCommand(version: number): CommandResult {
  if (!isImageVersion(version)) {
    return reject([
      {
        field: "version",
        message: `La versión va de ${formatLimit(MINIMUM_IMAGE_VERSION)} a ${formatLimit(MAXIMUM_IMAGE_VERSION)}.`,
      },
    ]);
  }
  return accept(`${ACTIVATE_COMMAND} ${version}`);
}

/**
 * `fragment_size [<bytes>]`: without `bytes`, asks for `transfer`; with it, sets the fragment size
 * of the next complete bursts.
 */
export function buildFragmentSizeCommand(bytes?: number): CommandResult {
  if (bytes === undefined) {
    return accept(FRAGMENT_SIZE_QUERY_COMMAND);
  }
  if (!isIntegerBetween(bytes, MINIMUM_FRAGMENT_SIZE, MAXIMUM_FRAGMENT_SIZE)) {
    return reject([
      {
        field: "bytes",
        message: `El tamaño del fragmento va de ${MINIMUM_FRAGMENT_SIZE} a ${MAXIMUM_FRAGMENT_SIZE} bytes.`,
      },
    ]);
  }
  return accept(`fragment_size ${bytes}`);
}

export function buildWifiCommand(state: WifiState): string {
  return `wifi ${state}`;
}

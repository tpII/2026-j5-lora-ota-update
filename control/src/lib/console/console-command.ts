/**
 * Builders for the console commands of docs/protocol/console.md. Each builder validates its
 * arguments with the ranges of the contract before producing the command line, so the operator
 * learns about a mistake before the node answers with an `error` event.
 */
import {
  BROADCAST_IDENTIFIER,
  lnaModeSchema,
  nodeIdentifierSchema,
  type BoardModel,
  type LnaMode,
  type WifiState,
} from "./console-event.ts";
import {
  BANDWIDTHS_KILOHERTZ,
  CODING_RATE_DENOMINATORS,
  MAXIMUM_FREQUENCY_MEGAHERTZ,
  MAXIMUM_PREAMBLE_LENGTH,
  MAXIMUM_SYNC_WORD,
  MINIMUM_FREQUENCY_MEGAHERTZ,
  MINIMUM_PREAMBLE_LENGTH,
  MINIMUM_SYNC_WORD,
  SPREADING_FACTORS,
  hasLowNoiseAmplifier,
  isTransmitPowerReachable,
  transmitPowerRangeOf,
} from "$lib/radio/radio-settings.ts";

/** The firmware rejects longer lines with `line_too_long`. */
export const MAXIMUM_COMMAND_LENGTH = 200;

export const MINIMUM_ECHO_SIZE = 4;
export const DEFAULT_ECHO_SIZE = 16;
export const MAXIMUM_PAYLOAD_SIZE = 239;
export const MINIMUM_TEST_SIZE = 8;
export const MINIMUM_RUN_COUNT = 1;
export const MAXIMUM_RUN_COUNT = 65535;
export const MINIMUM_RUN_INTERVAL = 0;
export const MAXIMUM_RUN_INTERVAL = 60000;

export const HELP_COMMAND = "help";
export const STATUS_COMMAND = "status";
export const RADIO_QUERY_COMMAND = "radio";
export const RADIO_RESET_COMMAND = "radio reset";
export const RUN_STOP_COMMAND = "run stop";
export const RESEND_COMMAND = "resend";

/** Keys of the `radio` command, in the order of docs/protocol/radio.md. */
export const RADIO_SETTING_KEYS = [
  "freq",
  "sf",
  "bw",
  "cr",
  "preamble",
  "sync",
  "power",
  "lna",
] as const;
export type RadioSettingKey = (typeof RADIO_SETTING_KEYS)[number];

/** Values to change with one `radio` command; absent keys keep their current value. */
export interface RadioSettingChanges {
  readonly freq?: number;
  readonly sf?: number;
  readonly bw?: number;
  readonly cr?: number;
  readonly preamble?: number;
  readonly sync?: number;
  readonly power?: number;
  readonly lna?: LnaMode;
}

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
  if (command.length > MAXIMUM_COMMAND_LENGTH) {
    return reject([
      {
        field: "command",
        message: `El comando supera los ${MAXIMUM_COMMAND_LENGTH} caracteres que admite el nodo.`,
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

/** Writes a frequency without trailing zeros and with at most three decimals, as the firmware reports it. */
export function formatFrequencyArgument(megahertz: number): string {
  return String(Number(megahertz.toFixed(3)));
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
    problems.push({ field: "freq", message: "La frecuencia va de 915,0 a 928,0 MHz." });
  }
  if (sf !== undefined && !(SPREADING_FACTORS as readonly number[]).includes(sf)) {
    problems.push({ field: "sf", message: "El factor de dispersión va de 7 a 12." });
  }
  if (bw !== undefined && !(BANDWIDTHS_KILOHERTZ as readonly number[]).includes(bw)) {
    problems.push({ field: "bw", message: "El ancho de banda es de 125, 250 o 500 kHz." });
  }
  if (cr !== undefined && !(CODING_RATE_DENOMINATORS as readonly number[]).includes(cr)) {
    problems.push({
      field: "cr",
      message: "La tasa de código va de 4/5 a 4/8 (denominador de 5 a 8).",
    });
  }
  if (
    preamble !== undefined &&
    !isIntegerBetween(preamble, MINIMUM_PREAMBLE_LENGTH, MAXIMUM_PREAMBLE_LENGTH)
  ) {
    problems.push({ field: "preamble", message: "El preámbulo va de 6 a 65535 símbolos." });
  }
  if (sync !== undefined && !isIntegerBetween(sync, MINIMUM_SYNC_WORD, MAXIMUM_SYNC_WORD)) {
    problems.push({ field: "sync", message: "La palabra de sincronismo va de 0 a 255." });
  }
  if (power !== undefined && !isTransmitPowerReachable(model, power)) {
    problems.push({ field: "power", message: describeTransmitPowerProblem(model) });
  }
  if (lna !== undefined) {
    if (model !== null && !hasLowNoiseAmplifier(model)) {
      problems.push({ field: "lna", message: "El LNA solo existe en la V4.3." });
    } else if (!lnaModeSchema.safeParse(lna).success) {
      problems.push({ field: "lna", message: "El LNA admite on o bypass." });
    }
  }
  return problems;
}

function describeTransmitPowerProblem(model: BoardModel | null): string {
  if (model === "V2") {
    return "La V2 entrega de 2 a 17 dBm o 20 dBm en el conector de antena.";
  }
  if (model === "V4.3") {
    return "La V4.3 entrega de 4 a 28 dBm en el conector de antena.";
  }
  const range = transmitPowerRangeOf(model);
  return `La potencia va de ${range.minimum} a ${range.maximum} dBm según el modelo de placa.`;
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

/** `echo <id> [size]`: asks node `destination` for an echo with a body of `size` bytes. */
export function buildEchoCommand(destination: string, size?: number): CommandResult {
  const problems: CommandProblem[] = [];
  const identifier = destination.trim().toUpperCase();
  if (
    !nodeIdentifierSchema.safeParse(identifier).success ||
    identifier === "0000" ||
    identifier === BROADCAST_IDENTIFIER
  ) {
    problems.push({
      field: "id",
      message:
        "El destino es un identificador de cuatro dígitos hexadecimales, distinto de 0000 y FFFF.",
    });
  }
  if (size !== undefined && !isIntegerBetween(size, MINIMUM_ECHO_SIZE, MAXIMUM_PAYLOAD_SIZE)) {
    problems.push({ field: "size", message: "El largo del eco va de 4 a 239 bytes." });
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
    problems.push({ field: "count", message: "La cantidad de paquetes va de 1 a 65535." });
  }
  if (!isIntegerBetween(size, MINIMUM_TEST_SIZE, MAXIMUM_PAYLOAD_SIZE)) {
    problems.push({ field: "size", message: "El largo del cuerpo va de 8 a 239 bytes." });
  }
  if (!isIntegerBetween(interval, MINIMUM_RUN_INTERVAL, MAXIMUM_RUN_INTERVAL)) {
    problems.push({ field: "interval", message: "El intervalo va de 0 a 60000 ms." });
  }
  if (problems.length > 0) {
    return reject(problems);
  }
  return accept(`run ${count} ${size} ${interval}`);
}

/** `wifi on` or `wifi off`. */
export function buildWifiCommand(state: WifiState): string {
  return `wifi ${state}`;
}

/** First word of a command line, as the firmware reports it in the `cmd` field of `error`. */
export function commandWordOf(commandLine: string): string {
  return commandLine.trim().split(/\s+/, 1)[0] ?? "";
}

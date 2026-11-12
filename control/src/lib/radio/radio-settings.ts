/**
 * Radio settings of a node (docs/protocol/radio.md): their type, the transmit power each board
 * model reaches and the rule that decides when two sets of settings match. The ranges and the
 * defaults are in the protocol contract.
 */
import type * as z from "zod/mini";
import {
  radioSettingsSchema,
  type BoardModel,
  type RadioEvent,
} from "$lib/console/console-event.ts";
import {
  ANY_MODEL_TRANSMIT_POWER_RANGE,
  BANDWIDTHS_KILOHERTZ,
  CODING_RATE_DENOMINATORS,
  FREQUENCY_DECIMALS,
  LOW_NOISE_AMPLIFIER_BOARD_MODELS,
  ON_AIR_BANDWIDTH_KILOHERTZ,
  RADIO_SETTING_KEYS,
  SPREADING_FACTORS,
  TRANSMIT_POWER_RANGES,
} from "$lib/protocol/protocol-contract.ts";

/** Radio settings of a node, with the field names of the `radio` event (docs/protocol/radio.md). */
export type RadioSettings = z.infer<typeof radioSettingsSchema>;

/** A key of the `radio` command, which is also a field of the `radio` event. */
export type RadioSettingKey = (typeof RADIO_SETTING_KEYS)[number];

/** Values to change with one `radio` command; absent keys keep their current value. */
export type RadioSettingChanges = {
  readonly [Key in RadioSettingKey]?: NonNullable<RadioSettings[Key]>;
};

/**
 * Spreading factor, bandwidth and coding rate: the part of the radio settings that two nodes must
 * share, together with the frequency, to hear each other.
 */
export type Modulation = Pick<RadioSettings, "sf" | "bw" | "cr">;

export type SpreadingFactor = (typeof SPREADING_FACTORS)[number];

export type BandwidthKilohertz = (typeof BANDWIDTHS_KILOHERTZ)[number];

export type CodingRateDenominator = (typeof CODING_RATE_DENOMINATORS)[number];

/** A modulation made only of values the radio accepts, as the select menus of a form offer them. */
export interface SupportedModulation extends Modulation {
  readonly sf: SpreadingFactor;
  readonly bw: BandwidthKilohertz;
  readonly cr: CodingRateDenominator;
}

/** The bandwidths that need a cable and attenuators instead of an antenna (ADR 0004). */
export const BENCH_BANDWIDTHS_KILOHERTZ: readonly BandwidthKilohertz[] =
  BANDWIDTHS_KILOHERTZ.filter((bandwidth) => bandwidth !== ON_AIR_BANDWIDTH_KILOHERTZ);

export interface TransmitPowerRange {
  readonly minimum: number;
  readonly maximum: number;
  /** Values accepted outside the continuous range, such as 20 dBm on the V2. */
  readonly additionalValues: readonly number[];
}

/** Transmit power at the antenna connector, in dBm, that each board model can deliver. */
const TRANSMIT_POWER_RANGE_BY_MODEL: { readonly [Model in BoardModel]: TransmitPowerRange } =
  TRANSMIT_POWER_RANGES;

/** The firmware reports the frequency rounded to FREQUENCY_DECIMALS decimals. */
const FREQUENCY_TOLERANCE_MEGAHERTZ = 0.5 * 10 ** -FREQUENCY_DECIMALS;

/** Settings carried by a `radio` event, without the header and any field the contract lacks. */
export function radioSettingsOf(event: RadioEvent): RadioSettings {
  return radioSettingsSchema.parse(event);
}

/** Power range of a board model; the hull of every model while the model is not known yet. */
export function transmitPowerRangeOf(model: BoardModel | null): TransmitPowerRange {
  return model === null ? ANY_MODEL_TRANSMIT_POWER_RANGE : TRANSMIT_POWER_RANGE_BY_MODEL[model];
}

export function isTransmitPowerReachable(model: BoardModel | null, power: number): boolean {
  const range = transmitPowerRangeOf(model);
  return (
    Number.isInteger(power) &&
    ((power >= range.minimum && power <= range.maximum) || range.additionalValues.includes(power))
  );
}

/** Every power the model accepts, in ascending order. */
export function listTransmitPowerValues(model: BoardModel | null): number[] {
  const range = transmitPowerRangeOf(model);
  const values: number[] = [];
  for (let power = range.minimum; power <= range.maximum; power += 1) {
    values.push(power);
  }
  return [...values, ...range.additionalValues];
}

export function hasLowNoiseAmplifier(model: BoardModel | null): boolean {
  return model !== null && (LOW_NOISE_AMPLIFIER_BOARD_MODELS as readonly string[]).includes(model);
}

export function isSpreadingFactor(value: number): value is SpreadingFactor {
  return (SPREADING_FACTORS as readonly number[]).includes(value);
}

export function isBandwidth(value: number): value is BandwidthKilohertz {
  return (BANDWIDTHS_KILOHERTZ as readonly number[]).includes(value);
}

export function isCodingRateDenominator(value: number): value is CodingRateDenominator {
  return (CODING_RATE_DENOMINATORS as readonly number[]).includes(value);
}

/** The modulation of `settings` when the radio accepts every value of it, or null. */
export function supportedModulationOf(settings: Modulation): SupportedModulation | null {
  const { sf, bw, cr } = settings;
  return isSpreadingFactor(sf) && isBandwidth(bw) && isCodingRateDenominator(cr)
    ? { sf, bw, cr }
    : null;
}

export function frequenciesMatch(first: number, second: number): boolean {
  return Math.abs(first - second) <= FREQUENCY_TOLERANCE_MEGAHERTZ;
}

export const MODULATION_FIELDS = ["sf", "bw", "cr"] as const satisfies readonly RadioSettingKey[];

/** Frequency and modulation: what a receiver needs to hear a transmitter (CONTEXT.md). */
export const FREQUENCY_AND_MODULATION_FIELDS = [
  "freq",
  ...MODULATION_FIELDS,
] as const satisfies readonly RadioSettingKey[];

/** Frequency, modulation, preamble and sync word: everything but the power and the LNA mode. */
export const CHANNEL_FIELDS = [
  ...FREQUENCY_AND_MODULATION_FIELDS,
  "preamble",
  "sync",
] as const satisfies readonly RadioSettingKey[];

export const ALL_RADIO_SETTING_FIELDS: readonly RadioSettingKey[] = RADIO_SETTING_KEYS;

/**
 * The ones of `fields` on which two sets of settings disagree, in the order of `fields`. The
 * frequency is compared with the precision the firmware reports it with; the other fields exactly.
 */
export function differingSettings<const Field extends RadioSettingKey>(
  first: Pick<RadioSettings, Field>,
  second: Pick<RadioSettings, Field>,
  fields: readonly Field[],
): Field[] {
  return fields.filter((field) => {
    const left: unknown = first[field];
    const right: unknown = second[field];
    return field === "freq" && typeof left === "number" && typeof right === "number"
      ? !frequenciesMatch(left, right)
      : left !== right;
  });
}

export function settingsMatch<const Field extends RadioSettingKey>(
  first: Pick<RadioSettings, Field>,
  second: Pick<RadioSettings, Field>,
  fields: readonly Field[],
): boolean {
  return differingSettings(first, second, fields).length === 0;
}

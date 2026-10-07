import type { BoardModel, LnaMode, RadioEvent } from "$lib/console/console-event.ts";
import { computeTimeOnAirMicroseconds, type TimeOnAirParameters } from "./time-on-air.ts";

/** Radio settings of a node, with the field names of the `radio` event (docs/protocol/radio.md). */
export type RadioSettings = Omit<RadioEvent, "t" | "ev">;

export const MINIMUM_FREQUENCY_MEGAHERTZ = 915.0;
export const MAXIMUM_FREQUENCY_MEGAHERTZ = 928.0;
export const SPREADING_FACTORS = [7, 8, 9, 10, 11, 12] as const;
export const BANDWIDTHS_KILOHERTZ = [125, 250, 500] as const;
export const CODING_RATE_DENOMINATORS = [5, 6, 7, 8] as const;
export const MINIMUM_PREAMBLE_LENGTH = 6;
export const MAXIMUM_PREAMBLE_LENGTH = 65535;
export const MINIMUM_SYNC_WORD = 0;
export const MAXIMUM_SYNC_WORD = 255;

export type BandwidthKilohertz = (typeof BANDWIDTHS_KILOHERTZ)[number];

/** Bandwidth allowed on the air with an antenna (ADR 0004); the others need attenuators or loads. */
export const ON_AIR_BANDWIDTH_KILOHERTZ: BandwidthKilohertz = 500;

/** Approximate highest power at the antenna connector allowed on 500 kHz channels (ADR 0004). */
export const ON_AIR_MAXIMUM_POWER_DBM = 26;

/** Centers of the 500 kHz channels that fit in the band (ADR 0004). */
export const ON_AIR_MINIMUM_CENTER_MEGAHERTZ = 915.25;
export const ON_AIR_MAXIMUM_CENTER_MEGAHERTZ = 927.75;

export interface TransmitPowerRange {
  readonly minimum: number;
  readonly maximum: number;
  /** Values accepted outside the continuous range, such as 20 dBm on the V2. */
  readonly additionalValues: readonly number[];
}

/** Transmit power at the antenna connector, in dBm, that each board model can deliver. */
export const TRANSMIT_POWER_RANGES: { readonly [Model in BoardModel]: TransmitPowerRange } = {
  V2: { minimum: 2, maximum: 17, additionalValues: [20] },
  "V4.3": { minimum: 4, maximum: 28, additionalValues: [] },
};

/** Power range used while the board model of a node is not yet known. */
export const ANY_MODEL_TRANSMIT_POWER_RANGE: TransmitPowerRange = {
  minimum: 2,
  maximum: 28,
  additionalValues: [],
};

/** Settings every node starts with (docs/protocol/radio.md). */
export const DEFAULT_RADIO_SETTINGS = {
  freq: 915.9,
  sf: 7,
  bw: 500,
  cr: 5,
  preamble: 8,
  sync: 0x12,
  power: 4,
  lna: "bypass",
} as const satisfies Omit<RadioSettings, "chip" | "lna"> & { lna: LnaMode };

/** The firmware reports the frequency with three decimals. */
export const FREQUENCY_TOLERANCE_MEGAHERTZ = 0.0005;

/** Settings carried by a `radio` event, without the header and any field the contract lacks. */
export function radioSettingsOf(event: RadioEvent): RadioSettings {
  return {
    freq: event.freq,
    sf: event.sf,
    bw: event.bw,
    cr: event.cr,
    preamble: event.preamble,
    sync: event.sync,
    power: event.power,
    chip: event.chip,
    lna: event.lna,
  };
}

export function transmitPowerRangeOf(model: BoardModel | null): TransmitPowerRange {
  return model === null ? ANY_MODEL_TRANSMIT_POWER_RANGE : TRANSMIT_POWER_RANGES[model];
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
  return model === "V4.3";
}

export function isBandwidth(value: number): value is BandwidthKilohertz {
  return (BANDWIDTHS_KILOHERTZ as readonly number[]).includes(value);
}

export function frequenciesMatch(first: number, second: number): boolean {
  return Math.abs(first - second) <= FREQUENCY_TOLERANCE_MEGAHERTZ;
}

/** Fields two nodes must share to hear each other: frequency, modulation, preamble and sync word. */
export type ChannelSettings = Pick<
  RadioSettings,
  "freq" | "sf" | "bw" | "cr" | "preamble" | "sync"
>;

export function channelsMatch(first: ChannelSettings, second: ChannelSettings): boolean {
  return (
    frequenciesMatch(first.freq, second.freq) &&
    first.sf === second.sf &&
    first.bw === second.bw &&
    first.cr === second.cr &&
    first.preamble === second.preamble &&
    first.sync === second.sync
  );
}

/** Same channel, transmit power and LNA mode. */
export function radioSettingsMatch(first: RadioSettings, second: RadioSettings): boolean {
  return channelsMatch(first, second) && first.power === second.power && first.lna === second.lna;
}

export function toTimeOnAirParameters(
  settings: Pick<RadioSettings, "sf" | "bw" | "cr" | "preamble">,
): TimeOnAirParameters {
  return {
    spreadingFactor: settings.sf,
    bandwidthKilohertz: settings.bw,
    codingRateDenominator: settings.cr,
    preambleLength: settings.preamble,
  };
}

/** Time on air of a frame of `frameLength` bytes with the given settings, in microseconds. */
export function timeOnAirFor(
  frameLength: number,
  settings: Pick<RadioSettings, "sf" | "bw" | "cr" | "preamble">,
): number {
  return computeTimeOnAirMicroseconds(frameLength, toTimeOnAirParameters(settings));
}

/** Coding rate as written in the documentation, for example "4/5". */
export function formatCodingRate(denominator: number): string {
  return `4/${denominator}`;
}

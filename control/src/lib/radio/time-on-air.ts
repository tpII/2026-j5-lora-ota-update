/**
 * LoRa time on air according to the Semtech formula (SX1276 and SX1262 datasheets), for the
 * settings used by the network: explicit header, CRC on and SF7 to SF12. Same computation as
 * firmware/src/radio/time_on_air.cpp, which fills `toa_calc` in the `tx` event; both suites check
 * it against firmware/protocol/test-vectors/time-on-air.json.
 */
import { FRAME_OVERHEAD } from "$lib/protocol/protocol-contract.ts";
import type { RadioSettings } from "./radio-settings.ts";

/** Low data rate optimization is mandatory when a symbol lasts 16 ms or more. */
const LOW_DATA_RATE_SYMBOL_MICROSECONDS = 16_000;

const CRC_ENABLED = 1;
const IMPLICIT_HEADER = 0;

export type TimeOnAirSettings = Pick<RadioSettings, "sf" | "bw" | "cr" | "preamble">;

/** Length of the whole frame, header and tag included, for a payload of `payloadSize` bytes. */
export function computeFrameLength(payloadSize: number): number {
  return FRAME_OVERHEAD + payloadSize;
}

/** Duration of one symbol in microseconds. */
export function computeSymbolDurationMicroseconds(
  spreadingFactor: number,
  bandwidthKilohertz: number,
): number {
  return (2 ** spreadingFactor * 1000) / bandwidthKilohertz;
}

/**
 * True when the low data rate optimization (DE) applies: SF11 and SF12 at 125 kHz, SF12 at
 * 250 kHz.
 */
export function requiresLowDataRateOptimization(
  spreadingFactor: number,
  bandwidthKilohertz: number,
): boolean {
  return (
    computeSymbolDurationMicroseconds(spreadingFactor, bandwidthKilohertz) >=
    LOW_DATA_RATE_SYMBOL_MICROSECONDS
  );
}

/** Number of payload symbols, including the 8 symbols of the header block. */
export function computePayloadSymbolCount(
  frameLength: number,
  settings: TimeOnAirSettings,
): number {
  const { sf, bw, cr } = settings;
  const lowDataRate = requiresLowDataRateOptimization(sf, bw) ? 1 : 0;
  const codingRate = cr - 4;
  const numerator = 8 * frameLength - 4 * sf + 28 + 16 * CRC_ENABLED - 20 * IMPLICIT_HEADER;
  const denominator = 4 * (sf - 2 * lowDataRate);
  return 8 + Math.max(Math.ceil(numerator / denominator) * (codingRate + 4), 0);
}

/** Time on air of a frame of `frameLength` bytes (header, payload and tag), in microseconds. */
export function computeTimeOnAirMicroseconds(
  frameLength: number,
  settings: TimeOnAirSettings,
): number {
  const symbolDuration = computeSymbolDurationMicroseconds(settings.sf, settings.bw);
  const preambleDuration = (settings.preamble + 4.25) * symbolDuration;
  return preambleDuration + computePayloadSymbolCount(frameLength, settings) * symbolDuration;
}

/** Time on air of a frame that carries a payload of `payloadSize` bytes, in microseconds. */
export function timeOnAirOfPayload(payloadSize: number, settings: TimeOnAirSettings): number {
  return computeTimeOnAirMicroseconds(computeFrameLength(payloadSize), settings);
}

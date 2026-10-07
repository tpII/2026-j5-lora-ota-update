/**
 * LoRa time on air according to the Semtech formula (SX1276 and SX1262 datasheets), for the
 * settings used by the network: explicit header, CRC on and SF7 to SF12. Same computation as
 * firmware/src/radio/time_on_air.cpp, which fills `toa_calc` in the `tx` event.
 */

/** Bytes that every frame adds to its payload: 8 of header and 8 of tag (docs/protocol/frame.md). */
export const FRAME_OVERHEAD_BYTES = 16;

/** Low data rate optimization is mandatory when a symbol lasts 16 ms or more. */
const LOW_DATA_RATE_SYMBOL_MICROSECONDS = 16_000;

const CRC_ENABLED = 1;
const IMPLICIT_HEADER = 0;

export interface TimeOnAirParameters {
  readonly spreadingFactor: number;
  readonly bandwidthKilohertz: number;
  /** Coding rate denominator: 5 means 4/5. */
  readonly codingRateDenominator: number;
  /** Preamble length in symbols. */
  readonly preambleLength: number;
}

/** Length of the whole frame for a payload of `payloadSize` bytes. */
export function computeFrameLength(payloadSize: number): number {
  return FRAME_OVERHEAD_BYTES + payloadSize;
}

/** Duration of one symbol in microseconds. */
export function computeSymbolDurationMicroseconds(
  spreadingFactor: number,
  bandwidthKilohertz: number,
): number {
  return (2 ** spreadingFactor * 1000) / bandwidthKilohertz;
}

/** True when the low data rate optimization (DE) applies: SF11 and SF12 at 125 kHz, SF12 at 250 kHz. */
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
  parameters: TimeOnAirParameters,
): number {
  const { spreadingFactor, bandwidthKilohertz, codingRateDenominator } = parameters;
  const lowDataRate = requiresLowDataRateOptimization(spreadingFactor, bandwidthKilohertz) ? 1 : 0;
  const codingRate = codingRateDenominator - 4;
  const numerator =
    8 * frameLength - 4 * spreadingFactor + 28 + 16 * CRC_ENABLED - 20 * IMPLICIT_HEADER;
  const denominator = 4 * (spreadingFactor - 2 * lowDataRate);
  return 8 + Math.max(Math.ceil(numerator / denominator) * (codingRate + 4), 0);
}

/** Time on air of a frame of `frameLength` bytes (header, payload and tag), in microseconds. */
export function computeTimeOnAirMicroseconds(
  frameLength: number,
  parameters: TimeOnAirParameters,
): number {
  const symbolDuration = computeSymbolDurationMicroseconds(
    parameters.spreadingFactor,
    parameters.bandwidthKilohertz,
  );
  const preambleDuration = (parameters.preambleLength + 4.25) * symbolDuration;
  return preambleDuration + computePayloadSymbolCount(frameLength, parameters) * symbolDuration;
}

import { describe, expect, it } from "vite-plus/test";
import {
  computeFrameLength,
  computePayloadSymbolCount,
  computeTimeOnAirMicroseconds,
  requiresLowDataRateOptimization,
  type TimeOnAirParameters,
} from "./time-on-air.ts";

function parametersAt(
  spreadingFactor: number,
  bandwidthKilohertz = 125,
  codingRateDenominator = 5,
  preambleLength = 8,
): TimeOnAirParameters {
  return { spreadingFactor, bandwidthKilohertz, codingRateDenominator, preambleLength };
}

function inMilliseconds(microseconds: number): number {
  return Math.round(microseconds / 100) / 10;
}

describe("computeTimeOnAirMicroseconds", () => {
  it("matches the reference values at 125 kHz, CR 4/5 and an 8-symbol preamble", () => {
    expect(inMilliseconds(computeTimeOnAirMicroseconds(33, parametersAt(7)))).toBe(71.9);
    expect(inMilliseconds(computeTimeOnAirMicroseconds(33, parametersAt(9)))).toBe(246.8);
    expect(inMilliseconds(computeTimeOnAirMicroseconds(33, parametersAt(12)))).toBe(1810.4);
    expect(inMilliseconds(computeTimeOnAirMicroseconds(81, parametersAt(7)))).toBe(143.6);
    expect(inMilliseconds(computeTimeOnAirMicroseconds(255, parametersAt(7)))).toBe(399.6);
    expect(inMilliseconds(computeTimeOnAirMicroseconds(255, parametersAt(12)))).toBe(9019.4);
  });

  it("gives whole microseconds, as the toa_calc field of the firmware", () => {
    expect(computeTimeOnAirMicroseconds(33, parametersAt(7))).toBe(71_936);
    // Full TEST frame at the default modulation: SF7, 500 kHz, CR 4/5.
    expect(computeTimeOnAirMicroseconds(255, parametersAt(7, 500))).toBe(99_904);
    // 16-byte echo request at the default modulation.
    expect(computeTimeOnAirMicroseconds(32, parametersAt(7, 500))).toBe(17_984);
  });

  it("grows with the coding rate and the preamble", () => {
    const base = computeTimeOnAirMicroseconds(64, parametersAt(9, 500, 5));
    expect(computeTimeOnAirMicroseconds(64, parametersAt(9, 500, 8))).toBeGreaterThan(base);
    expect(computeTimeOnAirMicroseconds(64, parametersAt(9, 500, 5, 16))).toBeGreaterThan(base);
  });
});

describe("requiresLowDataRateOptimization", () => {
  it("applies when a symbol lasts 16 ms or more", () => {
    expect(requiresLowDataRateOptimization(10, 125)).toBe(false);
    expect(requiresLowDataRateOptimization(11, 125)).toBe(true);
    expect(requiresLowDataRateOptimization(12, 125)).toBe(true);
    expect(requiresLowDataRateOptimization(11, 250)).toBe(false);
    expect(requiresLowDataRateOptimization(12, 250)).toBe(true);
    expect(requiresLowDataRateOptimization(12, 500)).toBe(false);
  });
});

describe("computePayloadSymbolCount", () => {
  it("never goes below the 8 symbols of the header block", () => {
    expect(computePayloadSymbolCount(0, parametersAt(12))).toBe(8);
  });
});

describe("computeFrameLength", () => {
  it("adds the 16 bytes of header and tag", () => {
    expect(computeFrameLength(239)).toBe(255);
    expect(computeFrameLength(17)).toBe(33);
  });
});

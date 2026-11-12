import { describe, expect, it } from "vite-plus/test";
import timeOnAirVectors from "../../../../firmware/protocol/test-vectors/time-on-air.json";
import {
  computePayloadSymbolCount,
  computeTimeOnAirMicroseconds,
  requiresLowDataRateOptimization,
  timeOnAirOfPayload,
  type TimeOnAirSettings,
} from "./time-on-air.ts";

function settingsAt(sf: number, bw = 125, cr = 5, preamble = 8): TimeOnAirSettings {
  return { sf, bw, cr, preamble };
}

describe("computeTimeOnAirMicroseconds", () => {
  it.each(timeOnAirVectors.cases)(
    "matches the shared vector for a frame of $frameLength bytes at SF$spreadingFactor and $bandwidthKilohertz kHz",
    (vector) => {
      const settings = settingsAt(
        vector.spreadingFactor,
        vector.bandwidthKilohertz,
        vector.codingRateDenominator,
        vector.preambleLength,
      );
      const microseconds = computeTimeOnAirMicroseconds(vector.frameLength, settings);
      expect(microseconds).toBe(vector.expectedMicroseconds);
      // The reference value in milliseconds has one decimal.
      expect(microseconds / 1000).toBeCloseTo(vector.expectedMilliseconds, 1);
    },
  );

  it("grows with the coding rate and the preamble", () => {
    const base = computeTimeOnAirMicroseconds(64, settingsAt(9, 500, 5));
    expect(computeTimeOnAirMicroseconds(64, settingsAt(9, 500, 8))).toBeGreaterThan(base);
    expect(computeTimeOnAirMicroseconds(64, settingsAt(9, 500, 5, 16))).toBeGreaterThan(base);
  });
});

describe("timeOnAirOfPayload", () => {
  it("counts the header and the tag of the frame", () => {
    // A 239-byte payload fills the 255-byte frame of the vectors.
    const settings = settingsAt(12);
    const fullFrame = timeOnAirVectors.cases.find(
      (vector) => vector.frameLength === 255 && vector.spreadingFactor === 12,
    );
    expect(timeOnAirOfPayload(239, settings)).toBe(fullFrame?.expectedMicroseconds);
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
    expect(computePayloadSymbolCount(0, settingsAt(12))).toBe(8);
  });
});

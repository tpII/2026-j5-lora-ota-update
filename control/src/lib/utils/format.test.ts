import { describe, expect, it } from "vite-plus/test";
import {
  formatBitRate,
  formatDeliveryRatio,
  formatDuration,
  formatFrequency,
  formatImageVersion,
  formatLimit,
  formatModulation,
  formatNumber,
  formatPower,
  formatRssi,
  formatSnr,
  formatSyncWord,
  countWithNoun,
  formatCardinal,
  roundToDecimals,
  formatRange,
  formatSignedInteger,
} from "./format.ts";

describe("formatting of image versions", () => {
  it("writes the version without thousands separators and names the factory program", () => {
    expect(formatImageVersion(1762300800)).toBe("1762300800");
    expect(formatImageVersion(0)).toBe("0 (fábrica)");
    expect(formatImageVersion(null)).toBe("—");
  });
});

describe("formatting for the operator", () => {
  it("uses the decimal comma and the thousands dot of Argentina", () => {
    expect(formatNumber(231456)).toBe("231.456");
    expect(formatFrequency(915.9)).toBe("915,900 MHz");
    expect(formatRssi(-47.5)).toBe("-47,5 dBm");
    expect(formatSnr(9.75)).toBe("9,75 dB");
    expect(formatDeliveryRatio(0.9)).toBe("90,0 %");
    expect(formatBitRate(16903.5)).toBe("16,90 kbit/s");
    expect(formatBitRate(512)).toBe("512 bit/s");
  });

  it("shows a dash when there is no value", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatRssi(null)).toBe("—");
    expect(formatBitRate(null)).toBe("—");
  });

  it("writes durations in hours, minutes and seconds", () => {
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(750_000)).toBe("12 min 30 s");
    expect(formatDuration(3_900_000)).toBe("1 h 05 min");
  });

  it("writes modulation, sync word and power as the documentation does", () => {
    expect(formatModulation({ sf: 7, bw: 500, cr: 5 })).toBe("SF7 · 500 kHz · 4/5");
    expect(formatSyncWord(18)).toBe("18 (0x12)");
    expect(formatPower(4)).toBe("+4 dBm");
  });

  it("chooses the singular or the plural of a noun", () => {
    expect(countWithNoun(1, "cliente", "clientes")).toBe("1 cliente");
    expect(countWithNoun(2, "cliente", "clientes")).toBe("2 clientes");
  });
});

describe("formatting of limits", () => {
  it("groups thousands only from five digits on and writes the minus sign", () => {
    expect(formatLimit(3600)).toBe("3600");
    expect(formatLimit(65535)).toBe("65.535");
    expect(formatLimit(-2147483648)).toBe("−2.147.483.648");
    expect(formatLimit(915, 1)).toBe("915,0");
  });
});

describe("roundToDecimals", () => {
  it("rounds the stored value half away from zero, as the CSV files write it", () => {
    expect(roundToDecimals(-100.25, 1)).toBe(-100.3);
    expect(roundToDecimals(-7.125, 2)).toBe(-7.13);
    expect(roundToDecimals(7031.25, 1)).toBe(7031.3);
    // 1000007 / 20 is stored just below 50000.35.
    expect(roundToDecimals(1_000_007 / 20, 1)).toBe(50000.3);
    expect(roundToDecimals(null, 2)).toBeNull();
  });
});

describe("formatCardinal", () => {
  it("writes small counts in words", () => {
    expect(formatCardinal(3)).toBe("tres");
    expect(formatCardinal(4)).toBe("cuatro");
    expect(formatCardinal(12)).toBe("12");
  });
});

describe("formatSignedInteger", () => {
  it("rounds and writes the minus sign", () => {
    expect(formatSignedInteger(-87.4)).toBe("−87");
    expect(formatSignedInteger(3.6)).toBe("4");
  });
});

describe("formatRange", () => {
  it("joins the extremes with the format of the samples", () => {
    expect(formatRange({ minimum: -90, maximum: -71.5 }, formatRssi)).toBe("-90,0 dBm a -71,5 dBm");
  });

  it("writes a dash without samples", () => {
    expect(formatRange({ minimum: null, maximum: null }, formatRssi)).toBe("—");
  });
});

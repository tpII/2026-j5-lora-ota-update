import { describe, expect, it } from "vite-plus/test";
import {
  formatBitRate,
  formatDeliveryRatio,
  formatDuration,
  formatFrequency,
  formatModulation,
  formatNumber,
  formatPower,
  formatRssi,
  formatSnr,
  formatSyncWord,
} from "./format.ts";
import { countWithNoun, describeErrorReason } from "./labels.ts";

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

  it("explains error reasons, including unknown ones", () => {
    expect(describeErrorReason("busy")).toBe("hay una corrida o un eco en curso");
    expect(describeErrorReason("wifi_failure")).toBe("no se pudo encender el punto de acceso");
    expect(describeErrorReason("thermal_limit")).toBe("motivo que este panel no conoce");
    expect(countWithNoun(1, "cliente", "clientes")).toBe("1 cliente");
    expect(countWithNoun(2, "cliente", "clientes")).toBe("2 clientes");
  });
});

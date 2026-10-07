import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CAPACITY_TEST_CONFIGURATION,
  buildCapacityTestPlan,
  estimatePointDurationMilliseconds,
  estimateTransmissionMilliseconds,
  pointTimeOnAirMicroseconds,
  validateCapacityTestConfiguration,
  type CapacityTestConfiguration,
} from "./capacity-test-plan.ts";

function configurationWith(changes: Partial<CapacityTestConfiguration>): CapacityTestConfiguration {
  return { ...DEFAULT_CAPACITY_TEST_CONFIGURATION, ...changes };
}

describe("buildCapacityTestPlan", () => {
  it("measures SF7 to SF12 at 500 kHz, CR 4/5, 239 bytes and 300 packets by default", () => {
    const plan = buildCapacityTestPlan(DEFAULT_CAPACITY_TEST_CONFIGURATION);
    expect(plan.map((point) => [point.sf, point.bw, point.cr, point.size, point.count])).toEqual([
      [7, 500, 5, 239, 300],
      [8, 500, 5, 239, 300],
      [9, 500, 5, 239, 300],
      [10, 500, 5, 239, 300],
      [11, 500, 5, 239, 300],
      [12, 500, 5, 239, 300],
    ]);
    expect(plan[0]).toEqual({
      index: 0,
      series: "modulation",
      freq: 915.9,
      sf: 7,
      bw: 500,
      cr: 5,
      preamble: 8,
      sync: 18,
      size: 239,
      count: 300,
    });
  });

  it("repeats the series for each bandwidth chosen", () => {
    const plan = buildCapacityTestPlan(
      configurationWith({ bandwidths: [125, 500], spreadingFactors: [7, 12] }),
    );
    expect(plan.map((point) => `${point.sf}/${point.bw}`)).toEqual([
      "7/125",
      "12/125",
      "7/500",
      "12/500",
    ]);
  });

  it("adds the payload sizes at two modulations without repeating a point", () => {
    const plan = buildCapacityTestPlan(
      configurationWith({
        payloadSweep: { ...DEFAULT_CAPACITY_TEST_CONFIGURATION.payloadSweep, enabled: true },
      }),
    );
    const sweep = plan.filter((point) => point.series === "payload_size");
    // 239 bytes at SF7 and SF12 already belong to the main series.
    expect(sweep.map((point) => `${point.sf}:${point.size}`)).toEqual([
      "7:16",
      "7:64",
      "7:128",
      "12:16",
      "12:64",
      "12:128",
    ]);
    expect(plan.map((point) => point.index)).toEqual(plan.map((_point, index) => index));
  });

  it("adds the coding rates at one modulation", () => {
    const plan = buildCapacityTestPlan(
      configurationWith({
        spreadingFactors: [12],
        codingRateSweep: {
          enabled: true,
          codingRates: [5, 6, 7, 8],
          modulation: { sf: 9, bw: 500, cr: 5 },
        },
      }),
    );
    expect(plan.map((point) => `${point.series}:${point.sf}:${point.cr}`)).toEqual([
      "modulation:12:5",
      "coding_rate:9:5",
      "coding_rate:9:6",
      "coding_rate:9:7",
      "coding_rate:9:8",
    ]);
  });
});

describe("validateCapacityTestConfiguration", () => {
  it("accepts the defaults", () => {
    expect(validateCapacityTestConfiguration(DEFAULT_CAPACITY_TEST_CONFIGURATION)).toEqual([]);
  });

  it("reports values out of the ranges of the console", () => {
    expect(
      validateCapacityTestConfiguration(
        configurationWith({ bandwidths: [], packetCount: 0, payloadSize: 240, freq: 930 }),
      ),
    ).toEqual([
      "Falta elegir al menos un ancho de banda.",
      "La frecuencia va de 915,0 a 928,0 MHz.",
      "La cantidad de paquetes va de 1 a 65535.",
      "El largo del cuerpo va de 8 a 239 bytes.",
    ]);
  });

  it("checks the sweeps only when they are enabled", () => {
    const sweep = { enabled: false, sizes: [4], modulations: [{ sf: 7, bw: 500, cr: 5 } as const] };
    expect(validateCapacityTestConfiguration(configurationWith({ payloadSweep: sweep }))).toEqual(
      [],
    );
    expect(
      validateCapacityTestConfiguration(
        configurationWith({ payloadSweep: { ...sweep, enabled: true } }),
      ),
    ).toEqual(["El largo del cuerpo va de 8 a 239 bytes."]);
  });
});

describe("estimates", () => {
  it("derive from the time on air of the full frame", () => {
    const [point] = buildCapacityTestPlan(DEFAULT_CAPACITY_TEST_CONFIGURATION);
    expect(pointTimeOnAirMicroseconds(point!)).toBe(99_904);
    expect(estimateTransmissionMilliseconds(point!)).toBeCloseTo(300 * (99.904 + 3));
    expect(estimatePointDurationMilliseconds(point!)).toBeCloseTo(300 * (99.904 + 3) + 1500);
  });
});

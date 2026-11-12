import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_RADIO_SETTINGS } from "$lib/protocol/protocol-contract.ts";
import { timeOnAirOfPayload } from "$lib/radio/time-on-air.ts";
import { estimateRunMilliseconds } from "./run-timing.ts";

describe("estimateRunMilliseconds", () => {
  it("times a run by its packets on air and the pauses between them", () => {
    const radio = DEFAULT_RADIO_SETTINGS;
    const timeOnAir = timeOnAirOfPayload(239, radio) / 1000;
    // A single packet takes its time on air alone.
    expect(estimateRunMilliseconds({ count: 1, size: 239, interval: 1000 }, radio)).toBeCloseTo(
      timeOnAir,
    );
    const backToBack = estimateRunMilliseconds({ count: 300, size: 239, interval: 0 }, radio);
    expect(backToBack).toBeGreaterThan(300 * timeOnAir);
    // Each of the 299 pauses between packets grows by the interval.
    expect(estimateRunMilliseconds({ count: 300, size: 239, interval: 100 }, radio)).toBeCloseTo(
      backToBack + 299 * 100,
    );
  });
});

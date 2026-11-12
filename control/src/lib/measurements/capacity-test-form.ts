/**
 * The form of a capacity test, as the operator fills it, and the configuration it stands for. The
 * select menus only offer values of the contract, so the form keeps them typed; only the list of
 * payload sizes is free text.
 */
import { BANDWIDTHS_KILOHERTZ, CODING_RATE_DENOMINATORS } from "$lib/protocol/protocol-contract.ts";
import type {
  BandwidthKilohertz,
  CodingRateDenominator,
  SpreadingFactor,
  SupportedModulation,
} from "$lib/radio/radio-settings.ts";
import type { CapacityTestConfiguration } from "./capacity-test-plan.ts";

export interface CapacityTestForm {
  freq: number;
  preamble: number;
  sync: number;
  /** Checked bandwidths, in the order the operator checked them. */
  bandwidths: BandwidthKilohertz[];
  firstSpreadingFactor: SpreadingFactor;
  lastSpreadingFactor: SpreadingFactor;
  codingRate: CodingRateDenominator;
  payloadSize: number;
  packetCount: number;
  payloadSweepEnabled: boolean;
  /** Payload sizes separated by commas, semicolons or spaces. */
  payloadSweepSizes: string;
  payloadSweepModulations: SupportedModulation[];
  codingRateSweepEnabled: boolean;
  /**
   * The coding rate sweep goes through every coding rate: only its spreading factor and bandwidth
   * count.
   */
  codingRateSweepModulation: SupportedModulation;
}

export function capacityTestFormOf(configuration: CapacityTestConfiguration): CapacityTestForm {
  return {
    freq: configuration.freq,
    preamble: configuration.preamble,
    sync: configuration.sync,
    bandwidths: [...configuration.bandwidths],
    firstSpreadingFactor: configuration.spreadingFactorRange.first,
    lastSpreadingFactor: configuration.spreadingFactorRange.last,
    codingRate: configuration.codingRate,
    payloadSize: configuration.payloadSize,
    packetCount: configuration.packetCount,
    payloadSweepEnabled: configuration.payloadSweep.enabled,
    payloadSweepSizes: configuration.payloadSweep.sizes.join(", "),
    payloadSweepModulations: configuration.payloadSweep.modulations.map((modulation) => ({
      ...modulation,
    })),
    codingRateSweepEnabled: configuration.codingRateSweep.enabled,
    codingRateSweepModulation: { ...configuration.codingRateSweep.modulation },
  };
}

/**
 * The sizes of a list such as "16, 64 128". A part that is not a number stays as NaN, which the
 * plan validator reports as a size out of range.
 */
export function parsePayloadSizes(text: string): number[] {
  return text
    .split(/[\s,;]+/)
    .filter((part) => part !== "")
    .map(Number);
}

/** The configuration the form stands for; validateCapacityTestConfiguration() checks it. */
export function capacityTestConfigurationOf(form: CapacityTestForm): CapacityTestConfiguration {
  return {
    freq: form.freq,
    preamble: form.preamble,
    sync: form.sync,
    bandwidths: BANDWIDTHS_KILOHERTZ.filter((bandwidth) => form.bandwidths.includes(bandwidth)),
    spreadingFactorRange: { first: form.firstSpreadingFactor, last: form.lastSpreadingFactor },
    codingRate: form.codingRate,
    payloadSize: form.payloadSize,
    packetCount: form.packetCount,
    payloadSweep: {
      enabled: form.payloadSweepEnabled,
      sizes: parsePayloadSizes(form.payloadSweepSizes),
      modulations: form.payloadSweepModulations.map((modulation) => ({ ...modulation })),
    },
    codingRateSweep: {
      enabled: form.codingRateSweepEnabled,
      codingRates: [...CODING_RATE_DENOMINATORS],
      modulation: { ...form.codingRateSweepModulation },
    },
  };
}

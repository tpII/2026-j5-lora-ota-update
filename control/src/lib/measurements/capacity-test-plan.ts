/**
 * Plan of a capacity test: the list of points (modulation and payload size) a campaign measures,
 * built from a configuration. Every point transmits its packets back to back (interval 0).
 */
import { buildRadioSetCommand, buildRunCommand } from "$lib/console/console-command.ts";
import {
  DEFAULT_RADIO_SETTINGS,
  ON_AIR_BANDWIDTH_KILOHERTZ,
  SPREADING_FACTORS,
  timeOnAirFor,
  type BandwidthKilohertz,
} from "$lib/radio/radio-settings.ts";
import { computeFrameLength } from "$lib/radio/time-on-air.ts";

export interface Modulation {
  readonly sf: number;
  readonly bw: BandwidthKilohertz;
  /** Coding rate denominator: 5 means 4/5. */
  readonly cr: number;
}

export interface CapacityTestConfiguration {
  /** Frequency, preamble and sync word sent to both nodes at every point. */
  readonly freq: number;
  readonly preamble: number;
  readonly sync: number;
  /** Main series: every spreading factor at every bandwidth, with one coding rate and size. */
  readonly bandwidths: readonly BandwidthKilohertz[];
  readonly spreadingFactors: readonly number[];
  readonly codingRate: number;
  readonly payloadSize: number;
  readonly packetCount: number;
  /** Optional series of payload sizes at two modulations. */
  readonly payloadSweep: {
    readonly enabled: boolean;
    readonly sizes: readonly number[];
    readonly modulations: readonly Modulation[];
  };
  /** Optional series of coding rates at one modulation. */
  readonly codingRateSweep: {
    readonly enabled: boolean;
    readonly codingRates: readonly number[];
    readonly modulation: Modulation;
  };
}

/** Defaults agreed for the first report: only 500 kHz, since 125 and 250 kHz need attenuators (ADR 0004). */
export const DEFAULT_CAPACITY_TEST_CONFIGURATION: CapacityTestConfiguration = {
  freq: DEFAULT_RADIO_SETTINGS.freq,
  preamble: DEFAULT_RADIO_SETTINGS.preamble,
  sync: DEFAULT_RADIO_SETTINGS.sync,
  bandwidths: [ON_AIR_BANDWIDTH_KILOHERTZ],
  spreadingFactors: [...SPREADING_FACTORS],
  codingRate: 5,
  payloadSize: 239,
  packetCount: 300,
  payloadSweep: {
    enabled: false,
    sizes: [16, 64, 128, 239],
    modulations: [
      { sf: 7, bw: 500, cr: 5 },
      { sf: 12, bw: 500, cr: 5 },
    ],
  },
  codingRateSweep: {
    enabled: false,
    codingRates: [5, 6, 7, 8],
    modulation: { sf: 7, bw: 500, cr: 5 },
  },
};

export type CapacityTestSeries = "modulation" | "payload_size" | "coding_rate";

export interface CapacityTestPoint {
  /** Position in the plan, from 0. */
  readonly index: number;
  readonly series: CapacityTestSeries;
  readonly freq: number;
  readonly sf: number;
  readonly bw: BandwidthKilohertz;
  readonly cr: number;
  readonly preamble: number;
  readonly sync: number;
  /** Payload size of each packet, in bytes. */
  readonly size: number;
  readonly count: number;
}

/** Interval between packets in a capacity test: back to back. */
export const CAPACITY_TEST_INTERVAL = 0;

/** Time between two packets of a run beyond their time on air, estimated. */
const PACKET_GAP_ESTIMATE_MILLISECONDS = 3;

/** Time to set the radio of both nodes and to close the run at the receiver, estimated. */
const POINT_OVERHEAD_ESTIMATE_MILLISECONDS = 1500;

/** Checks the configuration; returns the problems in Spanish, or an empty list. */
export function validateCapacityTestConfiguration(
  configuration: CapacityTestConfiguration,
): string[] {
  const problems: string[] = [];
  if (configuration.bandwidths.length === 0) {
    problems.push("Falta elegir al menos un ancho de banda.");
  }
  if (configuration.spreadingFactors.length === 0) {
    problems.push("Falta elegir al menos un factor de dispersión.");
  }
  const channel = buildRadioSetCommand(
    {
      freq: configuration.freq,
      preamble: configuration.preamble,
      sync: configuration.sync,
      cr: configuration.codingRate,
    },
    null,
  );
  if (!channel.valid) {
    problems.push(...channel.problems.map((problem) => problem.message));
  }
  for (const bandwidth of configuration.bandwidths) {
    for (const spreadingFactor of configuration.spreadingFactors) {
      const modulation = buildRadioSetCommand({ sf: spreadingFactor, bw: bandwidth }, null);
      if (!modulation.valid) {
        problems.push(...modulation.problems.map((problem) => problem.message));
      }
    }
  }
  const run = buildRunCommand(
    configuration.packetCount,
    configuration.payloadSize,
    CAPACITY_TEST_INTERVAL,
  );
  if (!run.valid) {
    problems.push(...run.problems.map((problem) => problem.message));
  }
  if (configuration.payloadSweep.enabled) {
    if (configuration.payloadSweep.sizes.length === 0) {
      problems.push("El barrido de largos necesita al menos un largo.");
    }
    for (const size of configuration.payloadSweep.sizes) {
      const sweepRun = buildRunCommand(configuration.packetCount, size, CAPACITY_TEST_INTERVAL);
      if (!sweepRun.valid) {
        problems.push(...sweepRun.problems.map((problem) => problem.message));
      }
    }
    for (const modulation of configuration.payloadSweep.modulations) {
      problems.push(...modulationProblems(modulation));
    }
  }
  if (configuration.codingRateSweep.enabled) {
    if (configuration.codingRateSweep.codingRates.length === 0) {
      problems.push("El barrido de tasas de código necesita al menos una tasa.");
    }
    for (const codingRate of configuration.codingRateSweep.codingRates) {
      problems.push(
        ...modulationProblems({ ...configuration.codingRateSweep.modulation, cr: codingRate }),
      );
    }
  }
  return [...new Set(problems)];
}

function modulationProblems(modulation: Modulation): string[] {
  const result = buildRadioSetCommand(modulation, null);
  return result.valid ? [] : result.problems.map((problem) => problem.message);
}

function pointKey(point: Omit<CapacityTestPoint, "index" | "series">): string {
  return [
    point.freq,
    point.sf,
    point.bw,
    point.cr,
    point.preamble,
    point.sync,
    point.size,
    point.count,
  ].join("/");
}

/**
 * Points of the campaign, in execution order: the main series by bandwidth and spreading factor,
 * then the payload sizes and then the coding rates. A point equal to an earlier one is measured once.
 */
export function buildCapacityTestPlan(
  configuration: CapacityTestConfiguration,
): CapacityTestPoint[] {
  const points: CapacityTestPoint[] = [];
  const seen = new Set<string>();
  const common = {
    freq: configuration.freq,
    preamble: configuration.preamble,
    sync: configuration.sync,
    count: configuration.packetCount,
  };
  const addPoint = (series: CapacityTestSeries, modulation: Modulation, size: number): void => {
    const candidate = { ...common, sf: modulation.sf, bw: modulation.bw, cr: modulation.cr, size };
    const key = pointKey(candidate);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    points.push({ ...candidate, index: points.length, series });
  };

  for (const bandwidth of configuration.bandwidths) {
    for (const spreadingFactor of configuration.spreadingFactors) {
      addPoint(
        "modulation",
        { sf: spreadingFactor, bw: bandwidth, cr: configuration.codingRate },
        configuration.payloadSize,
      );
    }
  }
  if (configuration.payloadSweep.enabled) {
    for (const modulation of configuration.payloadSweep.modulations) {
      for (const size of configuration.payloadSweep.sizes) {
        addPoint("payload_size", modulation, size);
      }
    }
  }
  if (configuration.codingRateSweep.enabled) {
    for (const codingRate of configuration.codingRateSweep.codingRates) {
      addPoint(
        "coding_rate",
        { ...configuration.codingRateSweep.modulation, cr: codingRate },
        configuration.payloadSize,
      );
    }
  }
  return points;
}

/** Time on air of one packet of the point, in microseconds. */
export function pointTimeOnAirMicroseconds(point: CapacityTestPoint): number {
  return timeOnAirFor(computeFrameLength(point.size), point);
}

/** Time the sender needs to transmit every packet of the point, estimated in milliseconds. */
export function estimateTransmissionMilliseconds(point: CapacityTestPoint): number {
  return (
    point.count * (pointTimeOnAirMicroseconds(point) / 1000 + PACKET_GAP_ESTIMATE_MILLISECONDS)
  );
}

/** Total time of the point, radio setup and run closure included, estimated in milliseconds. */
export function estimatePointDurationMilliseconds(point: CapacityTestPoint): number {
  return estimateTransmissionMilliseconds(point) + POINT_OVERHEAD_ESTIMATE_MILLISECONDS;
}

export function estimatePlanDurationMilliseconds(points: readonly CapacityTestPoint[]): number {
  return points.reduce((total, point) => total + estimatePointDurationMilliseconds(point), 0);
}

/**
 * How long a run takes the sender, estimated from its packets and the radio settings: for the
 * power sweep, which shows it before the operator starts a run, and for the capacity test, which
 * plans its points with it.
 */
import { timeOnAirOfPayload, type TimeOnAirSettings } from "$lib/radio/time-on-air.ts";

/**
 * Time the firmware of the sender takes between the end of one packet of a run and the start of
 * the next one, beyond the interval of the run: the main loop pass that queues the next packet
 * and the setup of the transceiver. An estimate of how the firmware behaves, not a value it
 * specifies.
 */
export const PACKET_GAP_ESTIMATE_MILLISECONDS = 3;

/**
 * What a run transmits: its packets, the payload size of each one and the interval between them.
 */
export interface RunShape {
  readonly count: number;
  readonly size: number;
  readonly interval: number;
}

/**
 * Time the sender needs to transmit every packet of a run with `radio`, estimated in milliseconds:
 * the time on air of each packet, and the interval and the packet gap between two of them.
 */
export function estimateRunMilliseconds(run: RunShape, radio: TimeOnAirSettings): number {
  const timeOnAir = timeOnAirOfPayload(run.size, radio) / 1000;
  const pause = run.interval + PACKET_GAP_ESTIMATE_MILLISECONDS;
  return run.count * timeOnAir + Math.max(0, run.count - 1) * pause;
}

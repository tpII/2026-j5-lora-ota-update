/**
 * Console events emitted by a node, as defined in docs/protocol/console.md (contract version 1).
 *
 * Every event carries `t` (milliseconds since the node booted) and `ev` (the event name). The
 * remaining fields keep the names used on the wire so that the contract can be checked by eye.
 */

/** Four uppercase hexadecimal digits, for example "3A7F". "FFFF" designates every node. */
export type NodeIdentifier = string;

export const BROADCAST_IDENTIFIER = "FFFF";

export const BOARD_MODELS = ["V2", "V4.3"] as const;
export type BoardModel = (typeof BOARD_MODELS)[number];

export const LNA_MODES = ["on", "bypass"] as const;
export type LnaMode = (typeof LNA_MODES)[number];

export const TRANSMISSION_TYPES = ["hello", "echo_request", "echo_reply", "test"] as const;
export type TransmissionType = (typeof TRANSMISSION_TYPES)[number];

export const DROP_REASONS = ["crc", "short", "tag", "type", "body"] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export const RUN_END_REASONS = ["complete", "timeout"] as const;
export type RunEndReason = (typeof RUN_END_REASONS)[number];

export const KEY_KINDS = ["default", "custom"] as const;
export type KeyKind = (typeof KEY_KINDS)[number];

export const WIFI_STATES = ["on", "off"] as const;
export type WifiState = (typeof WIFI_STATES)[number];

export const KNOWN_ERROR_REASONS = [
  "unknown_command",
  "usage",
  "out_of_range",
  "unreachable_power",
  "not_supported",
  "busy",
  "radio_failure",
  "wifi_failure",
  "line_too_long",
] as const;
export type KnownErrorReason = (typeof KNOWN_ERROR_REASONS)[number];

/**
 * Reason of an `error` event. The panel accepts reasons that a newer firmware may add, so any
 * string is valid; the known ones keep their literal types for completion and narrowing.
 */
export type ErrorReason = KnownErrorReason | (string & Record<never, never>);

interface EventHeader {
  /** Milliseconds since the node booted. */
  t: number;
}

export interface BootEvent extends EventHeader {
  ev: "boot";
  id: NodeIdentifier;
  model: BoardModel;
  epoch: number;
  firmware: string;
  protocol: number;
  key: KeyKind;
}

export interface RadioEvent extends EventHeader {
  ev: "radio";
  /** Center frequency in MHz. */
  freq: number;
  sf: number;
  /** Bandwidth in kHz. */
  bw: number;
  /** Coding rate denominator: 5 means 4/5. */
  cr: number;
  preamble: number;
  sync: number;
  /** Transmit power at the antenna connector, in dBm. */
  power: number;
  /** Transceiver setting that produces that power, in dBm. */
  chip: number;
  /** LNA mode on the V4.3; null on the V2. */
  lna: LnaMode | null;
}

export interface WifiEvent extends EventHeader {
  ev: "wifi";
  state: WifiState;
  ssid: string;
  channel: number;
  clients: number;
}

export interface StatusEvent extends EventHeader {
  ev: "status";
  id: NodeIdentifier;
  model: BoardModel;
  epoch: number;
  tx: number;
  rx: number;
  dropped: number;
  heap: number;
}

export interface NeighborEvent extends EventHeader {
  ev: "neighbor";
  id: NodeIdentifier;
  model: BoardModel;
  version: number;
  tx: number;
  rssi: number;
  snr: number;
  /** Milliseconds since the last packet received from the neighbor. */
  age: number;
}

export interface TransmissionEvent extends EventHeader {
  ev: "tx";
  type: TransmissionType;
  dst: NodeIdentifier;
  seq: number;
  /** Length of the whole frame in bytes. */
  size: number;
  /** Measured time on air in microseconds. */
  toa: number;
  /** Time on air according to the Semtech formula, in microseconds. */
  toa_calc: number;
  /** Only in "test" transmissions. */
  run?: number;
  /** Only in "test" transmissions. */
  index?: number;
}

export interface HelloNeighborReport {
  id: NodeIdentifier;
  rssi: number;
  snr: number;
}

export interface HelloEvent extends EventHeader {
  ev: "hello";
  src: NodeIdentifier;
  epoch: number;
  seq: number;
  model: BoardModel;
  version: number;
  tx: number;
  rssi: number;
  snr: number;
  ferr: number;
  /** How the sender hears each of its own neighbors. */
  neighbors: HelloNeighborReport[];
}

export interface EchoServedEvent extends EventHeader {
  ev: "echo_served";
  src: NodeIdentifier;
  n: number;
  size: number;
  rssi: number;
  snr: number;
}

export interface EchoEvent extends EventHeader {
  ev: "echo";
  dst: NodeIdentifier;
  n: number;
  size: number;
  /** Round-trip time in microseconds. */
  rtt: number;
  rssi: number;
  snr: number;
  remote_rssi: number;
  remote_snr: number;
}

export interface EchoLostEvent extends EventHeader {
  ev: "echo_lost";
  dst: NodeIdentifier;
  n: number;
  size: number;
  /** Deadline in milliseconds. */
  timeout: number;
}

export interface RunStartEvent extends EventHeader {
  ev: "run_start";
  run: number;
  count: number;
  size: number;
  interval: number;
}

export interface RunDoneEvent extends EventHeader {
  ev: "run_done";
  run: number;
  count: number;
  sent: number;
  /** Microseconds from the start of the first packet to the end of the last one. */
  duration: number;
  aborted: boolean;
}

export interface TestReceptionEvent extends EventHeader {
  ev: "test_rx";
  src: NodeIdentifier;
  run: number;
  index: number;
  count: number;
  size: number;
  rssi: number;
  snr: number;
  ferr: number;
}

export interface RunEndEvent extends EventHeader {
  ev: "run_end";
  src: NodeIdentifier;
  run: number;
  count: number;
  received: number;
  pdr: number;
  /**
   * The quality fields are null when no packet was received. The contract does not say so, but
   * the firmware writes null in that case instead of leaving the fields out.
   */
  rssi_avg: number | null;
  rssi_min: number | null;
  rssi_max: number | null;
  snr_avg: number | null;
  first: number;
  last: number;
  reason: RunEndReason;
}

export interface DuplicateEvent extends EventHeader {
  ev: "duplicate";
  src: NodeIdentifier;
  epoch: number;
  seq: number;
  type: TransmissionType;
}

export interface DropEvent extends EventHeader {
  ev: "drop";
  reason: DropReason;
  size: number;
  rssi: number;
  snr: number;
}

export interface IdentifierConflictEvent extends EventHeader {
  ev: "id_conflict";
  epoch: number;
  seq: number;
  rssi: number;
  snr: number;
}

export interface ErrorEvent extends EventHeader {
  ev: "error";
  /** First word of the command, or "radio" for a radio failure. */
  cmd: string;
  reason: ErrorReason;
  detail?: string;
  /** RadioLib error code. */
  code?: number;
}

export type ConsoleEvent =
  | BootEvent
  | RadioEvent
  | WifiEvent
  | StatusEvent
  | NeighborEvent
  | TransmissionEvent
  | HelloEvent
  | EchoServedEvent
  | EchoEvent
  | EchoLostEvent
  | RunStartEvent
  | RunDoneEvent
  | TestReceptionEvent
  | RunEndEvent
  | DuplicateEvent
  | DropEvent
  | IdentifierConflictEvent
  | ErrorEvent;

export type ConsoleEventName = ConsoleEvent["ev"];

export type ConsoleEventOf<Name extends ConsoleEventName> = Extract<ConsoleEvent, { ev: Name }>;

/** Event names in the order of docs/protocol/console.md. */
export const CONSOLE_EVENT_NAMES = [
  "boot",
  "radio",
  "wifi",
  "status",
  "neighbor",
  "tx",
  "hello",
  "echo_served",
  "echo",
  "echo_lost",
  "run_start",
  "run_done",
  "test_rx",
  "run_end",
  "duplicate",
  "drop",
  "id_conflict",
  "error",
] as const satisfies readonly ConsoleEventName[];

const NODE_IDENTIFIER_PATTERN = /^[0-9A-F]{4}$/;

export function isNodeIdentifier(value: unknown): value is NodeIdentifier {
  return typeof value === "string" && NODE_IDENTIFIER_PATTERN.test(value);
}

export function isBoardModel(value: unknown): value is BoardModel {
  return value === "V2" || value === "V4.3";
}

export function isKnownErrorReason(value: string): value is KnownErrorReason {
  return (KNOWN_ERROR_REASONS as readonly string[]).includes(value);
}

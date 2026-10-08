/**
 * Console events emitted by a node, as defined in docs/protocol/console.md (contract version 1).
 *
 * Each event is described once, as a Zod schema, and its type is inferred from the schema. Every
 * event carries `t` (milliseconds since the node booted) and `ev` (the event name); the other
 * fields keep the names used on the wire so that the contract can be checked by eye. The message
 * of each field schema says what the field should contain, in Spanish, for the operator.
 */
import * as z from "zod/mini";

/** Four uppercase hexadecimal digits, for example "3A7F". "FFFF" designates every node. */
export type NodeIdentifier = string;

export const BROADCAST_IDENTIFIER = "FFFF";

/**
 * Any finite number. The firmware may write a whole value with or without decimals (-35 or -35.0),
 * so integer fields are not told apart from the others.
 */
const numberSchema = z.number({ error: "un número" });

/** A number that the firmware replaces with null when there is no value to report. */
const numberOrNullSchema = z.nullable(z.number({ error: "un número o null" }));

const textSchema = z.string({ error: "un texto" });

const booleanSchema = z.boolean({ error: "true o false" });

const NODE_IDENTIFIER_EXPECTATION = "un identificador de cuatro dígitos hexadecimales en mayúscula";

export const nodeIdentifierSchema = z
  .string({ error: NODE_IDENTIFIER_EXPECTATION })
  .check(z.regex(/^[0-9A-F]{4}$/, { error: NODE_IDENTIFIER_EXPECTATION }));

const valueList = new Intl.ListFormat("es-AR", { type: "disjunction" });

/** One of `values`; the message lists them as the contract writes them: "on" o "bypass". */
function oneOf<const Values extends readonly (string | null)[]>(values: Values) {
  const quoted = values.map((value) => (value === null ? "null" : `"${value}"`));
  return z.literal(values, { error: valueList.format(quoted) });
}

/**
 * A field the event may leave out. The firmware may also write null for it, which counts as
 * absent.
 */
function optional<Schema extends z.ZodMiniType>(schema: Schema) {
  return z.pipe(
    z.transform((value: unknown): unknown => value ?? undefined),
    z.optional(schema),
  );
}

const LNA_MODES = ["on", "bypass"] as const;

const boardModelSchema = oneOf(["V2", "V4.3"]);
export const lnaModeSchema = oneOf(LNA_MODES);
const wifiStateSchema = oneOf(["on", "off"]);
const keyKindSchema = oneOf(["default", "custom"]);
const transmissionTypeSchema = oneOf(["hello", "echo_request", "echo_reply", "test"]);
const dropReasonSchema = oneOf(["crc", "short", "tag", "type", "body"]);
const runEndReasonSchema = oneOf(["complete", "timeout"]);

export type BoardModel = z.infer<typeof boardModelSchema>;
export type LnaMode = z.infer<typeof lnaModeSchema>;
export type WifiState = z.infer<typeof wifiStateSchema>;
export type KeyKind = z.infer<typeof keyKindSchema>;
export type RunEndReason = z.infer<typeof runEndReasonSchema>;

/**
 * Reasons of the `error` event the contract lists. The event accepts any other reason, since a
 * newer firmware may add some.
 */
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

export function isKnownErrorReason(value: string): value is KnownErrorReason {
  return (KNOWN_ERROR_REASONS as readonly string[]).includes(value);
}

/** Radio settings as the `radio` event reports them (docs/protocol/radio.md). */
export const radioSettingsSchema = z.object({
  /** Center frequency in MHz. */
  freq: numberSchema,
  sf: numberSchema,
  /** Bandwidth in kHz. */
  bw: numberSchema,
  /** Coding rate denominator: 5 means 4/5. */
  cr: numberSchema,
  preamble: numberSchema,
  sync: numberSchema,
  /** Transmit power at the antenna connector, in dBm. */
  power: numberSchema,
  /** Transceiver setting that produces that power, in dBm. */
  chip: numberSchema,
  /** LNA mode on the V4.3; null on the V2. */
  lna: oneOf([...LNA_MODES, null]),
});

const helloNeighborReportSchema = z.object(
  { id: nodeIdentifierSchema, rssi: numberSchema, snr: numberSchema },
  { error: 'un objeto { "id", "rssi", "snr" }' },
);
export type HelloNeighborReport = z.infer<typeof helloNeighborReportSchema>;

const eventHeaderSchema = z.object({
  /** Milliseconds since the node booted. */
  t: numberSchema,
});

const bootEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("boot"),
  id: nodeIdentifierSchema,
  model: boardModelSchema,
  epoch: numberSchema,
  firmware: textSchema,
  protocol: numberSchema,
  key: keyKindSchema,
});

const radioEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("radio"),
  ...radioSettingsSchema.shape,
});

const wifiEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("wifi"),
  state: wifiStateSchema,
  ssid: textSchema,
  channel: numberSchema,
  clients: numberSchema,
});

const statusEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("status"),
  id: nodeIdentifierSchema,
  model: boardModelSchema,
  epoch: numberSchema,
  tx: numberSchema,
  rx: numberSchema,
  dropped: numberSchema,
  heap: numberSchema,
});

const neighborEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("neighbor"),
  id: nodeIdentifierSchema,
  model: boardModelSchema,
  version: numberSchema,
  tx: numberSchema,
  rssi: numberSchema,
  snr: numberSchema,
  /** Milliseconds since the last packet received from the neighbor. */
  age: numberSchema,
});

const transmissionEventSchema = z
  .extend(eventHeaderSchema, {
    ev: z.literal("tx"),
    type: transmissionTypeSchema,
    dst: nodeIdentifierSchema,
    seq: numberSchema,
    /** Length of the whole frame in bytes. */
    size: numberSchema,
    /** Measured time on air in microseconds. */
    toa: numberSchema,
    /** Time on air according to the Semtech formula, in microseconds. */
    toa_calc: numberSchema,
    /** Only in "test" transmissions. */
    run: optional(numberSchema),
    /** Only in "test" transmissions. */
    index: optional(numberSchema),
  })
  .check(
    z.refine(
      (event) => event.type !== "test" || (event.run !== undefined && event.index !== undefined),
      { error: "una transmisión de tipo test debe incluir run e index" },
    ),
  );

const helloEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("hello"),
  src: nodeIdentifierSchema,
  epoch: numberSchema,
  seq: numberSchema,
  model: boardModelSchema,
  version: numberSchema,
  tx: numberSchema,
  rssi: numberSchema,
  snr: numberSchema,
  ferr: numberSchema,
  /** How the sender hears each of its own neighbors. */
  neighbors: z.array(helloNeighborReportSchema, {
    error: 'una lista de objetos { "id", "rssi", "snr" }',
  }),
});

const echoServedEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("echo_served"),
  src: nodeIdentifierSchema,
  n: numberSchema,
  size: numberSchema,
  rssi: numberSchema,
  snr: numberSchema,
});

const echoEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("echo"),
  dst: nodeIdentifierSchema,
  n: numberSchema,
  size: numberSchema,
  /** Round-trip time in microseconds. */
  rtt: numberSchema,
  rssi: numberSchema,
  snr: numberSchema,
  remote_rssi: numberSchema,
  remote_snr: numberSchema,
});

const echoLostEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("echo_lost"),
  dst: nodeIdentifierSchema,
  n: numberSchema,
  size: numberSchema,
  /** Deadline in milliseconds. */
  timeout: numberSchema,
});

const runStartEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("run_start"),
  run: numberSchema,
  count: numberSchema,
  size: numberSchema,
  interval: numberSchema,
});

const runDoneEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("run_done"),
  run: numberSchema,
  count: numberSchema,
  sent: numberSchema,
  /** Microseconds from the start of the first packet to the end of the last one. */
  duration: numberSchema,
  aborted: booleanSchema,
});

const testReceptionEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("test_rx"),
  src: nodeIdentifierSchema,
  run: numberSchema,
  index: numberSchema,
  count: numberSchema,
  size: numberSchema,
  rssi: numberSchema,
  snr: numberSchema,
  ferr: numberSchema,
});

const runEndEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("run_end"),
  src: nodeIdentifierSchema,
  run: numberSchema,
  count: numberSchema,
  received: numberSchema,
  pdr: numberSchema,
  // The quality fields are null when no packet was received. The contract does not say so, but
  // the firmware writes null in that case instead of leaving the fields out.
  rssi_avg: numberOrNullSchema,
  rssi_min: numberOrNullSchema,
  rssi_max: numberOrNullSchema,
  snr_avg: numberOrNullSchema,
  first: numberSchema,
  last: numberSchema,
  reason: runEndReasonSchema,
});

const duplicateEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("duplicate"),
  src: nodeIdentifierSchema,
  epoch: numberSchema,
  seq: numberSchema,
  type: transmissionTypeSchema,
});

const dropEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("drop"),
  reason: dropReasonSchema,
  size: numberSchema,
  rssi: numberSchema,
  snr: numberSchema,
});

const identifierConflictEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("id_conflict"),
  epoch: numberSchema,
  seq: numberSchema,
  rssi: numberSchema,
  snr: numberSchema,
});

const errorEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("error"),
  /** First word of the command, or "radio" for a radio failure. */
  cmd: textSchema,
  /** Any text, not only KNOWN_ERROR_REASONS. */
  reason: textSchema,
  detail: optional(textSchema),
  /** RadioLib error code. */
  code: optional(numberSchema),
});

/** Every event of the contract, in the order of docs/protocol/console.md. */
export const consoleEventSchema = z.discriminatedUnion("ev", [
  bootEventSchema,
  radioEventSchema,
  wifiEventSchema,
  statusEventSchema,
  neighborEventSchema,
  transmissionEventSchema,
  helloEventSchema,
  echoServedEventSchema,
  echoEventSchema,
  echoLostEventSchema,
  runStartEventSchema,
  runDoneEventSchema,
  testReceptionEventSchema,
  runEndEventSchema,
  duplicateEventSchema,
  dropEventSchema,
  identifierConflictEventSchema,
  errorEventSchema,
]);

export type ConsoleEvent = z.infer<typeof consoleEventSchema>;

export type ConsoleEventName = ConsoleEvent["ev"];

export type ConsoleEventOf<Name extends ConsoleEventName> = Extract<ConsoleEvent, { ev: Name }>;

export type RadioEvent = ConsoleEventOf<"radio">;
export type EchoEvent = ConsoleEventOf<"echo">;
export type EchoLostEvent = ConsoleEventOf<"echo_lost">;
export type RunEndEvent = ConsoleEventOf<"run_end">;
export type ErrorEvent = ConsoleEventOf<"error">;

/** Event names in the order of docs/protocol/console.md. */
export const CONSOLE_EVENT_NAMES: readonly ConsoleEventName[] = consoleEventSchema.def.options.map(
  (schema) => schema.shape.ev.def.values[0],
);

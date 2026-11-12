/**
 * Console events emitted by a node, as defined in docs/protocol/console.md (the version of that
 * contract is versions.consoleContract in firmware/protocol/contract.json).
 *
 * Each event is described once, as a Zod schema, and its type is inferred from the schema. Every
 * event carries `t` (milliseconds since the node booted) and `ev` (the event name); the other
 * fields keep the names used on the wire so that the contract can be checked by eye. The message
 * of each field schema says what the field should contain, in Spanish, for the operator.
 */
import * as z from "zod/mini";
import {
  ACTIVATION_CAUSES,
  BOARD_MODELS,
  BURST_CAUSES,
  CONSOLE_EVENTS,
  DROP_REASONS,
  ERROR_REASONS,
  IMAGE_ARRIVALS,
  IMAGE_REJECTION_REASONS,
  KEY_KINDS,
  LNA_MODES,
  MESSAGE_TYPES,
  NODE_ID_HEXADECIMAL_DIGITS,
  PRESENCE_STATES,
  REGISTER_COUNT,
  RUN_END_REASONS,
  VM_FAULTS,
  WIFI_STATES,
} from "$lib/protocol/protocol-contract.ts";

/**
 * NODE_ID_HEXADECIMAL_DIGITS uppercase hexadecimal digits, for example "3A7F". BROADCAST_IDENTIFIER
 * designates every node.
 */
export type NodeIdentifier = string;

/**
 * Any finite number. The firmware may write a whole value with or without decimals (-35 or -35.0),
 * so integer fields are not told apart from the others.
 */
const numberSchema = z.number({ error: "un número" });

/** A number that the firmware replaces with null when there is no value to report. */
const numberOrNullSchema = z.nullable(z.number({ error: "un número o null" }));

const textSchema = z.string({ error: "un texto" });

const booleanSchema = z.boolean({ error: "true o false" });

const NODE_IDENTIFIER_EXPECTATION = `un identificador de ${NODE_ID_HEXADECIMAL_DIGITS} dígitos hexadecimales en mayúscula`;

const NODE_IDENTIFIER_PATTERN = new RegExp(`^[0-9A-F]{${NODE_ID_HEXADECIMAL_DIGITS}}$`);

export const nodeIdentifierSchema = z
  .string({ error: NODE_IDENTIFIER_EXPECTATION })
  .check(z.regex(NODE_IDENTIFIER_PATTERN, { error: NODE_IDENTIFIER_EXPECTATION }));

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

const boardModelSchema = oneOf(BOARD_MODELS);
/**
 * The model a neighbor announced: null before its first HELLO or for a code outside the contract.
 */
const announcedBoardModelSchema = oneOf([...BOARD_MODELS, null]);
export const lnaModeSchema = oneOf(LNA_MODES);
const wifiStateSchema = oneOf(WIFI_STATES);
const presenceStateSchema = oneOf(PRESENCE_STATES);
const keyKindSchema = oneOf(KEY_KINDS);
const transmissionTypeSchema = oneOf(MESSAGE_TYPES);
const dropReasonSchema = oneOf(DROP_REASONS);
const runEndReasonSchema = oneOf(RUN_END_REASONS);
const vmFaultSchema = oneOf(VM_FAULTS);
/** Fault reason of a HELLO or a `neighbor` event: null when there was none since the activation. */
const vmFaultOrNullSchema = oneOf([...VM_FAULTS, null]);
const imageArrivalSchema = oneOf(IMAGE_ARRIVALS);
const imageRejectionReasonSchema = oneOf(IMAGE_REJECTION_REASONS);
const burstCauseSchema = oneOf(BURST_CAUSES);
const activationCauseSchema = oneOf(ACTIVATION_CAUSES);

export type BoardModel = z.infer<typeof boardModelSchema>;
export type LnaMode = z.infer<typeof lnaModeSchema>;
export type WifiState = z.infer<typeof wifiStateSchema>;
export type PresenceState = z.infer<typeof presenceStateSchema>;
export type KeyKind = z.infer<typeof keyKindSchema>;
export type RunEndReason = z.infer<typeof runEndReasonSchema>;
export type TransmissionType = z.infer<typeof transmissionTypeSchema>;
export type ImageArrival = z.infer<typeof imageArrivalSchema>;
export type ImageRejectionReason = z.infer<typeof imageRejectionReasonSchema>;
export type BurstCause = z.infer<typeof burstCauseSchema>;
export type ActivationCause = z.infer<typeof activationCauseSchema>;

/**
 * Reasons of the `error` event the contract lists (ERROR_REASONS). The event accepts any other
 * reason, since a newer firmware may add some.
 */
export type KnownErrorReason = (typeof ERROR_REASONS)[number];

export function isKnownErrorReason(value: string): value is KnownErrorReason {
  return (ERROR_REASONS as readonly string[]).includes(value);
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

const nodeIdentifierOrNullSchema = z.nullable(
  z
    .string({ error: `${NODE_IDENTIFIER_EXPECTATION} o null` })
    .check(z.regex(NODE_IDENTIFIER_PATTERN, { error: `${NODE_IDENTIFIER_EXPECTATION} o null` })),
);

const fragmentIndexListSchema = z.array(numberSchema, { error: "una lista de índices" });

const PROGRAM_CODE_EXPECTATION = "dos dígitos hexadecimales en minúscula por byte";

const programCodeSchema = z
  .string({ error: PROGRAM_CODE_EXPECTATION })
  .check(z.regex(/^(?:[0-9a-f]{2})*$/, { error: PROGRAM_CODE_EXPECTATION }));

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
  /** Network key. */
  key: keyKindSchema,
  /** Public key of the operator that verifies the images. */
  operator_key: keyKindSchema,
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

const presenceEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("presence"),
  /** "off" while the operator holds the HELLO messages. */
  state: presenceStateSchema,
  /** Seconds until the hold expires and the HELLO messages resume; null when they are on. */
  remaining: numberOrNullSchema,
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
  model: announcedBoardModelSchema,
  /** Active version of the neighbor. */
  version: numberSchema,
  /** Available version of the neighbor. */
  available: numberSchema,
  /** Last VM fault of the neighbor since its activation; null when there was none. */
  vm_fault: vmFaultOrNullSchema,
  /** True when the last tick of the neighbor ended in a fault. */
  vm_failing: booleanSchema,
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
    /** Only in "test" (position in the run) and "fragment" (index of the fragment). */
    index: optional(numberSchema),
    /** Only in "fragment" and "report": version of the image. */
    version: optional(numberSchema),
  })
  .check(
    z.refine(
      (event) => event.type !== "test" || (event.run !== undefined && event.index !== undefined),
      { error: "una transmisión de tipo test debe incluir run e index" },
    ),
    z.refine(
      (event) =>
        event.type !== "fragment" || (event.version !== undefined && event.index !== undefined),
      { error: "una transmisión de tipo fragment debe incluir version e index" },
    ),
    z.refine((event) => event.type !== "report" || event.version !== undefined, {
      error: "una transmisión de tipo report debe incluir version",
    }),
  );

const helloEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("hello"),
  src: nodeIdentifierSchema,
  epoch: numberSchema,
  seq: numberSchema,
  model: announcedBoardModelSchema,
  /** Active version of the sender. */
  version: numberSchema,
  /** Available version of the sender. */
  available: numberSchema,
  vm_fault: vmFaultOrNullSchema,
  vm_failing: booleanSchema,
  /** Packets transmitted by the sender since it booted. */
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
  // A receiver opens a run with its first packet, so a run_end always has quality values.
  rssi_avg: numberSchema,
  rssi_min: numberSchema,
  rssi_max: numberSchema,
  snr_avg: numberSchema,
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

const virtualMachineEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("vm"),
  /** Version of the active program; 0 is the factory program, which is empty. */
  version: numberSchema,
  /** Program length in bytes. */
  size: numberSchema,
  /** Ticks of the active program so far. */
  tick: numberSchema,
  /** R1 to R(REGISTER_COUNT), as signed 32-bit integers. */
  registers: z
    .array(numberSchema, { error: `un arreglo de ${REGISTER_COUNT} números` })
    .check(z.length(REGISTER_COUNT, { error: `un arreglo de ${REGISTER_COUNT} números` })),
});

const virtualMachinePrintEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("vm_print"),
  tick: numberSchema,
  /** Register from 1 to REGISTER_COUNT. */
  reg: numberSchema,
  /** Signed 32-bit value of the register. */
  value: numberSchema,
});

const virtualMachineFaultEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("vm_fault"),
  tick: numberSchema,
  /** Address of the instruction that failed. */
  pc: numberSchema,
  reason: vmFaultSchema,
});

const transferEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("transfer"),
  active: numberSchema,
  available: numberSchema,
  /** Version of the reception in progress, or null. */
  receiving: numberOrNullSchema,
  /** Bytes the reception in progress still lacks, or null. */
  missing: numberOrNullSchema,
  /** Fragment size of the node's complete bursts, in bytes. */
  fragment_size: numberSchema,
});

const imageEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("image"),
  version: numberSchema,
  /** Program length in bytes. */
  size: numberSchema,
  /** Length of the whole image in bytes. */
  image_size: numberSchema,
  via: imageArrivalSchema,
  /** Node that sent the last fragment; null with "console". */
  src: nodeIdentifierOrNullSchema,
  /** Fragments of that version accepted during the reception, repeated ones included. */
  fragments: numberSchema,
  /** Reports sent during the reception. */
  reports: numberSchema,
  /** Milliseconds from the first fragment of the reception to its completion. */
  duration: numberSchema,
});

const imageRejectedEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("image_rejected"),
  version: numberSchema,
  reason: imageRejectionReasonSchema,
  src: nodeIdentifierSchema,
});

const fragmentReceptionEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("fragment_rx"),
  src: nodeIdentifierSchema,
  version: numberSchema,
  index: numberSchema,
  count: numberSchema,
  /** Fragment size of the burst, in bytes. */
  size: numberSchema,
  /** Fragments left in the burst after this one. */
  remaining: numberSchema,
  /** True when the fragment belongs to the reception in progress. */
  accepted: booleanSchema,
  /** True when the fragment brought some byte that was missing. */
  new: booleanSchema,
  rssi: numberSchema,
  snr: numberSchema,
});

const burstStartEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("burst_start"),
  version: numberSchema,
  /** Fragment size, in bytes. */
  size: numberSchema,
  /** Fragments of the burst when it starts; a report may add more. */
  count: numberSchema,
  cause: burstCauseSchema,
  /** With "hello" and "report": the node that triggered the burst; otherwise null. */
  trigger: nodeIdentifierOrNullSchema,
});

const burstDoneEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("burst_done"),
  version: numberSchema,
  size: numberSchema,
  /** Fragments transmitted. */
  sent: numberSchema,
  /** Microseconds from the start of the first fragment to the end of the last one. */
  duration: numberSchema,
});

const reportSentEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("report_sent"),
  dst: nodeIdentifierSchema,
  version: numberSchema,
  size: numberSchema,
  count: numberSchema,
  /** Indices of the missing fragments. */
  missing: fragmentIndexListSchema,
  /** Number of the report within the reception, from 1. */
  round: numberSchema,
});

const reportReceivedEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("report_received"),
  src: nodeIdentifierSchema,
  version: numberSchema,
  size: numberSchema,
  count: numberSchema,
  missing: fragmentIndexListSchema,
});

const activationEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("activation"),
  version: numberSchema,
  previous: numberSchema,
  cause: activationCauseSchema,
  /** With "hello" and "neighbor": the neighbor that announced the version; otherwise null. */
  src: nodeIdentifierOrNullSchema,
});

const programEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("program"),
  /** Active version. */
  version: numberSchema,
  /** Program length in bytes. */
  size: numberSchema,
  /** The program, two lowercase hexadecimal digits per byte; empty with version 0. */
  code: programCodeSchema,
});

const errorEventSchema = z.extend(eventHeaderSchema, {
  ev: z.literal("error"),
  /** First word of the command, or "radio" for a radio failure. */
  cmd: textSchema,
  /** Any text, not only ERROR_REASONS. */
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
  presenceEventSchema,
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
  virtualMachineEventSchema,
  virtualMachinePrintEventSchema,
  virtualMachineFaultEventSchema,
  transferEventSchema,
  imageEventSchema,
  imageRejectedEventSchema,
  fragmentReceptionEventSchema,
  burstStartEventSchema,
  burstDoneEventSchema,
  reportSentEventSchema,
  reportReceivedEventSchema,
  activationEventSchema,
  programEventSchema,
  errorEventSchema,
]);

export type ConsoleEvent = z.infer<typeof consoleEventSchema>;

export type ConsoleEventName = ConsoleEvent["ev"];

export type ConsoleEventOf<Name extends ConsoleEventName> = Extract<ConsoleEvent, { ev: Name }>;

export type RadioEvent = ConsoleEventOf<"radio">;
export type EchoEvent = ConsoleEventOf<"echo">;
export type EchoLostEvent = ConsoleEventOf<"echo_lost">;
export type RunEndEvent = ConsoleEventOf<"run_end">;
export type HelloEvent = ConsoleEventOf<"hello">;
export type NeighborEvent = ConsoleEventOf<"neighbor">;
export type FragmentReceptionEvent = ConsoleEventOf<"fragment_rx">;
export type ReportSentEvent = ConsoleEventOf<"report_sent">;
export type ReportReceivedEvent = ConsoleEventOf<"report_received">;

/**
 * Event names in the order of docs/protocol/console.md, as the contract lists them. A name of the
 * contract without its schema does not compile; firmware-console-lines.test.ts checks that the
 * schema has no event outside the contract.
 */
export const CONSOLE_EVENT_NAMES: readonly ConsoleEventName[] = CONSOLE_EVENTS;

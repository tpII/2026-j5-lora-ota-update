import {
  BOARD_MODELS,
  CONSOLE_EVENT_NAMES,
  DROP_REASONS,
  KEY_KINDS,
  LNA_MODES,
  RUN_END_REASONS,
  TRANSMISSION_TYPES,
  WIFI_STATES,
  isNodeIdentifier,
  type ConsoleEvent,
  type ConsoleEventName,
  type ConsoleEventOf,
} from "./console-event.ts";

/**
 * A console line classified according to docs/protocol/console.md:
 * - "event": a JSON object that satisfies the contract;
 * - "unrecognized": a JSON object that does not (unknown event name or invalid fields); it is
 *   still an event emitted by the node, so it is recorded and exported;
 * - "debug": any other line, including malformed JSON.
 */
export type ParsedConsoleLine =
  | { readonly kind: "event"; readonly text: string; readonly event: ConsoleEvent }
  | {
      readonly kind: "unrecognized";
      readonly text: string;
      readonly object: Readonly<Record<string, unknown>>;
      /** Description of the deviation from the contract, in Spanish, for the operator. */
      readonly problem: string;
    }
  | { readonly kind: "debug"; readonly text: string };

interface FieldRule {
  readonly optional: boolean;
  /** What the field should contain, in Spanish, for the operator. */
  readonly expectation: string;
  accepts(value: unknown): boolean;
}

interface RequiredFieldRule extends FieldRule {
  readonly optional: false;
}

interface OptionalFieldRule extends FieldRule {
  readonly optional: true;
}

type IsOptionalKey<Event, Key extends keyof Event> =
  Record<never, never> extends Pick<Event, Key> ? true : false;

/** One rule per field of the event besides `t` and `ev`, optional exactly where the type is. */
type FieldRules<Event> = {
  readonly [Key in Exclude<keyof Event, "t" | "ev">]-?: IsOptionalKey<Event, Key> extends true
    ? OptionalFieldRule
    : RequiredFieldRule;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const NUMBER: RequiredFieldRule = {
  optional: false,
  expectation: "un número",
  accepts: isFiniteNumber,
};

/** A number that the firmware replaces with null when there is no value to report. */
const NUMBER_OR_NULL: RequiredFieldRule = {
  optional: false,
  expectation: "un número o null",
  accepts: (value) => value === null || isFiniteNumber(value),
};

const TEXT: RequiredFieldRule = {
  optional: false,
  expectation: "un texto",
  accepts: (value) => typeof value === "string",
};

const BOOLEAN: RequiredFieldRule = {
  optional: false,
  expectation: "true o false",
  accepts: (value) => typeof value === "boolean",
};

const IDENTIFIER: RequiredFieldRule = {
  optional: false,
  expectation: "un identificador de cuatro dígitos hexadecimales en mayúscula",
  accepts: isNodeIdentifier,
};

function oneOf(values: readonly (string | null)[]): RequiredFieldRule {
  return {
    optional: false,
    expectation: values.map((value) => (value === null ? "null" : `"${value}"`)).join(" o "),
    accepts: (value) => (typeof value === "string" || value === null) && values.includes(value),
  };
}

function optional(rule: RequiredFieldRule): OptionalFieldRule {
  return { ...rule, optional: true };
}

const MODEL = oneOf(BOARD_MODELS);

const NEIGHBOR_REPORTS: RequiredFieldRule = {
  optional: false,
  expectation: 'una lista de objetos { "id", "rssi", "snr" }',
  accepts: (value) =>
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        isNodeIdentifier((item as Record<string, unknown>).id) &&
        isFiniteNumber((item as Record<string, unknown>).rssi) &&
        isFiniteNumber((item as Record<string, unknown>).snr),
    ),
};

const EVENT_FIELD_RULES: { readonly [Name in ConsoleEventName]: FieldRules<ConsoleEventOf<Name>> } =
  {
    boot: {
      id: IDENTIFIER,
      model: MODEL,
      epoch: NUMBER,
      firmware: TEXT,
      protocol: NUMBER,
      key: oneOf(KEY_KINDS),
    },
    radio: {
      freq: NUMBER,
      sf: NUMBER,
      bw: NUMBER,
      cr: NUMBER,
      preamble: NUMBER,
      sync: NUMBER,
      power: NUMBER,
      chip: NUMBER,
      lna: oneOf([...LNA_MODES, null]),
    },
    wifi: { state: oneOf(WIFI_STATES), ssid: TEXT, channel: NUMBER, clients: NUMBER },
    status: {
      id: IDENTIFIER,
      model: MODEL,
      epoch: NUMBER,
      tx: NUMBER,
      rx: NUMBER,
      dropped: NUMBER,
      heap: NUMBER,
    },
    neighbor: {
      id: IDENTIFIER,
      model: MODEL,
      version: NUMBER,
      tx: NUMBER,
      rssi: NUMBER,
      snr: NUMBER,
      age: NUMBER,
    },
    tx: {
      type: oneOf(TRANSMISSION_TYPES),
      dst: IDENTIFIER,
      seq: NUMBER,
      size: NUMBER,
      toa: NUMBER,
      toa_calc: NUMBER,
      run: optional(NUMBER),
      index: optional(NUMBER),
    },
    hello: {
      src: IDENTIFIER,
      epoch: NUMBER,
      seq: NUMBER,
      model: MODEL,
      version: NUMBER,
      tx: NUMBER,
      rssi: NUMBER,
      snr: NUMBER,
      ferr: NUMBER,
      neighbors: NEIGHBOR_REPORTS,
    },
    echo_served: { src: IDENTIFIER, n: NUMBER, size: NUMBER, rssi: NUMBER, snr: NUMBER },
    echo: {
      dst: IDENTIFIER,
      n: NUMBER,
      size: NUMBER,
      rtt: NUMBER,
      rssi: NUMBER,
      snr: NUMBER,
      remote_rssi: NUMBER,
      remote_snr: NUMBER,
    },
    echo_lost: { dst: IDENTIFIER, n: NUMBER, size: NUMBER, timeout: NUMBER },
    run_start: { run: NUMBER, count: NUMBER, size: NUMBER, interval: NUMBER },
    run_done: { run: NUMBER, count: NUMBER, sent: NUMBER, duration: NUMBER, aborted: BOOLEAN },
    test_rx: {
      src: IDENTIFIER,
      run: NUMBER,
      index: NUMBER,
      count: NUMBER,
      size: NUMBER,
      rssi: NUMBER,
      snr: NUMBER,
      ferr: NUMBER,
    },
    run_end: {
      src: IDENTIFIER,
      run: NUMBER,
      count: NUMBER,
      received: NUMBER,
      pdr: NUMBER,
      rssi_avg: NUMBER_OR_NULL,
      rssi_min: NUMBER_OR_NULL,
      rssi_max: NUMBER_OR_NULL,
      snr_avg: NUMBER_OR_NULL,
      first: NUMBER,
      last: NUMBER,
      reason: oneOf(RUN_END_REASONS),
    },
    duplicate: { src: IDENTIFIER, epoch: NUMBER, seq: NUMBER, type: oneOf(TRANSMISSION_TYPES) },
    drop: { reason: oneOf(DROP_REASONS), size: NUMBER, rssi: NUMBER, snr: NUMBER },
    id_conflict: { epoch: NUMBER, seq: NUMBER, rssi: NUMBER, snr: NUMBER },
    // Any reason string is accepted: a newer firmware may add reasons (see KNOWN_ERROR_REASONS).
    error: { cmd: TEXT, reason: TEXT, detail: optional(TEXT), code: optional(NUMBER) },
  };

function isConsoleEventName(value: string): value is ConsoleEventName {
  return (CONSOLE_EVENT_NAMES as readonly string[]).includes(value);
}

type ValidationResult = { readonly event: ConsoleEvent } | { readonly problem: string };

/** Checks a decoded JSON object against the contract. */
export function validateConsoleEvent(object: Readonly<Record<string, unknown>>): ValidationResult {
  if (!isFiniteNumber(object.t)) {
    return { problem: "falta el campo t o no es un número" };
  }
  if (typeof object.ev !== "string") {
    return { problem: "falta el campo ev o no es un texto" };
  }
  if (!isConsoleEventName(object.ev)) {
    return { problem: `evento desconocido: ${object.ev}` };
  }
  if (object.truncated === true) {
    // The firmware never emits a cut object: it replaces an event that does not fit its buffer
    // with the header and this mark.
    return { problem: "el nodo truncó el evento porque no entraba en su búfer" };
  }
  const rules: Readonly<Record<string, FieldRule>> = EVENT_FIELD_RULES[object.ev];
  const event: Record<string, unknown> = { ...object };
  for (const [field, rule] of Object.entries(rules)) {
    const value = object[field];
    if (value === undefined || (value === null && rule.optional)) {
      if (!rule.optional) {
        return { problem: `falta el campo ${field}` };
      }
      // An optional field sent as null is taken as absent.
      delete event[field];
      continue;
    }
    if (!rule.accepts(value)) {
      return { problem: `el campo ${field} debería ser ${rule.expectation}` };
    }
  }
  if (object.ev === "tx" && object.type === "test") {
    if (event.run === undefined || event.index === undefined) {
      return { problem: "una transmisión de tipo test debe incluir run e index" };
    }
  }
  return { event: event as unknown as ConsoleEvent };
}

/** Classifies one console line (without its line end). */
export function parseConsoleLine(line: string): ParsedConsoleLine {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!text.startsWith("{")) {
    return { kind: "debug", text };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { kind: "debug", text };
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return { kind: "debug", text };
  }
  const object = decoded as Record<string, unknown>;
  const result = validateConsoleEvent(object);
  if ("event" in result) {
    return { kind: "event", text, event: result.event };
  }
  return { kind: "unrecognized", text, object, problem: result.problem };
}

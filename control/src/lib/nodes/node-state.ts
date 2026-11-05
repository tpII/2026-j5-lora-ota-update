/**
 * State of a node derived from its event stream. The reducer is pure: every event yields a new
 * state object and leaves the previous one untouched, so views can compare states by reference.
 */
import type {
  ActivationCause,
  BoardModel,
  BurstCause,
  ConsoleEvent,
  ConsoleEventOf,
  EchoEvent,
  EchoLostEvent,
  ErrorEvent,
  FragmentReceptionEvent,
  HelloNeighborReport,
  ImageArrival,
  ImageRejectionReason,
  KeyKind,
  NodeIdentifier,
  PresenceState,
  ReportSentEvent,
  RunEndEvent,
  WifiState,
} from "$lib/console/console-event.ts";
import { DEFAULT_FRAGMENT_SIZE } from "$lib/console/console-command.ts";
import type { VmFault } from "$lib/vm/virtual-machine.ts";
import { radioSettingsOf, type RadioSettings } from "$lib/radio/radio-settings.ts";

/** A node stops listing a neighbor after 60 s without packets from it (docs/protocol/frame.md). */
export const NEIGHBOR_EXPIRY_MILLISECONDS = 60_000;

const MAXIMUM_ECHO_RESULTS = 200;
const MAXIMUM_ERROR_RECORDS = 50;
const MAXIMUM_FINISHED_RECEPTIONS = 20;
const MAXIMUM_VM_PRINTS = 100;
const MAXIMUM_IMAGE_RECORDS = 20;
const MAXIMUM_ACTIVATION_RECORDS = 20;
const MAXIMUM_BURST_RECORDS = 50;
const MAXIMUM_REPORT_RECORDS = 100;

export interface WifiStatus {
  readonly state: WifiState;
  readonly ssid: string;
  readonly channel: number;
  readonly clients: number;
}

/** HELLO messages of the node, from the last `presence` event. */
export interface PresenceStatus {
  readonly state: PresenceState;
  /** Seconds until a hold expires, as the node reported them; null when the HELLO are on. */
  readonly remaining: number | null;
  readonly hostTime: number;
}

/** Counters reported by the last `status` event. */
export interface NodeCounters {
  readonly transmitted: number;
  readonly received: number;
  readonly droppedLines: number;
  readonly freeHeap: number;
  readonly hostTime: number;
}

export interface NeighborRecord {
  readonly id: NodeIdentifier;
  readonly model: BoardModel;
  /** Active version of the neighbor: the program its VM runs. */
  readonly version: number;
  /** Available version of the neighbor: the highest whose verified image it holds. */
  readonly availableVersion: number;
  /** Last VM fault of the neighbor since its activation; null when there was none. */
  readonly vmFault: VmFault | null;
  /** True when the last tick of the neighbor ended in a fault. */
  readonly vmFailing: boolean;
  /** Packets the neighbor reported as transmitted in its last HELLO. */
  readonly transmitted: number;
  readonly rssi: number;
  readonly snr: number;
  /** Frequency error of the last HELLO, in Hz; null when only a `neighbor` event was seen. */
  readonly frequencyError: number | null;
  readonly epoch: number | null;
  readonly sequence: number | null;
  /** Host time of the last packet received from the neighbor. */
  readonly lastHeardHostTime: number;
  /** How the neighbor hears its own neighbors, from its last HELLO. */
  readonly reportedNeighbors: readonly HelloNeighborReport[] | null;
  readonly helloCount: number;
}

export type EchoResult =
  | {
      readonly outcome: "answered";
      readonly hostTime: number;
      readonly destination: NodeIdentifier;
      readonly number: number;
      readonly size: number;
      readonly roundTripMicroseconds: number;
      /** Quality of the reply as received by this node. */
      readonly rssi: number;
      readonly snr: number;
      /** Quality of the request as received by the other node. */
      readonly remoteRssi: number;
      readonly remoteSnr: number;
    }
  | {
      readonly outcome: "lost";
      readonly hostTime: number;
      readonly destination: NodeIdentifier;
      readonly number: number;
      readonly size: number;
      readonly timeoutMilliseconds: number;
    };

export interface ServedEchoRecord {
  readonly hostTime: number;
  readonly source: NodeIdentifier;
  readonly number: number;
  readonly size: number;
  readonly rssi: number;
  readonly snr: number;
}

/** A run this node transmits or transmitted. */
export interface SenderRunProgress {
  readonly run: number;
  readonly count: number;
  readonly size: number;
  readonly interval: number;
  /** TEST frames reported by `tx` so far. */
  readonly transmitted: number;
  readonly startHostTime: number;
  readonly completion: {
    readonly sent: number;
    readonly duration: number;
    readonly aborted: boolean;
    readonly hostTime: number;
  } | null;
}

/** A run this node receives or received from another node. */
export interface ReceptionProgress {
  readonly source: NodeIdentifier;
  readonly run: number;
  readonly count: number;
  readonly received: number;
  readonly lastIndex: number | null;
  readonly lastRssi: number | null;
  readonly lastSnr: number | null;
  readonly startHostTime: number;
  readonly end: RunEndEvent | null;
}

export interface NodeErrorRecord {
  readonly hostTime: number;
  readonly command: string;
  readonly reason: string;
  readonly detail: string | null;
  readonly code: number | null;
}

/** The node's virtual machine, from its `vm` events and the values printed since. */
export interface VirtualMachineStatus {
  /** 0 is the factory program, which is empty. */
  readonly version: number;
  readonly size: number;
  readonly tick: number;
  /** R1 to R4. A PRINT updates the register it shows. */
  readonly registers: readonly number[];
  readonly hostTime: number;
}

export interface VirtualMachinePrintRecord {
  readonly hostTime: number;
  readonly tick: number;
  readonly register: number;
  readonly value: number;
}

export interface VirtualMachineFaultRecord {
  readonly hostTime: number;
  readonly tick: number;
  readonly address: number;
  readonly reason: VmFault;
}

/** The last `transfer` event of the node, as it reported it. */
export interface TransferStatus {
  readonly activeVersion: number;
  readonly availableVersion: number;
  /** Version of the reception in progress, or null. */
  readonly receivingVersion: number | null;
  /** Bytes the reception in progress still lacked, or null. */
  readonly missingBytes: number | null;
  /** Fragment size of the node's complete bursts, in bytes. */
  readonly fragmentSize: number;
  readonly hostTime: number;
}

/** A report this node sent or received. */
export interface ReportRecord {
  readonly hostTime: number;
  /** Destination of a sent report, or source of a received one. */
  readonly peer: NodeIdentifier;
  readonly version: number;
  readonly fragmentSize: number;
  readonly fragmentCount: number;
  /** Indices of the missing fragments. */
  readonly missing: readonly number[];
  /** Number of the report within the reception, from 1; null in a received report. */
  readonly round: number | null;
}

/**
 * The image this node receives over the radio, from its `fragment_rx` and `report_sent` events.
 * The node counts bytes, not fragments; the panel counts the fragments of the last size it saw,
 * and a report replaces that count with the one of the node.
 */
export interface ImageReceptionProgress {
  readonly version: number;
  /** Node that sent the last fragment. */
  readonly source: NodeIdentifier;
  readonly fragmentSize: number;
  readonly fragmentCount: number;
  /** Indices of the fragments of `fragmentSize` the node holds, in increasing order. */
  readonly heldFragments: readonly number[];
  /** Fragments of the reception accepted so far, repeated ones included. */
  readonly acceptedFragments: number;
  /** Accepted fragments that brought some missing byte. */
  readonly newFragments: number;
  readonly reportsSent: number;
  readonly firstReport: ReportRecord | null;
  readonly lastReport: ReportRecord | null;
  readonly startHostTime: number;
  readonly lastHostTime: number;
}

/** An `image` event: an image that became the available version. */
export interface ImageRecord {
  readonly hostTime: number;
  readonly version: number;
  readonly programSize: number;
  readonly imageSize: number;
  readonly via: ImageArrival;
  /** Node that sent the last fragment; null with "console". */
  readonly source: NodeIdentifier | null;
  readonly fragments: number;
  readonly reports: number;
  readonly durationMilliseconds: number;
}

export interface ImageRejectionRecord {
  readonly hostTime: number;
  readonly version: number;
  readonly reason: ImageRejectionReason;
  readonly source: NodeIdentifier;
}

export interface ActivationRecord {
  readonly hostTime: number;
  readonly version: number;
  readonly previous: number;
  readonly cause: ActivationCause;
  /** Neighbor that announced the version with "hello" and "neighbor"; otherwise null. */
  readonly source: NodeIdentifier | null;
}

/** The active program, as the `program` command returned it. */
export interface ProgramRecord {
  readonly hostTime: number;
  readonly version: number;
  readonly size: number;
  /** Two lowercase hexadecimal digits per byte; empty with version 0. */
  readonly code: string;
}

/** A burst this node sends or sent. */
export interface BurstRecord {
  readonly version: number;
  readonly fragmentSize: number;
  /** Fragments of the burst when it started. */
  readonly count: number;
  readonly cause: BurstCause;
  readonly trigger: NodeIdentifier | null;
  readonly startHostTime: number;
  /** FRAGMENT frames reported by `tx` so far. */
  readonly transmitted: number;
  readonly completion: {
    readonly sent: number;
    readonly durationMicroseconds: number;
    readonly hostTime: number;
  } | null;
}

export interface NodeState {
  readonly identifier: NodeIdentifier | null;
  readonly model: BoardModel | null;
  readonly epoch: number | null;
  readonly firmwareVersion: string | null;
  readonly protocolVersion: number | null;
  readonly networkKey: KeyKind | null;
  /** Whether the node verifies images with the default operator public key. */
  readonly operatorKey: KeyKind | null;
  /** Boots observed since the panel connected. */
  readonly bootCount: number;
  readonly radio: RadioSettings | null;
  readonly wifi: WifiStatus | null;
  readonly presence: PresenceStatus | null;
  readonly counters: NodeCounters | null;
  /** Sorted by identifier. */
  readonly neighbors: readonly NeighborRecord[];
  /** Oldest first. */
  readonly echoResults: readonly EchoResult[];
  readonly servedEchoes: readonly ServedEchoRecord[];
  readonly senderRun: SenderRunProgress | null;
  /** Receptions in progress first, then the finished ones, newest first. */
  readonly receptions: readonly ReceptionProgress[];
  /** Newest last. */
  readonly errors: readonly NodeErrorRecord[];
  readonly duplicateCount: number;
  readonly dropCount: number;
  readonly identifierConflictCount: number;
  /** Null until the node reports it with `vm`, after `status` or a load. */
  readonly virtualMachine: VirtualMachineStatus | null;
  /** Newest last. */
  readonly virtualMachinePrints: readonly VirtualMachinePrintRecord[];
  readonly lastVirtualMachineFault: VirtualMachineFaultRecord | null;
  /** Reason of the last fault since the last activation, as the HELLO byte `vm` carries it. */
  readonly faultSinceActivation: VmFault | null;
  /**
   * Versions the node reports on its own console: from `boot`, `transfer`, `image`,
   * `activation`, `vm` and `program`. Null until the first of them.
   */
  readonly activeVersion: number | null;
  readonly availableVersion: number | null;
  readonly transfer: TransferStatus | null;
  /** Null when no reception is known to be in progress. */
  readonly imageReception: ImageReceptionProgress | null;
  /** Newest last. */
  readonly images: readonly ImageRecord[];
  /** Newest last. */
  readonly imageRejections: readonly ImageRejectionRecord[];
  /** Newest last. */
  readonly activations: readonly ActivationRecord[];
  readonly program: ProgramRecord | null;
  /** Newest last. */
  readonly bursts: readonly BurstRecord[];
  /** Newest last. */
  readonly reportsReceived: readonly ReportRecord[];
  /** Fragments ignored because of their version. */
  readonly ignoredFragmentCount: number;
  /** Value of `t` and host time of the last event, to estimate the uptime of the node. */
  readonly lastEventNodeTime: number | null;
  readonly lastEventHostTime: number | null;
}

export const INITIAL_NODE_STATE: NodeState = {
  identifier: null,
  model: null,
  epoch: null,
  firmwareVersion: null,
  protocolVersion: null,
  networkKey: null,
  operatorKey: null,
  bootCount: 0,
  radio: null,
  wifi: null,
  presence: null,
  counters: null,
  neighbors: [],
  echoResults: [],
  servedEchoes: [],
  senderRun: null,
  receptions: [],
  errors: [],
  duplicateCount: 0,
  dropCount: 0,
  identifierConflictCount: 0,
  virtualMachine: null,
  virtualMachinePrints: [],
  lastVirtualMachineFault: null,
  faultSinceActivation: null,
  activeVersion: null,
  availableVersion: null,
  transfer: null,
  imageReception: null,
  images: [],
  imageRejections: [],
  activations: [],
  program: null,
  bursts: [],
  reportsReceived: [],
  ignoredFragmentCount: 0,
  lastEventNodeTime: null,
  lastEventHostTime: null,
};

function appendBounded<Item>(items: readonly Item[], item: Item, capacity: number): Item[] {
  const result = [...items, item];
  return result.length > capacity ? result.slice(result.length - capacity) : result;
}

function upsertNeighbor(
  neighbors: readonly NeighborRecord[],
  identifier: NodeIdentifier,
  update: (previous: NeighborRecord | undefined) => NeighborRecord,
): NeighborRecord[] {
  const previous = neighbors.find((neighbor) => neighbor.id === identifier);
  const others = neighbors.filter((neighbor) => neighbor.id !== identifier);
  return [...others, update(previous)].sort((first, second) => first.id.localeCompare(second.id));
}

function recordEcho(
  state: NodeState,
  event: EchoEvent | EchoLostEvent,
  hostTime: number,
): NodeState {
  const result: EchoResult =
    event.ev === "echo"
      ? {
          outcome: "answered",
          hostTime,
          destination: event.dst,
          number: event.n,
          size: event.size,
          roundTripMicroseconds: event.rtt,
          rssi: event.rssi,
          snr: event.snr,
          remoteRssi: event.remote_rssi,
          remoteSnr: event.remote_snr,
        }
      : {
          outcome: "lost",
          hostTime,
          destination: event.dst,
          number: event.n,
          size: event.size,
          timeoutMilliseconds: event.timeout,
        };
  return { ...state, echoResults: appendBounded(state.echoResults, result, MAXIMUM_ECHO_RESULTS) };
}

function recordError(state: NodeState, event: ErrorEvent, hostTime: number): NodeState {
  const record: NodeErrorRecord = {
    hostTime,
    command: event.cmd,
    reason: event.reason,
    detail: event.detail ?? null,
    code: event.code ?? null,
  };
  return { ...state, errors: appendBounded(state.errors, record, MAXIMUM_ERROR_RECORDS) };
}

function orderReceptions(receptions: readonly ReceptionProgress[]): ReceptionProgress[] {
  const active = receptions.filter((reception) => reception.end === null);
  const finished = receptions
    .filter((reception) => reception.end !== null)
    .slice(0, MAXIMUM_FINISHED_RECEPTIONS);
  return [...active, ...finished];
}

function isSameReception(
  reception: ReceptionProgress,
  source: NodeIdentifier,
  run: number,
): boolean {
  return reception.source === source && reception.run === run;
}

function reportRecordOf(
  event: ReportSentEvent | ConsoleEventOf<"report_received">,
  hostTime: number,
): ReportRecord {
  return {
    hostTime,
    peer: event.ev === "report_sent" ? event.dst : event.src,
    version: event.version,
    fragmentSize: event.size,
    fragmentCount: event.count,
    missing: [...event.missing],
    round: event.ev === "report_sent" ? event.round : null,
  };
}

function insertSorted(values: readonly number[], value: number): readonly number[] {
  return values.includes(value)
    ? values
    : [...values, value].sort((first, second) => first - second);
}

function acceptFragment(
  state: NodeState,
  event: FragmentReceptionEvent,
  hostTime: number,
): NodeState {
  if (!event.accepted) {
    return { ...state, ignoredFragmentCount: state.ignoredFragmentCount + 1 };
  }
  const previous = state.imageReception?.version === event.version ? state.imageReception : null;
  // Fragments of another size or count do not line up with the indices counted so far.
  const sameGeometry =
    previous !== null &&
    previous.fragmentSize === event.size &&
    previous.fragmentCount === event.count;
  const imageReception: ImageReceptionProgress = {
    version: event.version,
    source: event.src,
    fragmentSize: event.size,
    fragmentCount: event.count,
    heldFragments: insertSorted(sameGeometry ? previous.heldFragments : [], event.index),
    acceptedFragments: (previous?.acceptedFragments ?? 0) + 1,
    newFragments: (previous?.newFragments ?? 0) + (event.new ? 1 : 0),
    reportsSent: previous?.reportsSent ?? 0,
    firstReport: previous?.firstReport ?? null,
    lastReport: previous?.lastReport ?? null,
    startHostTime: previous?.startHostTime ?? hostTime,
    lastHostTime: hostTime,
  };
  return { ...state, imageReception };
}

function recordSentReport(state: NodeState, event: ReportSentEvent, hostTime: number): NodeState {
  const report = reportRecordOf(event, hostTime);
  const previous = state.imageReception?.version === event.version ? state.imageReception : null;
  const missing = new Set(event.missing);
  const heldFragments: number[] = [];
  for (let index = 0; index < event.count; ++index) {
    if (!missing.has(index)) {
      heldFragments.push(index);
    }
  }
  const imageReception: ImageReceptionProgress = {
    version: event.version,
    source: previous?.source ?? event.dst,
    fragmentSize: event.size,
    fragmentCount: event.count,
    heldFragments,
    acceptedFragments: previous?.acceptedFragments ?? 0,
    newFragments: previous?.newFragments ?? 0,
    reportsSent: (previous?.reportsSent ?? 0) + 1,
    firstReport: previous?.firstReport ?? report,
    lastReport: report,
    startHostTime: previous?.startHostTime ?? hostTime,
    lastHostTime: hostTime,
  };
  return { ...state, imageReception };
}

/** Replaces the last burst that matches `matches` and is still open. */
function updateOpenBurst(
  bursts: readonly BurstRecord[],
  matches: (burst: BurstRecord) => boolean,
  update: (burst: BurstRecord) => BurstRecord,
): readonly BurstRecord[] {
  const position = bursts.findLastIndex((burst) => burst.completion === null && matches(burst));
  if (position < 0) {
    return bursts;
  }
  return bursts.map((burst, index) => (index === position ? update(burst) : burst));
}

/** Applies one event received at `hostTime` (milliseconds since 1970 on the host). */
export function applyConsoleEvent(
  state: NodeState,
  event: ConsoleEvent,
  hostTime: number,
): NodeState {
  const next = reduceEvent(state, event, hostTime);
  return { ...next, lastEventNodeTime: event.t, lastEventHostTime: hostTime };
}

function reduceEvent(state: NodeState, event: ConsoleEvent, hostTime: number): NodeState {
  switch (event.ev) {
    case "boot": {
      // Another node behind the same transport: start over. The same node rebooting keeps its
      // history but loses its neighbors and runs, as the firmware does.
      const base =
        state.identifier !== null && state.identifier !== event.id ? INITIAL_NODE_STATE : state;
      return {
        ...base,
        identifier: event.id,
        model: event.model,
        epoch: event.epoch,
        firmwareVersion: event.firmware,
        protocolVersion: event.protocol,
        networkKey: event.key,
        operatorKey: event.operator_key,
        bootCount: base.bootCount + 1,
        // The node always boots with its HELLO messages on.
        presence: { state: "on", remaining: null, hostTime },
        neighbors: [],
        senderRun: null,
        receptions: base.receptions.filter((reception) => reception.end !== null),
        // The active program is not kept across reboots: the node returns to the factory program.
        virtualMachine: { version: 0, size: 0, tick: 0, registers: [0, 0, 0, 0], hostTime },
        lastVirtualMachineFault: null,
        faultSinceActivation: null,
        // Images live only in RAM: the node boots with version 0 and no image.
        activeVersion: 0,
        availableVersion: 0,
        transfer: {
          activeVersion: 0,
          availableVersion: 0,
          receivingVersion: null,
          missingBytes: null,
          fragmentSize: DEFAULT_FRAGMENT_SIZE,
          hostTime,
        },
        imageReception: null,
        program: null,
        bursts: base.bursts.filter((burst) => burst.completion !== null),
      };
    }
    case "status": {
      const base =
        state.identifier !== null && state.identifier !== event.id ? INITIAL_NODE_STATE : state;
      return {
        ...base,
        identifier: event.id,
        model: event.model,
        epoch: event.epoch,
        counters: {
          transmitted: event.tx,
          received: event.rx,
          droppedLines: event.dropped,
          freeHeap: event.heap,
          hostTime,
        },
      };
    }
    case "radio":
      return { ...state, radio: radioSettingsOf(event) };
    case "wifi":
      return {
        ...state,
        wifi: {
          state: event.state,
          ssid: event.ssid,
          channel: event.channel,
          clients: event.clients,
        },
      };
    case "presence":
      return {
        ...state,
        presence: { state: event.state, remaining: event.remaining, hostTime },
      };
    case "neighbor":
      return {
        ...state,
        neighbors: upsertNeighbor(state.neighbors, event.id, (previous) => ({
          id: event.id,
          model: event.model,
          version: event.version,
          availableVersion: event.available,
          vmFault: event.vm_fault,
          vmFailing: event.vm_failing,
          transmitted: event.tx,
          rssi: event.rssi,
          snr: event.snr,
          frequencyError: previous?.frequencyError ?? null,
          epoch: previous?.epoch ?? null,
          sequence: previous?.sequence ?? null,
          lastHeardHostTime: hostTime - event.age,
          reportedNeighbors: previous?.reportedNeighbors ?? null,
          helloCount: previous?.helloCount ?? 0,
        })),
      };
    case "hello":
      return {
        ...state,
        neighbors: upsertNeighbor(state.neighbors, event.src, (previous) => ({
          id: event.src,
          model: event.model,
          version: event.version,
          availableVersion: event.available,
          vmFault: event.vm_fault,
          vmFailing: event.vm_failing,
          transmitted: event.tx,
          rssi: event.rssi,
          snr: event.snr,
          frequencyError: event.ferr,
          epoch: event.epoch,
          sequence: event.seq,
          lastHeardHostTime: hostTime,
          reportedNeighbors: event.neighbors,
          helloCount: (previous?.helloCount ?? 0) + 1,
        })),
      };
    case "echo":
    case "echo_lost":
      return recordEcho(state, event, hostTime);
    case "echo_served":
      return {
        ...state,
        servedEchoes: appendBounded(
          state.servedEchoes,
          {
            hostTime,
            source: event.src,
            number: event.n,
            size: event.size,
            rssi: event.rssi,
            snr: event.snr,
          },
          MAXIMUM_ECHO_RESULTS,
        ),
      };
    case "run_start":
      return {
        ...state,
        senderRun: {
          run: event.run,
          count: event.count,
          size: event.size,
          interval: event.interval,
          transmitted: 0,
          startHostTime: hostTime,
          completion: null,
        },
      };
    case "tx": {
      if (event.type === "fragment") {
        return {
          ...state,
          bursts: updateOpenBurst(
            state.bursts,
            (burst) => burst.version === event.version,
            (burst) => ({ ...burst, transmitted: burst.transmitted + 1 }),
          ),
        };
      }
      const run = state.senderRun;
      if (
        event.type !== "test" ||
        run === null ||
        run.completion !== null ||
        event.run !== run.run
      ) {
        return state;
      }
      return { ...state, senderRun: { ...run, transmitted: run.transmitted + 1 } };
    }
    case "run_done": {
      const run = state.senderRun;
      if (run === null || run.run !== event.run) {
        return state;
      }
      return {
        ...state,
        senderRun: {
          ...run,
          completion: {
            sent: event.sent,
            duration: event.duration,
            aborted: event.aborted,
            hostTime,
          },
        },
      };
    }
    case "test_rx": {
      const existing = state.receptions.find(
        (reception) => isSameReception(reception, event.src, event.run) && reception.end === null,
      );
      const updated: ReceptionProgress = {
        source: event.src,
        run: event.run,
        count: event.count,
        received: (existing?.received ?? 0) + 1,
        lastIndex: event.index,
        lastRssi: event.rssi,
        lastSnr: event.snr,
        startHostTime: existing?.startHostTime ?? hostTime,
        end: null,
      };
      const others = state.receptions.filter((reception) => reception !== existing);
      return { ...state, receptions: orderReceptions([updated, ...others]) };
    }
    case "run_end": {
      const existing = state.receptions.find(
        (reception) => isSameReception(reception, event.src, event.run) && reception.end === null,
      );
      const updated: ReceptionProgress = {
        source: event.src,
        run: event.run,
        count: event.count,
        received: event.received,
        lastIndex: existing?.lastIndex ?? null,
        lastRssi: existing?.lastRssi ?? null,
        lastSnr: existing?.lastSnr ?? null,
        startHostTime: existing?.startHostTime ?? hostTime,
        end: event,
      };
      const others = state.receptions.filter((reception) => reception !== existing);
      const active = others.filter((reception) => reception.end === null);
      const finished = others.filter((reception) => reception.end !== null);
      return { ...state, receptions: orderReceptions([...active, updated, ...finished]) };
    }
    case "duplicate":
      return { ...state, duplicateCount: state.duplicateCount + 1 };
    case "drop":
      return { ...state, dropCount: state.dropCount + 1 };
    case "id_conflict":
      return { ...state, identifierConflictCount: state.identifierConflictCount + 1 };
    case "vm":
      return {
        ...state,
        activeVersion: event.version,
        virtualMachine: {
          version: event.version,
          size: event.size,
          tick: event.tick,
          registers: [...event.registers],
          hostTime,
        },
      };
    case "vm_print": {
      const record: VirtualMachinePrintRecord = {
        hostTime,
        tick: event.tick,
        register: event.reg,
        value: event.value,
      };
      const previous = state.virtualMachine;
      return {
        ...state,
        virtualMachine:
          previous === null
            ? null
            : {
                ...previous,
                tick: event.tick,
                registers: previous.registers.map((value, index) =>
                  index === event.reg - 1 ? event.value : value,
                ),
                hostTime,
              },
        virtualMachinePrints: appendBounded(state.virtualMachinePrints, record, MAXIMUM_VM_PRINTS),
      };
    }
    case "vm_fault":
      return {
        ...state,
        lastVirtualMachineFault: {
          hostTime,
          tick: event.tick,
          address: event.pc,
          reason: event.reason,
        },
        faultSinceActivation: event.reason,
      };
    case "transfer": {
      // The node is the authority on its reception: a different or absent one makes the count
      // of the panel stale.
      const reception = state.imageReception;
      return {
        ...state,
        activeVersion: event.active,
        availableVersion: event.available,
        transfer: {
          activeVersion: event.active,
          availableVersion: event.available,
          receivingVersion: event.receiving,
          missingBytes: event.missing,
          fragmentSize: event.fragment_size,
          hostTime,
        },
        imageReception: reception?.version === event.receiving ? reception : null,
      };
    }
    case "image":
      return {
        ...state,
        availableVersion: event.version,
        // A reception survives only for a version newer than the available one.
        imageReception:
          state.imageReception !== null && state.imageReception.version <= event.version
            ? null
            : state.imageReception,
        images: appendBounded(
          state.images,
          {
            hostTime,
            version: event.version,
            programSize: event.size,
            imageSize: event.image_size,
            via: event.via,
            source: event.src,
            fragments: event.fragments,
            reports: event.reports,
            durationMilliseconds: event.duration,
          },
          MAXIMUM_IMAGE_RECORDS,
        ),
      };
    case "image_rejected":
      return {
        ...state,
        imageReception:
          state.imageReception?.version === event.version ? null : state.imageReception,
        imageRejections: appendBounded(
          state.imageRejections,
          { hostTime, version: event.version, reason: event.reason, source: event.src },
          MAXIMUM_IMAGE_RECORDS,
        ),
      };
    case "fragment_rx":
      return acceptFragment(state, event, hostTime);
    case "report_sent":
      return recordSentReport(state, event, hostTime);
    case "report_received":
      return {
        ...state,
        reportsReceived: appendBounded(
          state.reportsReceived,
          reportRecordOf(event, hostTime),
          MAXIMUM_REPORT_RECORDS,
        ),
      };
    case "burst_start":
      return {
        ...state,
        bursts: appendBounded(
          state.bursts,
          {
            version: event.version,
            fragmentSize: event.size,
            count: event.count,
            cause: event.cause,
            trigger: event.trigger,
            startHostTime: hostTime,
            transmitted: 0,
            completion: null,
          },
          MAXIMUM_BURST_RECORDS,
        ),
      };
    case "burst_done":
      return {
        ...state,
        bursts: updateOpenBurst(
          state.bursts,
          (burst) => burst.version === event.version,
          (burst) => ({
            ...burst,
            completion: { sent: event.sent, durationMicroseconds: event.duration, hostTime },
          }),
        ),
      };
    case "activation":
      return {
        ...state,
        activeVersion: event.version,
        faultSinceActivation: null,
        activations: appendBounded(
          state.activations,
          {
            hostTime,
            version: event.version,
            previous: event.previous,
            cause: event.cause,
            source: event.src,
          },
          MAXIMUM_ACTIVATION_RECORDS,
        ),
      };
    case "program":
      return {
        ...state,
        activeVersion: event.version,
        program: { hostTime, version: event.version, size: event.size, code: event.code },
      };
    case "error":
      return recordError(state, event, hostTime);
  }
}

/** True while the node transmits a run or receives one: the firmware refuses `radio` with `busy`. */
export function isRunActive(state: NodeState): boolean {
  return (
    (state.senderRun !== null && state.senderRun.completion === null) ||
    state.receptions.some((reception) => reception.end === null)
  );
}

/** Share of the fragments of the reception the node holds, from 0 to 1. */
export function imageReceptionFraction(reception: ImageReceptionProgress): number {
  return reception.fragmentCount === 0
    ? 0
    : reception.heldFragments.length / reception.fragmentCount;
}

/** True while the node sends a burst, as far as its `burst_start` and `burst_done` tell. */
export function isBurstActive(state: NodeState): boolean {
  return state.bursts.some((burst) => burst.completion === null);
}

/** Milliseconds since the last packet of the neighbor, at host time `now`. */
export function neighborAge(neighbor: NeighborRecord, now: number): number {
  return Math.max(0, now - neighbor.lastHeardHostTime);
}

export function isNeighborExpired(neighbor: NeighborRecord, now: number): boolean {
  return neighborAge(neighbor, now) > NEIGHBOR_EXPIRY_MILLISECONDS;
}

/** Uptime of the node at host time `now`, estimated from the `t` of its last event. */
export function estimateUptime(state: NodeState, now: number): number | null {
  if (state.lastEventNodeTime === null || state.lastEventHostTime === null) {
    return null;
  }
  return state.lastEventNodeTime + Math.max(0, now - state.lastEventHostTime);
}

/**
 * What a node reports about updates: its active and available versions, the image it receives
 * over the radio, the images it accepted or rejected, the bursts it sends, the reports it receives
 * and its activations.
 */
import type {
  ActivationCause,
  BurstCause,
  ConsoleEvent,
  FragmentReceptionEvent,
  ImageArrival,
  ImageRejectionReason,
  NodeIdentifier,
  ReportReceivedEvent,
  ReportSentEvent,
} from "$lib/console/console-event.ts";
import { DEFAULT_FRAGMENT_SIZE } from "$lib/protocol/protocol-contract.ts";
import { appendBounded } from "$lib/utils/bounded-log.ts";
import { ownAnnouncedVersionsOf } from "./version-announcement.ts";

const MAXIMUM_IMAGE_RECORDS = 20;
const MAXIMUM_ACTIVATION_RECORDS = 20;
const MAXIMUM_BURST_RECORDS = 50;
const MAXIMUM_REPORT_RECORDS = 100;

/** The last `transfer` event of the node, as it reported it, without the versions. */
export interface TransferStatus {
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
  readonly fragmentSize: number;
  readonly fragmentCount: number;
  /** Indices of the fragments of `fragmentSize` the node holds, in increasing order. */
  readonly heldFragments: readonly number[];
  readonly lastReport: ReportRecord | null;
}

/** An `image` event: an image that became the available version. */
export interface ImageRecord {
  readonly hostTime: number;
  readonly version: number;
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
  /** Fragments transmitted, as `burst_done` reports them; null while the burst is open. */
  readonly completion: { readonly sent: number } | null;
}

export interface NodeUpdateState {
  /**
   * Versions the node reports on its own console, by the rule of version-announcement.ts. Null
   * until the first event that tells them.
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
  /** Newest last. */
  readonly bursts: readonly BurstRecord[];
  /** Newest last. */
  readonly reportsReceived: readonly ReportRecord[];
}

export const INITIAL_NODE_UPDATE_STATE: NodeUpdateState = {
  activeVersion: null,
  availableVersion: null,
  transfer: null,
  imageReception: null,
  images: [],
  imageRejections: [],
  activations: [],
  bursts: [],
  reportsReceived: [],
};

function reportRecordOf(
  event: ReportSentEvent | ReportReceivedEvent,
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

function receptionWithFragment(
  current: ImageReceptionProgress | null,
  event: FragmentReceptionEvent,
): ImageReceptionProgress {
  const previous = current?.version === event.version ? current : null;
  // Fragments of another size or count do not line up with the indices counted so far.
  const sameGeometry =
    previous !== null &&
    previous.fragmentSize === event.size &&
    previous.fragmentCount === event.count;
  return {
    version: event.version,
    fragmentSize: event.size,
    fragmentCount: event.count,
    heldFragments: insertSorted(sameGeometry ? previous.heldFragments : [], event.index),
    lastReport: previous?.lastReport ?? null,
  };
}

function receptionWithSentReport(
  current: ImageReceptionProgress | null,
  event: ReportSentEvent,
  hostTime: number,
): ImageReceptionProgress {
  const missing = new Set(event.missing);
  const heldFragments: number[] = [];
  for (let index = 0; index < event.count; ++index) {
    if (!missing.has(index)) {
      heldFragments.push(index);
    }
  }
  return {
    version: event.version,
    fragmentSize: event.size,
    fragmentCount: event.count,
    heldFragments,
    lastReport: reportRecordOf(event, hostTime),
  };
}

function updateOpenBurst(
  bursts: readonly BurstRecord[],
  version: number,
  update: (burst: BurstRecord) => BurstRecord,
): readonly BurstRecord[] {
  const position = bursts.findLastIndex(
    (burst) => burst.completion === null && burst.version === version,
  );
  if (position < 0) {
    return bursts;
  }
  return bursts.map((burst, index) => (index === position ? update(burst) : burst));
}

export function reduceNodeUpdate<State extends NodeUpdateState>(
  state: State,
  event: ConsoleEvent,
  hostTime: number,
): State {
  const versions = ownAnnouncedVersionsOf(event);
  const announced: State =
    versions === null
      ? state
      : {
          ...state,
          activeVersion: versions.active ?? state.activeVersion,
          availableVersion: versions.available ?? state.availableVersion,
        };
  return reduceTransfer(announced, event, hostTime);
}

function reduceTransfer<State extends NodeUpdateState>(
  state: State,
  event: ConsoleEvent,
  hostTime: number,
): State {
  switch (event.ev) {
    case "boot":
      return {
        ...state,
        transfer: {
          receivingVersion: null,
          missingBytes: null,
          fragmentSize: DEFAULT_FRAGMENT_SIZE,
          hostTime,
        },
        imageReception: null,
        bursts: state.bursts.filter((burst) => burst.completion !== null),
      };
    case "transfer": {
      // The node is the authority on its reception: a different or absent one makes the count
      // of the panel stale.
      const reception = state.imageReception;
      return {
        ...state,
        transfer: {
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
        imageReception:
          state.imageReception !== null && state.imageReception.version <= event.version
            ? null
            : state.imageReception,
        images: appendBounded(
          state.images,
          {
            hostTime,
            version: event.version,
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
      // A fragment the node ignored because of its version changes nothing.
      return event.accepted
        ? { ...state, imageReception: receptionWithFragment(state.imageReception, event) }
        : state;
    case "report_sent":
      return {
        ...state,
        imageReception: receptionWithSentReport(state.imageReception, event, hostTime),
      };
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
    case "tx":
      return event.type === "fragment" && event.version !== undefined
        ? {
            ...state,
            bursts: updateOpenBurst(state.bursts, event.version, (burst) => ({
              ...burst,
              transmitted: burst.transmitted + 1,
            })),
          }
        : state;
    case "burst_done":
      return {
        ...state,
        bursts: updateOpenBurst(state.bursts, event.version, (burst) => ({
          ...burst,
          completion: { sent: event.sent },
        })),
      };
    case "activation":
      return {
        ...state,
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
    default:
      return state;
  }
}

/** Share of the fragments of the reception the node holds, from 0 to 1. */
export function imageReceptionFraction(reception: ImageReceptionProgress): number {
  return reception.fragmentCount === 0
    ? 0
    : reception.heldFragments.length / reception.fragmentCount;
}

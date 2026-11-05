/**
 * Metrics of an update (Tabla 1 of the E1 and docs/protocol/console.md), computed from the events
 * of the connected nodes with the host time at which they arrived:
 *
 * - M1, convergence time: from the moment the panel sends `load_image` until every node of the
 *   connection graph announces the version as active, split into distribution (until every node
 *   announces it as available) and activation (from the moment the panel sends `activate`).
 * - M2, flooding efficiency: packets transmitted by every node during the update, from the `tx`
 *   counters of their HELLO messages, divided by the theoretical minimum, fragments times the
 *   number of nodes minus one.
 * - M3, loss and repair: per receiver, the share of fragments marked missing in its first report
 *   and the number of repair rounds, the `reports` of its `image` event.
 *
 * Every function is pure: the panel hands over the events of its journal and the host times of
 * the commands it sent.
 */
import type { ConsoleEvent, NodeIdentifier } from "$lib/console/console-event.ts";
import { commandWordOf } from "$lib/console/console-command.ts";
import { IMAGE_HEADER_SIZE, parseHex } from "$lib/image/image-format.ts";
import { NEIGHBOR_EXPIRY_MILLISECONDS } from "$lib/nodes/node-state.ts";
import type { NodeConsoleEvent } from "./event-journal.ts";

/** A command of the update, as the panel sent it. */
export type UpdateCommand =
  | { readonly kind: "load_image"; readonly version: number }
  | { readonly kind: "activate"; readonly version: number };

/** An update command sent to a connection, with the host time at which the panel sent it. */
export interface UpdateCommandRecord {
  readonly connectionKey: string;
  /** Node behind the connection when the command left, if already identified. */
  readonly node: NodeIdentifier | null;
  readonly hostTime: number;
  readonly command: UpdateCommand;
  /**
   * Only for `load_image`: true once the node behind the connection answered with its `image`
   * event of the version with `via: "console"`. A rejected load starts no update.
   */
  readonly accepted?: boolean;
}

export interface UpdateMetricsInput {
  readonly version: number;
  /** Host time at which the panel sent `load_image` with the version. */
  readonly loadHostTime: number;
  /** Host time at which the panel sent `activate` with the version; null if it did not. */
  readonly activateHostTime: number | null;
  /**
   * Host time at which the next update started, the first accepted `load_image` of another
   * version; the events from then on are left out. Null or absent when there is none.
   */
  readonly endHostTime?: number | null;
  /** Events of the connected nodes, in any order; those before `loadHostTime` set the baselines. */
  readonly events: Iterable<NodeConsoleEvent>;
  /**
   * Nodes of the connection graph. By default, the nodes the events name from `loadHostTime` on
   * (the consoles, the senders of HELLO, the `neighbor` events and the neighbor lists) until the
   * update converges, without those last heard more than the neighbor expiry before its end.
   */
  readonly nodes?: readonly NodeIdentifier[];
  /**
   * Fragments of the image, for the minimum of M2. By default, the count of the first burst of
   * the version caused by the load, or else by a completion.
   */
  readonly fragmentCount?: number;
}

/** A phase of M1: from its start until every node of the graph reaches the condition. */
export interface UpdatePhase {
  readonly startHostTime: number;
  /** First host time at which every node met the condition; null while some node has not. */
  readonly endHostTime: number | null;
  readonly milliseconds: number | null;
  /** Nodes that do not meet the condition at the last event; empty once the phase ended. */
  readonly pendingNodes: readonly NodeIdentifier[];
}

/** When the panel first learned that each node announces the version. */
export interface NodeUpdateTimes {
  readonly id: NodeIdentifier;
  /** Null until the node announces the version as available. */
  readonly availableHostTime: number | null;
  /** Null until the node announces the version as active. */
  readonly activeHostTime: number | null;
}

/** M1. */
export interface ConvergenceTimes {
  /** From `load_image` until every node announces the version as active. */
  readonly total: UpdatePhase;
  /** From `load_image` until every node announces the version as available. */
  readonly distribution: UpdatePhase;
  /** From `activate` until every node announces the version as active; null without `activate`. */
  readonly activation: UpdatePhase | null;
  readonly nodes: readonly NodeUpdateTimes[];
}

/** Packets a node transmitted during the update, from the `tx` counters it reported. */
export interface NodeTransmissionCount {
  readonly id: NodeIdentifier;
  /** Counter at the start: the last one reported before the load, or the first one after it. */
  readonly startCount: number | null;
  readonly startHostTime: number | null;
  /** True when no counter was reported before the load, so the count misses some packets. */
  readonly startsAfterLoad: boolean;
  /** Counter at the end: the first one reported once the update converged, or the last one. */
  readonly endCount: number | null;
  readonly endHostTime: number | null;
  /** Packets between both counters, across reboots; null without two counters. */
  readonly transmitted: number | null;
}

/** M2. */
export interface FloodingEfficiency {
  /** Sum of `transmitted` over the nodes; null if some node lacks it. */
  readonly transmitted: number | null;
  readonly nodes: readonly NodeTransmissionCount[];
  readonly fragmentCount: number | null;
  /** Fragments times the number of nodes minus one; null without the fragment count. */
  readonly minimum: number | null;
  /** `transmitted / minimum`; null if either is unknown or the minimum is 0. */
  readonly ratio: number | null;
  /** FRAGMENT and REPORT frames of the version in the `tx` events of the connected nodes. */
  readonly transferFrames: {
    readonly fragments: number;
    readonly reports: number;
    /** Connected nodes whose `tx` events were counted. */
    readonly countedNodes: readonly NodeIdentifier[];
    /** True when every node of the graph was connected, so the count is complete. */
    readonly complete: boolean;
  };
}

/** The first report of a receiver after the first burst. */
export interface FirstReport {
  readonly hostTime: number;
  /** Fragments of the image with the size of the report. */
  readonly fragmentCount: number;
  readonly missing: readonly number[];
  /** `report_sent` on the receiver's console, or `report_received` on the console of a sender. */
  readonly seenAs: "report_sent" | "report_received";
}

/** M3, for one receiver. */
export interface ReceiverRepair {
  readonly id: NodeIdentifier;
  /** True when the panel has the receiver's console, so it sees its `image` event. */
  readonly connected: boolean;
  readonly firstReport: FirstReport | null;
  /**
   * Percentage of fragments marked missing in the first report; 0 when the `image` event says the
   * receiver sent no report, null when unknown.
   */
  readonly missingPercent: number | null;
  /** `reports` of the receiver's `image` event; null without it. */
  readonly repairRounds: number | null;
  /** Reports of the version the panel saw from the receiver, sent or received. */
  readonly observedReports: number;
  readonly image: {
    readonly hostTime: number;
    readonly fragments: number;
    readonly reports: number;
    readonly durationMilliseconds: number;
  } | null;
}

export interface UpdateMetrics {
  readonly version: number;
  /** Nodes of the graph, sorted by identifier. */
  readonly nodes: readonly NodeIdentifier[];
  /** Node whose console loaded the image, when the events show it. */
  readonly origin: NodeIdentifier | null;
  readonly loadHostTime: number;
  readonly activateHostTime: number | null;
  readonly convergence: ConvergenceTimes;
  readonly efficiency: FloodingEfficiency;
  /** Every node of the graph but the origin, sorted by identifier. */
  readonly receivers: readonly ReceiverRepair[];
}

const VERSION_OFFSET = 3;

/** The update command of a command line, or null for any other command. */
export function parseUpdateCommand(commandLine: string): UpdateCommand | null {
  const words = commandLine.trim().split(/\s+/);
  const word = commandWordOf(commandLine);
  if (word === "activate" && words.length === 2) {
    const version = Number(words[1]);
    return Number.isInteger(version) && version > 0 ? { kind: "activate", version } : null;
  }
  if (word === "load_image" && words.length === 2) {
    const header = parseHex((words[1] ?? "").slice(0, 2 * IMAGE_HEADER_SIZE));
    if (header === null || header.length < IMAGE_HEADER_SIZE) {
      return null;
    }
    const version = new DataView(header.buffer).getUint32(VERSION_OFFSET, true);
    return { kind: "load_image", version };
  }
  return null;
}

/**
 * Marks as accepted the `load_image` that an `image` event with `via: "console"` answers: the last
 * `load_image` the panel sent to `connectionKey` at or before `hostTime`, if it carries `version`.
 * Returns the same list when no command matches.
 */
export function acceptLoadImage(
  commands: readonly UpdateCommandRecord[],
  connectionKey: string,
  version: number,
  hostTime: number,
): readonly UpdateCommandRecord[] {
  const index = commands.findLastIndex(
    (record) =>
      record.connectionKey === connectionKey &&
      record.command.kind === "load_image" &&
      record.hostTime <= hostTime,
  );
  const load = commands[index];
  if (load === undefined || load.command.version !== version || load.accepted === true) {
    return commands;
  }
  return commands.map((record, position) =>
    position === index ? { ...record, accepted: true } : record,
  );
}

function isAcceptedLoad(record: UpdateCommandRecord): boolean {
  return record.command.kind === "load_image" && record.accepted === true;
}

/**
 * The first accepted `load_image` of `version`, the first `activate` of it that followed and the
 * first accepted `load_image` of another version after it, which ends the update. Null when no
 * node accepted the version.
 */
export function updateCommandTimesOf(
  commands: readonly UpdateCommandRecord[],
  version: number,
): {
  readonly loadHostTime: number;
  readonly activateHostTime: number | null;
  readonly endHostTime: number | null;
} | null {
  const load = commands.find(
    (record) => isAcceptedLoad(record) && record.command.version === version,
  );
  if (load === undefined) {
    return null;
  }
  const activate = commands.find(
    (record) =>
      record.command.kind === "activate" &&
      record.command.version === version &&
      record.hostTime >= load.hostTime,
  );
  const next = commands.find(
    (record) =>
      isAcceptedLoad(record) &&
      record.command.version !== version &&
      record.hostTime > load.hostTime,
  );
  return {
    loadHostTime: load.hostTime,
    activateHostTime: activate?.hostTime ?? null,
    endHostTime: next?.hostTime ?? null,
  };
}

interface Announcement {
  readonly id: NodeIdentifier;
  /**
   * Host time the information dates from: a `neighbor` entry is as old as the last packet its
   * observer heard from the node.
   */
  readonly hostTime: number;
  readonly active?: number;
  readonly available?: number;
}

/** What an event says about the versions of a node. */
function announcementsOf(entry: NodeConsoleEvent): Announcement[] {
  const { node, event, hostTime } = entry;
  switch (event.ev) {
    case "hello":
      return [{ id: event.src, hostTime, active: event.version, available: event.available }];
    case "neighbor":
      return [
        {
          id: event.id,
          hostTime: hostTime - event.age,
          active: event.version,
          available: event.available,
        },
      ];
    case "boot":
      return [{ id: node, hostTime, active: 0, available: 0 }];
    case "transfer":
      return [{ id: node, hostTime, active: event.active, available: event.available }];
    case "image":
      return [{ id: node, hostTime, available: event.version }];
    case "activation":
    case "vm":
    case "program":
      return [{ id: node, hostTime, active: event.version }];
    default:
      return [];
  }
}

/**
 * Every node an event names, for the default node set, with the host time at which it was last
 * heard: the console and the HELLO sender now, a `neighbor` entry when its last packet arrived.
 */
function nodesNamedBy(
  entry: NodeConsoleEvent,
): { readonly id: NodeIdentifier; readonly hostTime: number }[] {
  const { node, event, hostTime } = entry;
  if (event.ev === "hello") {
    return [node, event.src, ...event.neighbors.map((neighbor) => neighbor.id)].map((id) => ({
      id,
      hostTime,
    }));
  }
  if (event.ev === "neighbor") {
    return [
      { id: node, hostTime },
      { id: event.id, hostTime: hostTime - event.age },
    ];
  }
  return [{ id: node, hostTime }];
}

interface TransmissionSample {
  readonly hostTime: number;
  readonly epoch: number;
  readonly count: number;
}

/**
 * The `tx` counter a HELLO or `status` reports, with the epoch of the node, and a boot as a
 * counter at 0. A `neighbor` event repeats the counter of a HELLO that may be up to a minute old,
 * so it is no sample.
 */
function transmissionSampleOf(
  entry: NodeConsoleEvent,
): { readonly id: NodeIdentifier; readonly sample: TransmissionSample } | null {
  const { event, hostTime } = entry;
  switch (event.ev) {
    case "hello":
      return { id: event.src, sample: { hostTime, epoch: event.epoch, count: event.tx } };
    case "status":
      return { id: entry.node, sample: { hostTime, epoch: event.epoch, count: event.tx } };
    case "boot":
      return { id: entry.node, sample: { hostTime, epoch: event.epoch, count: 0 } };
    default:
      return null;
  }
}

function phaseOf(
  startHostTime: number,
  endHostTime: number | null,
  pendingNodes: readonly NodeIdentifier[],
): UpdatePhase {
  return {
    startHostTime,
    endHostTime,
    milliseconds: endHostTime === null ? null : Math.max(0, endHostTime - startHostTime),
    pendingNodes: endHostTime === null ? pendingNodes : [],
  };
}

interface NodeVersions {
  active: number | null;
  available: number | null;
}

interface ConvergenceMeasurement {
  readonly convergence: ConvergenceTimes;
  /** Nodes of the graph of the update, sorted by identifier. */
  readonly nodes: readonly NodeIdentifier[];
}

/**
 * M1. Without `fixedNodes`, the node set grows with the nodes the events name until the update
 * converges, so a node that appears afterwards does not reopen it; a node last heard more than the
 * neighbor expiry before an event does not count at that event, as in the connection graph.
 */
function measureConvergence(
  input: UpdateMetricsInput,
  window: readonly NodeConsoleEvent[],
  fixedNodes: readonly NodeIdentifier[] | undefined,
): ConvergenceMeasurement {
  const { version, loadHostTime, activateHostTime } = input;
  const latest = new Map<NodeIdentifier, NodeVersions>();
  const times = new Map<NodeIdentifier, { available: number | null; active: number | null }>();
  /** Host time of the freshest announcement applied to each node. */
  const announced = new Map<NodeIdentifier, number>();
  const lastHeard = new Map<NodeIdentifier, number>();
  const join = (id: NodeIdentifier): boolean => {
    if (latest.has(id)) {
      return false;
    }
    latest.set(id, { active: null, available: null });
    times.set(id, { available: null, active: null });
    return true;
  };
  for (const id of fixedNodes ?? []) {
    join(id);
  }
  const present = (id: NodeIdentifier, hostTime: number): boolean =>
    fixedNodes !== undefined ||
    (lastHeard.get(id) ?? Number.NEGATIVE_INFINITY) >= hostTime - NEIGHBOR_EXPIRY_MILLISECONDS;
  const presentNodes = (hostTime: number): NodeIdentifier[] =>
    [...latest.keys()].filter((id) => present(id, hostTime));
  let distributionEnd: number | null = null;
  let totalEnd: number | null = null;
  let activationEnd: number | null = null;
  // A node that runs the version holds its image, even if the panel missed its `image` event.
  const holdsVersion = (versions: NodeVersions): boolean =>
    versions.available === version || versions.active === version;
  const isActive = (versions: NodeVersions): boolean => versions.active === version;
  for (const entry of window) {
    if (fixedNodes === undefined) {
      for (const named of nodesNamedBy(entry)) {
        const heard = lastHeard.get(named.id);
        if (heard === undefined || named.hostTime > heard) {
          lastHeard.set(named.id, named.hostTime);
        }
        // A node that joins before the convergence has unknown versions, so the distribution
        // has not ended for it yet.
        if (totalEnd === null && join(named.id)) {
          distributionEnd = null;
        }
      }
    }
    for (const announcement of announcementsOf(entry)) {
      const versions = latest.get(announcement.id);
      const time = times.get(announcement.id);
      if (versions === undefined || time === undefined) {
        continue;
      }
      // A stale `neighbor` entry does not overwrite a fresher announcement.
      if (announcement.hostTime < (announced.get(announcement.id) ?? Number.NEGATIVE_INFINITY)) {
        continue;
      }
      announced.set(announcement.id, announcement.hostTime);
      if (announcement.active !== undefined) {
        versions.active = announcement.active;
        if (announcement.active === version) {
          time.active ??= entry.hostTime;
          time.available ??= entry.hostTime;
        }
      }
      if (announcement.available !== undefined) {
        versions.available = announcement.available;
        if (announcement.available === version) {
          time.available ??= entry.hostTime;
        }
      }
    }
    const current = presentNodes(entry.hostTime);
    const everyNode = (condition: (versions: NodeVersions) => boolean): boolean =>
      current.length > 0 &&
      current.every((id) => {
        const versions = latest.get(id);
        return versions !== undefined && condition(versions);
      });
    const allActive = everyNode(isActive);
    if (distributionEnd === null && everyNode(holdsVersion)) {
      distributionEnd = entry.hostTime;
    }
    if (totalEnd === null && allActive) {
      totalEnd = entry.hostTime;
    }
    if (
      activateHostTime !== null &&
      activationEnd === null &&
      allActive &&
      entry.hostTime >= activateHostTime
    ) {
      activationEnd = entry.hostTime;
    }
  }
  const referenceHostTime = totalEnd ?? window.at(-1)?.hostTime ?? loadHostTime;
  const nodes = presentNodes(referenceHostTime).sort();
  const pendingWhere = (condition: (versions: NodeVersions) => boolean): NodeIdentifier[] =>
    nodes.filter((id) => {
      const versions = latest.get(id);
      return versions === undefined || !condition(versions);
    });
  const notAvailable = pendingWhere(holdsVersion);
  const notActive = pendingWhere(isActive);
  return {
    nodes,
    convergence: {
      total: phaseOf(loadHostTime, totalEnd, notActive),
      distribution: phaseOf(loadHostTime, distributionEnd, notAvailable),
      activation:
        activateHostTime === null
          ? null
          : // A node activated before the order (forced from another console) ends the phase at
            // the order itself.
            phaseOf(
              activateHostTime,
              activationEnd ?? (totalEnd !== null ? Math.max(totalEnd, activateHostTime) : null),
              notActive,
            ),
      nodes: nodes.map((id) => ({
        id,
        availableHostTime: times.get(id)?.available ?? null,
        activeHostTime: times.get(id)?.active ?? null,
      })),
    },
  };
}

function countTransmissions(
  id: NodeIdentifier,
  samples: readonly TransmissionSample[],
  loadHostTime: number,
  endHostTime: number | null,
): NodeTransmissionCount {
  const before = samples.filter((sample) => sample.hostTime <= loadHostTime);
  const after = samples.filter((sample) => sample.hostTime > loadHostTime);
  const start = before.at(-1) ?? after[0] ?? null;
  const end =
    endHostTime === null
      ? (samples.at(-1) ?? null)
      : (samples.find((sample) => sample.hostTime >= endHostTime) ?? samples.at(-1) ?? null);
  if (start === null || end === null || end.hostTime <= start.hostTime) {
    return {
      id,
      startCount: start?.count ?? null,
      startHostTime: start?.hostTime ?? null,
      startsAfterLoad: before.length === 0,
      endCount: end?.count ?? null,
      endHostTime: end?.hostTime ?? null,
      transmitted: null,
    };
  }
  // The epoch grows at every boot and when the sequence wraps around: under a new epoch, a counter
  // that went down means the node rebooted and counts again from 0. Within one epoch the counter
  // never goes down, so a lower one is a stale sample, and so is one of an older epoch.
  let transmitted = 0;
  let previous = start.count;
  let epoch = start.epoch;
  for (const sample of samples) {
    if (sample.hostTime <= start.hostTime || sample.hostTime > end.hostTime) {
      continue;
    }
    if (sample.epoch > epoch) {
      transmitted += sample.count >= previous ? sample.count - previous : sample.count;
      previous = sample.count;
      epoch = sample.epoch;
    } else if (sample.epoch === epoch && sample.count > previous) {
      transmitted += sample.count - previous;
      previous = sample.count;
    }
  }
  return {
    id,
    startCount: start.count,
    startHostTime: start.hostTime,
    startsAfterLoad: before.length === 0,
    endCount: end.count,
    endHostTime: end.hostTime,
    transmitted,
  };
}

function defaultFragmentCount(window: readonly NodeConsoleEvent[], version: number): number | null {
  const bursts = window.flatMap(({ event }) =>
    event.ev === "burst_start" && event.version === version ? [event] : [],
  );
  const burst =
    bursts.find((event) => event.cause === "load") ??
    bursts.find((event) => event.cause === "complete");
  return burst?.count ?? null;
}

function measureEfficiency(
  input: UpdateMetricsInput,
  sorted: readonly NodeConsoleEvent[],
  window: readonly NodeConsoleEvent[],
  nodes: readonly NodeIdentifier[],
  endHostTime: number | null,
): FloodingEfficiency {
  const samples = new Map<NodeIdentifier, TransmissionSample[]>();
  for (const entry of sorted) {
    const found = transmissionSampleOf(entry);
    if (found !== null) {
      const list = samples.get(found.id) ?? [];
      list.push(found.sample);
      samples.set(found.id, list);
    }
  }
  const counts = nodes.map((id) =>
    countTransmissions(id, samples.get(id) ?? [], input.loadHostTime, endHostTime),
  );
  const transmitted = counts.every((count) => count.transmitted !== null)
    ? counts.reduce((sum, count) => sum + (count.transmitted ?? 0), 0)
    : null;
  const fragmentCount = input.fragmentCount ?? defaultFragmentCount(window, input.version);
  const minimum = fragmentCount === null ? null : fragmentCount * Math.max(0, nodes.length - 1);
  let fragments = 0;
  let reports = 0;
  const countedNodes = new Set<NodeIdentifier>();
  for (const entry of window) {
    countedNodes.add(entry.node);
    const { event } = entry;
    if (endHostTime !== null && entry.hostTime > endHostTime) {
      continue;
    }
    if (event.ev === "tx" && event.version === input.version) {
      if (event.type === "fragment") {
        fragments += 1;
      } else if (event.type === "report") {
        reports += 1;
      }
    }
  }
  return {
    transmitted,
    nodes: counts,
    fragmentCount,
    minimum,
    ratio: transmitted === null || minimum === null || minimum === 0 ? null : transmitted / minimum,
    transferFrames: {
      fragments,
      reports,
      countedNodes: [...countedNodes].sort(),
      complete: nodes.every((id) => countedNodes.has(id)),
    },
  };
}

function measureReceivers(
  window: readonly NodeConsoleEvent[],
  version: number,
  nodes: readonly NodeIdentifier[],
  origin: NodeIdentifier | null,
): ReceiverRepair[] {
  const consoles = new Set(window.map((entry) => entry.node));
  return nodes
    .filter((id) => id !== origin)
    .map((id) => {
      let sentFirst: FirstReport | null = null;
      let receivedFirst: FirstReport | null = null;
      let sentCount = 0;
      let receivedCount = 0;
      let image: ReceiverRepair["image"] = null;
      for (const { node, hostTime, event } of window) {
        if (event.ev === "report_sent" && node === id && event.version === version) {
          sentCount += 1;
          if (sentFirst === null && event.round === 1) {
            sentFirst = {
              hostTime,
              fragmentCount: event.count,
              missing: [...event.missing],
              seenAs: "report_sent",
            };
          }
        } else if (
          event.ev === "report_received" &&
          event.src === id &&
          event.version === version
        ) {
          receivedCount += 1;
          receivedFirst ??= {
            hostTime,
            fragmentCount: event.count,
            missing: [...event.missing],
            seenAs: "report_received",
          };
        } else if (
          event.ev === "image" &&
          node === id &&
          event.version === version &&
          event.via === "radio" &&
          image === null
        ) {
          image = {
            hostTime,
            fragments: event.fragments,
            reports: event.reports,
            durationMilliseconds: event.duration,
          };
        }
      }
      const connected = consoles.has(id);
      const firstReport = sentFirst ?? receivedFirst;
      const missingPercent =
        firstReport !== null && firstReport.fragmentCount > 0
          ? (100 * firstReport.missing.length) / firstReport.fragmentCount
          : image?.reports === 0
            ? 0
            : null;
      return {
        id,
        connected,
        firstReport,
        missingPercent,
        repairRounds: image?.reports ?? null,
        observedReports: connected ? sentCount : receivedCount,
        image,
      };
    });
}

/** Computes M1, M2 and M3 for the update of `input.version`. */
export function computeUpdateMetrics(input: UpdateMetricsInput): UpdateMetrics {
  const end = input.endHostTime ?? Number.POSITIVE_INFINITY;
  const sorted = [...input.events]
    .filter((entry) => entry.hostTime < end)
    .sort((first, second) => first.hostTime - second.hostTime);
  const window = sorted.filter((entry) => entry.hostTime >= input.loadHostTime);
  const fixedNodes = input.nodes === undefined ? undefined : [...new Set(input.nodes)].sort();
  const { convergence, nodes } = measureConvergence(input, window, fixedNodes);
  const origin =
    window.find(
      ({ event }) =>
        event.ev === "image" && event.version === input.version && event.via === "console",
    )?.node ?? null;
  return {
    version: input.version,
    nodes,
    origin,
    loadHostTime: input.loadHostTime,
    activateHostTime: input.activateHostTime,
    convergence,
    efficiency: measureEfficiency(input, sorted, window, nodes, convergence.total.endHostTime),
    receivers: measureReceivers(window, input.version, nodes, origin),
  };
}

/** The events of a list of consoles, as the tests and the panel hand them over. */
export function nodeConsoleEventsOf(
  node: NodeIdentifier,
  events: Iterable<{ readonly event: ConsoleEvent; readonly hostTime: number }>,
): NodeConsoleEvent[] {
  return [...events].map(({ event, hostTime }) => ({ node, hostTime, event }));
}

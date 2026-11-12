/**
 * The event stream of the panel: the last lines of every connection, in the order they arrived,
 * and those that pass the filters of the event stream view. The panel publishes both with its
 * other snapshots, and filters only while the view is visible.
 */
import type { ConsoleEventName } from "$lib/console/console-event.ts";
import type { ConsoleRecord } from "$lib/node-session/node-connection.ts";
import { BoundedLog } from "$lib/utils/bounded-log.ts";

/** Lines kept for the event stream view, across every connection. */
export const STREAM_CAPACITY = 3000;

/** Node filter value that follows the node chosen above, whichever it is at each moment. */
export const SELECTED_NODE_FILTER = "selected";
/** Node filter value that keeps the lines of every connection. */
export const ALL_NODES_FILTER = "all";

export type StreamKindFilter =
  | "all"
  | "no-debug"
  | "events"
  | "debug"
  | "command"
  | "notice"
  | "unrecognized"
  | ConsoleEventName;

export function matchesStreamFilters(
  record: ConsoleRecord,
  nodeFilter: string,
  kindFilter: StreamKindFilter,
  selectedKey: string | null,
): boolean {
  if (nodeFilter === SELECTED_NODE_FILTER) {
    if (record.connectionKey !== selectedKey) {
      return false;
    }
  } else if (nodeFilter !== ALL_NODES_FILTER && record.connectionKey !== nodeFilter) {
    return false;
  }
  switch (kindFilter) {
    case "all":
      return true;
    case "no-debug":
      return record.kind !== "debug";
    case "events":
      return record.kind === "event";
    case "debug":
    case "command":
    case "notice":
    case "unrecognized":
      return record.kind === kindFilter;
    default:
      return record.kind === "event" && record.event.ev === kindFilter;
  }
}

export class EventStream {
  /** Every line kept, oldest first. */
  records = $state.raw<readonly ConsoleRecord[]>([]);
  /** The lines that pass the filters, oldest first; empty while the view is hidden. */
  matching = $state.raw<readonly ConsoleRecord[]>([]);

  readonly #log = new BoundedLog<ConsoleRecord>(STREAM_CAPACITY);
  #nodeFilter = $state(ALL_NODES_FILTER);
  #kindFilter = $state<StreamKindFilter>("all");
  #selectedKey: string | null = null;
  #visible = false;

  /** A connection key, ALL_NODES_FILTER or SELECTED_NODE_FILTER. */
  get nodeFilter(): string {
    return this.#nodeFilter;
  }

  set nodeFilter(value: string) {
    this.#nodeFilter = value;
    this.#filter();
  }

  get kindFilter(): StreamKindFilter {
    return this.#kindFilter;
  }

  set kindFilter(value: StreamKindFilter) {
    this.#kindFilter = value;
    this.#filter();
  }

  append(record: ConsoleRecord): void {
    this.#log.append(record);
  }

  clear(): void {
    this.#log.clear();
  }

  /** Publishes the lines; filters them when the view is visible. */
  publish(selectedKey: string | null, visible: boolean): void {
    this.records = this.#log.toArray();
    this.#selectedKey = selectedKey;
    this.#visible = visible;
    this.#filter();
  }

  #filter(): void {
    const nodeFilter = this.#nodeFilter;
    const kindFilter = this.#kindFilter;
    const selectedKey = this.#selectedKey;
    this.matching = this.#visible
      ? this.records.filter((record) =>
          matchesStreamFilters(record, nodeFilter, kindFilter, selectedKey),
        )
      : [];
  }
}

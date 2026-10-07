/**
 * Every event received from the nodes since the operator last cleared the journal, kept for the
 * export. Debug text is not kept: events.jsonl holds events only.
 */
import type { BoardModel, NodeIdentifier } from "$lib/console/console-event.ts";
import type { ExportedEvent, ParticipatingNode } from "./measurement-export.ts";

/** Enough for long campaigns; past it the journal stops recording and says so. */
export const DEFAULT_JOURNAL_CAPACITY = 250_000;

interface JournalEntry {
  readonly connectionKey: string;
  readonly text: string;
  readonly object: object;
  readonly hostTime: number;
}

interface NodeAssignment {
  readonly id: NodeIdentifier;
  readonly model: BoardModel | null;
}

export class EventJournal {
  readonly #capacity: number;
  #entries: JournalEntry[] = [];
  readonly #assignments = new Map<string, NodeAssignment>();
  #rejectedCount = 0;

  constructor(capacity = DEFAULT_JOURNAL_CAPACITY) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#entries.length;
  }

  /** Events that arrived after the journal was full. */
  get rejectedCount(): number {
    return this.#rejectedCount;
  }

  get firstHostTime(): number | null {
    return this.#entries[0]?.hostTime ?? null;
  }

  /** Records one event line of connection `connectionKey`; returns false when the journal is full. */
  append(connectionKey: string, text: string, object: object, hostTime: number): boolean {
    if (this.#entries.length >= this.#capacity) {
      this.#rejectedCount += 1;
      return false;
    }
    this.#entries.push({ connectionKey, text, object, hostTime });
    return true;
  }

  /** Records the node behind a connection; it applies to the events already recorded too. */
  assignNode(connectionKey: string, id: NodeIdentifier, model: BoardModel | null): void {
    this.#assignments.set(connectionKey, { id, model });
  }

  /** Nodes whose consoles contributed events, one entry per identifier. */
  participatingNodes(): ParticipatingNode[] {
    const nodes = new Map<NodeIdentifier, ParticipatingNode>();
    const keys = new Set(this.#entries.map((entry) => entry.connectionKey));
    for (const key of keys) {
      const assignment = this.#assignments.get(key);
      if (assignment !== undefined) {
        const known = nodes.get(assignment.id);
        nodes.set(assignment.id, {
          id: assignment.id,
          model: assignment.model ?? known?.model ?? null,
        });
      }
    }
    return [...nodes.values()].sort((first, second) => first.id.localeCompare(second.id));
  }

  /** Events in arrival order; with `nodes`, only those of the nodes listed. */
  *events(nodes?: ReadonlySet<NodeIdentifier>): Generator<ExportedEvent> {
    for (const entry of this.#entries) {
      const node = this.#assignments.get(entry.connectionKey)?.id ?? null;
      if (nodes !== undefined && (node === null || !nodes.has(node))) {
        continue;
      }
      yield { text: entry.text, object: entry.object, node, hostTime: entry.hostTime };
    }
  }

  clear(): void {
    this.#entries = [];
    this.#rejectedCount = 0;
  }
}

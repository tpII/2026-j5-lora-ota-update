/**
 * Positions where the operator pinned nodes of the connection graph, to copy the physical layout
 * of the boards. They are kept in the local storage of the browser, normalized to the size of the
 * drawing (0 to 1 on each axis), so that they survive reloads and window resizes.
 */
import type { NodeIdentifier } from "$lib/console/console-event.ts";

export interface PinnedPosition {
  /** From 0 (left) to 1 (right). */
  readonly x: number;
  /** From 0 (top) to 1 (bottom). */
  readonly y: number;
}

export type PinnedPositions = ReadonlyMap<NodeIdentifier, PinnedPosition>;

export const GRAPH_PINS_STORAGE_KEY = "j5.connection-graph.pins";

/**
 * The local storage of the browser, or null when the browser denies it: with site data blocked,
 * reading `localStorage` itself throws.
 */
export function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Reads the pins; a missing or damaged entry gives no pins. */
export function loadPinnedPositions(storage: Pick<Storage, "getItem">): PinnedPositions {
  const pins = new Map<NodeIdentifier, PinnedPosition>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(GRAPH_PINS_STORAGE_KEY) ?? "{}");
  } catch {
    return pins;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return pins;
  }
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value === "object" && value !== null) {
      const { x, y } = value as { x?: unknown; y?: unknown };
      if (isUnitNumber(x) && isUnitNumber(y)) {
        pins.set(id, { x, y });
      }
    }
  }
  return pins;
}

/** Writes the pins; a full or unavailable storage only loses them. */
export function savePinnedPositions(
  storage: Pick<Storage, "setItem">,
  pins: PinnedPositions,
): void {
  try {
    storage.setItem(GRAPH_PINS_STORAGE_KEY, JSON.stringify(Object.fromEntries(pins)));
  } catch {
    // Private browsing or a full storage: the pins last until the page closes.
  }
}

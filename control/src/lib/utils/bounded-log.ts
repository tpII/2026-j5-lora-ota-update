/** Keeps the most recent entries up to a capacity, discarding the oldest ones. */
export class BoundedLog<Entry> {
  readonly #capacity: number;
  #entries: Entry[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  append(entry: Entry): void {
    this.#entries.push(entry);
    // Trim in batches, so that appending stays cheap.
    if (this.#entries.length >= this.#capacity * 2) {
      this.#entries = this.#entries.slice(this.#entries.length - this.#capacity);
    }
  }

  /** The retained entries, oldest first. */
  toArray(): Entry[] {
    const excess = this.#entries.length - this.#capacity;
    return excess > 0 ? this.#entries.slice(excess) : [...this.#entries];
  }

  clear(): void {
    this.#entries = [];
  }
}

/** A copy of `items` with `item` appended, without the oldest items beyond `capacity`. */
export function appendBounded<Item>(items: readonly Item[], item: Item, capacity: number): Item[] {
  const result = [...items, item];
  return result.length > capacity ? result.slice(result.length - capacity) : result;
}

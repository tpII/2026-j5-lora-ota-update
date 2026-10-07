/** Keeps the most recent entries up to a capacity, discarding the oldest ones. */
export class BoundedLog<Entry> {
  readonly #capacity: number;
  #entries: Entry[] = [];
  #discardedCount = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return Math.min(this.#entries.length, this.#capacity);
  }

  /** Entries discarded since the log was created or cleared. */
  get discardedCount(): number {
    return this.#discardedCount + Math.max(0, this.#entries.length - this.#capacity);
  }

  append(entry: Entry): void {
    this.#entries.push(entry);
    // Trim in batches, so that appending stays cheap.
    if (this.#entries.length >= this.#capacity * 2) {
      const excess = this.#entries.length - this.#capacity;
      this.#entries = this.#entries.slice(excess);
      this.#discardedCount += excess;
    }
  }

  /** The retained entries, oldest first. */
  toArray(): Entry[] {
    const excess = this.#entries.length - this.#capacity;
    return excess > 0 ? this.#entries.slice(excess) : [...this.#entries];
  }

  clear(): void {
    this.#entries = [];
    this.#discardedCount = 0;
  }
}

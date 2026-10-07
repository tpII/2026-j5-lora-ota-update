/**
 * Source of host time and timers. The domain modules never call Date.now() or setTimeout()
 * directly, so the tests can drive time by hand.
 */
export interface TimeSource {
  /** Milliseconds since 1 January 1970 on the host computer. */
  now(): number;
  /** Calls `callback` once after `delayMilliseconds`; the returned function cancels the call. */
  schedule(callback: () => void, delayMilliseconds: number): () => void;
}

export const SYSTEM_TIME_SOURCE: TimeSource = {
  now: () => Date.now(),
  schedule(callback, delayMilliseconds) {
    const handle = setTimeout(callback, Math.max(0, delayMilliseconds));
    return () => clearTimeout(handle);
  },
};

interface ScheduledCall {
  readonly dueTime: number;
  readonly order: number;
  readonly callback: () => void;
}

/** Time source advanced explicitly, for tests and simulations. */
export class ManualTimeSource implements TimeSource {
  #currentTime: number;
  #nextOrder = 0;
  #pendingCalls: ScheduledCall[] = [];

  constructor(initialTime = 0) {
    this.#currentTime = initialTime;
  }

  now(): number {
    return this.#currentTime;
  }

  schedule(callback: () => void, delayMilliseconds: number): () => void {
    const call: ScheduledCall = {
      dueTime: this.#currentTime + Math.max(0, delayMilliseconds),
      order: this.#nextOrder++,
      callback,
    };
    this.#pendingCalls.push(call);
    return () => {
      this.#pendingCalls = this.#pendingCalls.filter((pending) => pending !== call);
    };
  }

  /** Number of calls scheduled and not yet executed or cancelled. */
  get pendingCallCount(): number {
    return this.#pendingCalls.length;
  }

  /** Moves time forward, executing every call that falls due, in order. */
  advanceBy(milliseconds: number): void {
    const targetTime = this.#currentTime + milliseconds;
    for (;;) {
      const next = this.#takeNextDueCall(targetTime);
      if (next === null) {
        break;
      }
      this.#currentTime = next.dueTime;
      next.callback();
    }
    this.#currentTime = targetTime;
  }

  #takeNextDueCall(limit: number): ScheduledCall | null {
    let next: ScheduledCall | null = null;
    for (const call of this.#pendingCalls) {
      if (call.dueTime > limit) {
        continue;
      }
      if (
        next === null ||
        call.dueTime < next.dueTime ||
        (call.dueTime === next.dueTime && call.order < next.order)
      ) {
        next = call;
      }
    }
    if (next !== null) {
      const taken = next;
      this.#pendingCalls = this.#pendingCalls.filter((call) => call !== taken);
    }
    return next;
  }
}

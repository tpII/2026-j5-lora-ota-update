/** Time source advanced by hand, for the tests and the simulated nodes. */
import { waitWithSchedule, type TimeSource } from "$lib/utils/time-source.ts";

/** Calls advanceUntilSettled() makes at most before it gives up on a promise. */
const MAXIMUM_SETTLING_STEPS = 100_000;

interface ScheduledCall {
  readonly dueTime: number;
  readonly order: number;
  readonly callback: () => void;
}

/** Lets every pending promise continuation and queued task run. */
export function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

  wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return waitWithSchedule(
      (callback, delay) => this.schedule(callback, delay),
      milliseconds,
      signal,
    );
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

  /** Moves time forward to the next scheduled call and executes it; false when there is none. */
  advanceToNextCall(): boolean {
    const nextDueTime = this.#nextDueTime();
    if (nextDueTime === null) {
      return false;
    }
    this.advanceBy(Math.max(0, nextDueTime - this.#currentTime));
    return true;
  }

  /**
   * Waits for `promise`: lets the pending work run and, while the promise waits for a timer, moves
   * time forward to the next scheduled call. Fails when the promise waits for anything else.
   */
  async advanceUntilSettled<Value>(promise: Promise<Value>): Promise<Value> {
    let settled = false;
    const tracked = promise.finally(() => {
      settled = true;
    });
    // The rejection reaches the caller through the returned promise.
    tracked.catch(() => {});
    for (let step = 0; step < MAXIMUM_SETTLING_STEPS; step += 1) {
      await flushAsyncWork();
      if (settled) {
        return tracked;
      }
      const nextDueTime = this.#nextDueTime();
      if (nextDueTime === null) {
        throw new Error("the promise waits for something other than the clock");
      }
      this.advanceBy(nextDueTime - this.#currentTime);
    }
    throw new Error(`the promise did not settle within ${MAXIMUM_SETTLING_STEPS} timer calls`);
  }

  #nextDueTime(): number | null {
    let earliest: number | null = null;
    for (const call of this.#pendingCalls) {
      if (earliest === null || call.dueTime < earliest) {
        earliest = call.dueTime;
      }
    }
    return earliest;
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

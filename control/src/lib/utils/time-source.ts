/**
 * Source of host time and timers. The domain modules never call Date.now() or setTimeout()
 * directly, so the tests can drive time by hand.
 */
export interface TimeSource {
  /** Milliseconds since 1 January 1970 on the host computer. */
  now(): number;
  /** Calls `callback` once after `delayMilliseconds`; the returned function cancels the call. */
  schedule(callback: () => void, delayMilliseconds: number): () => void;
  /** Resolves after `milliseconds`, or as soon as `signal` aborts. */
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

/** A wait built on the `schedule` of a time source, for its implementations. */
export function waitWithSchedule(
  schedule: TimeSource["schedule"],
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    let cancel = (): void => {};
    const finish = (): void => {
      cancel();
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    cancel = schedule(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Calls `callback` every `intervalMilliseconds` through the `schedule` of `timeSource`, until the
 * returned function is called.
 */
export function scheduleRepeatedly(
  timeSource: TimeSource,
  callback: () => void,
  intervalMilliseconds: number,
): () => void {
  let cancel = (): void => {};
  let stopped = false;
  const next = (): void => {
    cancel = timeSource.schedule(() => {
      if (!stopped) {
        next();
        callback();
      }
    }, intervalMilliseconds);
  };
  next();
  return () => {
    stopped = true;
    cancel();
  };
}

function scheduleOnHost(callback: () => void, delayMilliseconds: number): () => void {
  const handle = setTimeout(callback, Math.max(0, delayMilliseconds));
  return () => clearTimeout(handle);
}

export const SYSTEM_TIME_SOURCE: TimeSource = {
  now: () => Date.now(),
  schedule: scheduleOnHost,
  wait: (milliseconds, signal) => waitWithSchedule(scheduleOnHost, milliseconds, signal),
};

/**
 * Measure elapsed time while the local event loop can keep observing it.
 *
 * Date.now() jumps across laptop sleep. A short heartbeat distinguishes that
 * jump from an ordinary long request or retry timer: while the machine is
 * awake, heartbeat samples keep contributing time even when an awaited timer
 * is much longer than the observation gap. When the event loop is suspended,
 * the next sample excludes that one oversized gap. The caller still owns any
 * separate raw wall-clock deadline.
 */
export function createContinuousObservationClock({
  now = Date.now,
  startedAt,
  heartbeatMs = 5_000,
  maximumTickGapMs = 30_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof now !== "function" || !Number.isFinite(startedAt) || startedAt < 0 ||
      !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 ||
      !Number.isSafeInteger(maximumTickGapMs) || maximumTickGapMs < heartbeatMs ||
      typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function") {
    throw new TypeError("the continuous-observation clock dependencies are invalid");
  }

  let lastWallTime = Number(startedAt);
  let observedElapsedMs = 0;
  let excludedGapCount = 0;
  let heartbeatError = null;
  let stopped = false;

  const snapshot = () => Object.freeze({ observedElapsedMs, excludedGapCount });
  const sample = () => {
    const wallTime = Number(now());
    if (!Number.isFinite(wallTime) || wallTime < lastWallTime) {
      throw new TypeError("the continuous-observation clock is invalid");
    }
    const wallElapsedMs = wallTime - lastWallTime;
    if (wallElapsedMs <= maximumTickGapMs) {
      observedElapsedMs += wallElapsedMs;
    } else {
      excludedGapCount += 1;
    }
    lastWallTime = wallTime;
    return snapshot();
  };

  const heartbeat = setIntervalFn(() => {
    try {
      sample();
    } catch (error) {
      // Do not throw from a timer callback. Surface the clock failure at the
      // next runner checkpoint, where normal fail-closed handling can own it.
      heartbeatError ??= error;
    }
  }, heartbeatMs);
  heartbeat?.unref?.();

  return Object.freeze({
    checkpoint() {
      if (heartbeatError) throw heartbeatError;
      return sample();
    },
    stop() {
      if (!stopped) {
        stopped = true;
        clearIntervalFn(heartbeat);
      }
      return snapshot();
    },
  });
}

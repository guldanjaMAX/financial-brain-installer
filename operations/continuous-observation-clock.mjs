/**
 * Measure elapsed time only across intervals the caller could continuously
 * observe.
 *
 * Date.now() jumps across laptop sleep. That jump is useful for a hard
 * wall-clock deadline, but it is not proof that a polled remote operation sat
 * awake without progress. Call checkpoint() before and after each bounded
 * asynchronous interval. A gap beyond that interval's declared observation
 * bound contributes no elapsed time, so the caller must collect fresh awake
 * evidence before declaring a stall.
 */
export function createContinuousObservationClock({
  now = Date.now,
  startedAt,
  maximumGapMs,
} = {}) {
  if (typeof now !== "function" || !Number.isFinite(startedAt) || startedAt < 0 ||
      !Number.isSafeInteger(maximumGapMs) || maximumGapMs < 1) {
    throw new TypeError("the continuous-observation clock dependencies are invalid");
  }

  let lastWallTime = Number(startedAt);
  let observedElapsedMs = 0;
  let excludedGapCount = 0;

  return Object.freeze({
    checkpoint(intervalMaximumMs = maximumGapMs) {
      if (!Number.isSafeInteger(intervalMaximumMs) || intervalMaximumMs < 1) {
        throw new TypeError("the continuous-observation interval is invalid");
      }
      const wallTime = Number(now());
      if (!Number.isFinite(wallTime) || wallTime < lastWallTime) {
        throw new TypeError("the continuous-observation clock is invalid");
      }
      const wallElapsedMs = wallTime - lastWallTime;
      if (wallElapsedMs <= intervalMaximumMs) {
        observedElapsedMs += wallElapsedMs;
      } else {
        excludedGapCount += 1;
      }
      lastWallTime = wallTime;
      return Object.freeze({ observedElapsedMs, excludedGapCount });
    },
  });
}

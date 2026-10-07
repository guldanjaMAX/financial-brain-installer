/**
 * Local wall time includes host scheduling and is not a D1 cost measurement.
 * Query shape, statement size, exact rows and memory growth carry the cost
 * proof. Keep a generous finite ceiling solely to detect lost liveness.
 */
export function fieldRecoveryMsBound() {
  return 30_000;
}

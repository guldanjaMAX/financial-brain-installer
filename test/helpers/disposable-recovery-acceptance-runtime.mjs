let nextRetainedRecensusTransition = null;

function testContext() {
  if (process.env.NODE_TEST_CONTEXT !== "child-v8") {
    throw new Error("TEST_ACCEPTANCE_RUNTIME_INVALID");
  }
}

/** Register one synchronous mutation at the final retained-evidence recensus. */
export function registerNextTestDisposableRecoveryRetainedRecensusTransition(
  transition,
) {
  testContext();
  if (nextRetainedRecensusTransition !== null ||
      typeof transition !== "function") {
    throw new Error("TEST_ACCEPTANCE_RUNTIME_INVALID");
  }
  nextRetainedRecensusTransition = transition;
  return true;
}

export function readNextTestDisposableRecoveryRetainedRecensusTransition() {
  testContext();
  const transition = nextRetainedRecensusTransition;
  nextRetainedRecensusTransition = null;
  return transition;
}

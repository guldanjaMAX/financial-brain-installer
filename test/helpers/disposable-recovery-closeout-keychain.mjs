const TEST_RUNTIMES = new WeakMap();
let nextTestRuntime = null;

function refuse() {
  throw new Error("TEST_CLOSEOUT_KEYCHAIN_CAPABILITY_INVALID");
}

function testContext() {
  if (process.env.NODE_TEST_CONTEXT !== "child-v8") refuse();
}

/**
 * Register the test-only transport and deterministic transition hooks behind
 * the genuine aggregate evidence capability. Production never receives these
 * dependencies through its public API.
 */
function checkedTestRuntime({
    implementation,
    now = () => new Date("2026-09-13T12:00:00.000Z"),
    onDeletionTransition = async () => {},
    onFinalizationTransition = () => {},
    onAnchorTransition = () => {},
  }) {
  testContext();
  if (!implementation || typeof implementation.inspect !== "function" ||
      typeof implementation.read !== "function" ||
      typeof implementation.delete !== "function" ||
      typeof implementation.sharedTokenPresent !== "function" ||
      typeof now !== "function" || typeof onDeletionTransition !== "function" ||
      typeof onFinalizationTransition !== "function" ||
      typeof onAnchorTransition !== "function") {
    refuse();
  }
  const runtime = Object.freeze({
    implementation: Object.freeze({
      inspect: implementation.inspect,
      read: implementation.read,
      delete: implementation.delete,
      sharedTokenPresent: implementation.sharedTokenPresent,
    }),
    now,
    onDeletionTransition,
    onFinalizationTransition,
    onAnchorTransition,
  });
  return runtime;
}

export function registerTestDisposableRecoveryFieldCloseoutRuntime(
  evidenceCapability,
  options,
) {
  testContext();
  if (!evidenceCapability || typeof evidenceCapability !== "object" ||
      !Object.isFrozen(evidenceCapability)) {
    refuse();
  }
  const runtime = checkedTestRuntime(options);
  TEST_RUNTIMES.set(evidenceCapability, runtime);
  return runtime;
}

/** Bind the next capability minted inside the CLI to one test runtime. */
export function registerNextTestDisposableRecoveryFieldCloseoutRuntime(options) {
  testContext();
  if (nextTestRuntime !== null) refuse();
  nextTestRuntime = checkedTestRuntime(options);
  return nextTestRuntime;
}

export function readTestDisposableRecoveryFieldCloseoutRuntime(
  evidenceCapability,
) {
  testContext();
  const registered = TEST_RUNTIMES.get(evidenceCapability);
  if (registered) return registered;
  if (nextTestRuntime === null) return null;
  const next = nextTestRuntime;
  nextTestRuntime = null;
  TEST_RUNTIMES.set(evidenceCapability, next);
  return next;
}

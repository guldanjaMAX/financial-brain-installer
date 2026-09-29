/*
 * Force one real public CLI command through brain.mjs's unexpected-error path.
 * Restore console output before throwing so the guarded crash handler can
 * explain the failure and print its local support receipt.
 */

const originalLog = console.log.bind(console);
let triggered = false;

console.log = (...args) => {
  if (!triggered) {
    triggered = true;
    console.log = originalLog;
    const error = new Error(process.env.BRAIN_TEST_UNEXPECTED_ERROR || "RAW_UNEXPECTED_CRASH_SENTINEL private diagnostic text");
    if (process.env.BRAIN_TEST_CREDENTIAL_SOURCE) error.credentialSource = process.env.BRAIN_TEST_CREDENTIAL_SOURCE;
    if (process.env.BRAIN_TEST_ERROR_CODE) error.code = process.env.BRAIN_TEST_ERROR_CODE;
    throw error;
  }
  return originalLog(...args);
};

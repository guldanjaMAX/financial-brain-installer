// Reuse the real adapter suite's injected provider without its unrelated
// package-install and locked-runtime ceremonies. No helper is executed.
process.env.BRAIN_RECOVERY_MULTIPART_TEST_ONLY = "1";
await import("./cloudflare-recovery-adapter.test.mjs");

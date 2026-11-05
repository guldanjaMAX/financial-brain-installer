// Test preload: exercise the real 30 s callback without a real stall. When the
// worker arms its unrefed 30 s timer, a referenced peer keeps the loop alive
// until that callback has run, however late module loading arms it.
const schedule = globalThis.setTimeout;
const cancel = globalThis.clearTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  if (ms !== 30000) return schedule(callback, ms, ...args);
  const keepalive = schedule(() => {}, 60000);
  return schedule((...callbackArgs) => {
    try { callback(...callbackArgs); } finally { cancel(keepalive); }
  }, 0, ...args);
};

// Only the support journal's and the lifecycle lock's ACL dependencies are
// replaced. Every other native child remains behind the CLI tripwire,
// including credential helpers.
import { registerHooks } from "node:module";

const journal = new URL("../../support-journal.mjs", import.meta.url).href;
const fixture = new URL("./support-journal-acl.mjs", import.meta.url).href;
const lifecycleLock = new URL("../../operations/brain-lifecycle-lock.mjs", import.meta.url).href;
const lifecycleFixture = new URL("./lifecycle-lock-acl.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === journal && specifier === "./operations/current-user-file.mjs") {
      return { url: fixture, shortCircuit: true };
    }
    if (context.parentURL === lifecycleLock && specifier === "./current-user-file.mjs") {
      return { url: lifecycleFixture, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

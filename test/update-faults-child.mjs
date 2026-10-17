import { createFaultFixture, runFaultUpgrade } from "./update-faults-fixture.mjs";

await runFaultUpgrade(createFaultFixture(process.argv[2]), {
  afterPause: async () => {
    process.stdout.write("PAUSE_APPLIED\n");
    // The parent normally kills us at the marker. Never leave an orphaned
    // fixture alive if its parent fails before sending that signal.
    await new Promise(() => { setTimeout(() => {
      process.stderr.write("NATIVE_TEST_TIMEOUT: waiting for parent SIGKILL after paused upload\n");
      process.exit(1);
    }, 30_000); });
  },
});

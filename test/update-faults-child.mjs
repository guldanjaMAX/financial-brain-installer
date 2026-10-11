import { createFaultFixture, runFaultUpgrade } from "./update-faults-fixture.mjs";

await runFaultUpgrade(createFaultFixture(process.argv[2]), {
  afterPause: async () => {
    process.stdout.write("PAUSE_APPLIED\n");
    await new Promise(() => { setInterval(() => {}, 1_000); });
  },
});

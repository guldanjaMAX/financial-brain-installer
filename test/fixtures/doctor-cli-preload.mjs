// Wrap only the exported dependency seam; the real CLI dispatcher, runAll,
// check functions, streaming renderer, guidance and exit decisions still run.
import { registerHooks } from "node:module";

const doctor = new URL("../../doctor.mjs", import.meta.url).href;
const original = `${doctor}?isolated-doctor-original`;
const dependencies = new URL("./doctor-cli-dependencies.mjs", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== doctor) return nextLoad(url, context);
    return {
      format: "module", shortCircuit: true,
      source: `export * from ${JSON.stringify(original)};
        import { runAll as originalRunAll } from ${JSON.stringify(original)};
        import { doctorDependencies } from ${JSON.stringify(dependencies)};
        export function runAll(options) {
          console.log("TEST_DOCTOR_STAGE:dispatch");
          return originalRunAll({ ...options, ...doctorDependencies() });
        }`,
    };
  },
});

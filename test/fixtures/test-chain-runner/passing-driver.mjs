import { runTestCommands } from "../../../scripts/run-test-chain.mjs";

const result = runTestCommands({
  commands: [
    "node test/fixtures/test-chain-runner/first.mjs",
    "node test/fixtures/test-chain-runner/second.mjs",
  ],
});
if (!result.ok) process.exitCode = 1;

import { appendFileSync } from "node:fs";

export function record(label) {
  const logPath = process.env.BRAIN_TEST_CHAIN_LOG;
  if (!logPath) throw new Error("BRAIN_TEST_CHAIN_LOG is required");
  appendFileSync(logPath, `${label}\n`, "utf8");
}

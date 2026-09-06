import { record } from "./record.mjs";

record("signal-term");
process.kill(process.pid, "SIGTERM");

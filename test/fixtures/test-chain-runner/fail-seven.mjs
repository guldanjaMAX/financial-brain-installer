import { record } from "./record.mjs";

record("fail-seven");
process.exitCode = 7;

import { writeSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { after, beforeEach } from "node:test";

// node:test's in-process timers cannot interrupt synchronous native I/O. This
// independent thread terminates only its own test process, never another job.
export function installNativeTestWatchdog(label, timeoutMs = 180_000) {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { label, timeoutMs }, env: {}, execArgv: [],
  });
  worker.unref();
  const step = name => worker.postMessage(name);
  beforeEach(t => step(t.name));
  after(() => worker.terminate());
  return step;
}

if (!isMainThread && workerData) {
  let timer;
  const arm = step => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      writeSync(2, `NATIVE_TEST_TIMEOUT: ${workerData.label}: ${step}\n`);
      process.kill(process.pid, "SIGKILL");
    }, workerData.timeoutMs);
  };
  parentPort.on("message", arm);
  arm("test startup");
}

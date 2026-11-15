/**
 * A child that terminates itself is reported differently by platform. POSIX
 * reports the signal: status null and signal SIGKILL. Windows TerminateProcess
 * reports exit code 1 and no signal, which is also the code an uncaught
 * exception gives. So exit code 1 proves our own termination only together
 * with the record the child wrote immediately before terminating itself, for
 * that exact process.
 */
export function lostByOwnTermination(result, { platform = process.platform, record = null } = {}) {
  if (!record || !Number.isSafeInteger(result?.pid) || record.pid !== result.pid || result.error) return false;
  return platform === "win32"
    ? result.status === 1 && result.signal === null
    : result.status === null && result.signal === "SIGKILL";
}

/**
 * Source for a child's `loseProcess(reached)`: record our own termination,
 * then terminate. Windows TerminateProcess is asynchronous even for the calling
 * process, so the thread then waits and runs nothing further; a kill that
 * cannot start or never lands exits with a code that is not a termination.
 */
export function ownTerminationSource(recordPath) {
  return `const loseProcess = reached => {
        writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ pid: process.pid, reached }));
        try { process.kill(process.pid, "SIGKILL"); } catch { process.exit(97); }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
        process.exit(98);
      };`;
}

/**
 * Present a host-observed self-kill in the shape a Windows host reports it.
 * On a Windows host the observation already has that shape.
 */
export function windowsExitShape(result) {
  if (process.platform === "win32" || result?.signal !== "SIGKILL" || result.status !== null) return result;
  return { ...result, status: 1, signal: null };
}

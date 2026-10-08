import { createHash } from "node:crypto";

export function assertHostedRunner(environment) {
  if (environment.GITHUB_ACTIONS !== "true" || environment.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("installation requires a disposable GitHub-hosted runner");
  }
}

export function verifyHashRecord(bytes, record, filename) {
  const match = /^([a-f0-9]{64}) {2}(?:dist\/)?([^\r\n/\\]+)\r?\n?$/i.exec(record);
  if (!match || match[2] !== filename || createHash("sha256").update(bytes).digest("hex") !== match[1].toLowerCase()) {
    throw new Error("signed artifact checksum mismatch or malformed checksum record");
  }
}

export function assertExactPaths(actual, expected) {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error("installer inventory differs from the reviewed exact paths");
  }
}

// An install can fail after writing files. Once it is attempted, always run
// the native removal path. A failed preflight must never remove existing data.
export async function runSmoke(host, emit) {
  const phase = async (name) => { emit(`DECISION_REACHED=${name}`); await host[name](); };
  for (const name of ["verifyHash", "verifySignature", "inspectPayload", "assertClean"]) await phase(name);
  let failure;
  try {
    await phase("install");
    await phase("verifyInstalled");
    if (host.bootstrap) await phase("bootstrap");
  } catch (error) { failure = error; }
  try {
    await phase("uninstall");
    await phase("verifyRemoved");
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], `${failure.message}; ${error.message}`) : error;
  }
  if (failure) throw failure;
  emit("BUNDLED_CLI_VERSION_VERIFIED=0 reason=not_bundled");
  emit("INSTALLER_SHELL_SMOKE_PASSED=1");
}

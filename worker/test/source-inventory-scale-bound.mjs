/**
 * Keep the field recovery liveness signal strict unless the test is running on
 * a hosted macOS CI runner, where shared-runner variance needs extra margin.
 */
export function fieldRecoveryMsBound({ platform = process.platform, env = process.env } = {}) {
  const runnerEnvironment = env.RUNNER_ENVIRONMENT;
  const githubHosted = runnerEnvironment === "github-hosted"
    || (
      runnerEnvironment === undefined
      && env.GITHUB_ACTIONS === "true"
      && env.RUNNER_OS === "macOS"
    );
  return platform === "darwin" && githubHosted ? 5_000 : 3_000;
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildNpmCliInvocation,
  resolveNpmCliPath,
} from "../operations/npm-cli-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = join(ROOT, "frontend");
const REVIEWED_BUNDLE = join(ROOT, "worker", "src", "lib", "app-assets.js");

function copyFrontend(source, target) {
  cpSync(source, target, {
    recursive: true,
    filter(path) {
      const local = relative(source, path);
      if (!local) return true;
      const first = local.split(sep, 1)[0];
      return first !== "node_modules" && first !== "dist" && !first.startsWith(".env");
    },
  });
}

function buildEnvironment(sandbox) {
  const home = join(sandbox, "home");
  const cache = join(sandbox, "npm-cache");
  const temporary = join(sandbox, "tmp");
  for (const directory of [home, cache, temporary]) mkdirSync(directory, { recursive: true });
  return {
    PATH: process.env.PATH || "",
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: cache,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    NO_UPDATE_NOTIFIER: "1",
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  };
}

function runBuild(frontend, environment) {
  const npmCli = resolveNpmCliPath();
  const invocation = buildNpmCliInvocation(npmCli, ["--prefix", frontend, "run", "build"]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    encoding: "utf8",
    env: environment,
    shell: invocation.shell,
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
}

test("two consecutive owner-app builds reproduce the reviewed Worker bundle", () => {
  const installedModules = join(FRONTEND, "node_modules");
  assert.equal(existsSync(installedModules), true, "install frontend dependencies before this test");

  const sandbox = mkdtempSync(join(tmpdir(), "brain-frontend-build-"));
  try {
    const frontend = join(sandbox, "frontend");
    const generatedBundle = join(sandbox, "worker", "src", "lib", "app-assets.js");
    copyFrontend(FRONTEND, frontend);
    mkdirSync(dirname(generatedBundle), { recursive: true });
    symlinkSync(installedModules, join(frontend, "node_modules"), process.platform === "win32" ? "junction" : "dir");

    const environment = buildEnvironment(sandbox);
    runBuild(frontend, environment);
    const first = readFileSync(generatedBundle);

    const staleOutput = join(frontend, "dist", "stale-tailwind-input.html");
    writeFileSync(staleOutput, '<div class="resize"></div>\n');
    runBuild(frontend, environment);
    const second = readFileSync(generatedBundle);

    assert.equal(existsSync(staleOutput), false, "prebuild must remove the prior generated tree");
    assert.deepEqual(second, first, "a repeated build must be byte-identical to a clean build");
    assert.deepEqual(second, readFileSync(REVIEWED_BUNDLE),
      "the reviewed Worker asset must match a clean reproducible build");
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

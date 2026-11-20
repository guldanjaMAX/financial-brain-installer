import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildNpmCliInvocation,
  resolveNpmCliPath,
} from "../operations/npm-cli-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = join(ROOT, "frontend");
const REVIEWED_BUNDLE = join(ROOT, "worker", "src", "lib", "app-assets.js");
// A freshly installed dependency tree can spend most of its first build in
// host file validation, especially on macOS. Keep the byte-for-byte assertions
// strict while allowing that cold start to finish under a loaded review host.
const BUILD_TIMEOUT_MS = 300_000;

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
  // The app shares the Worker's evidence and confidence formatters. Preserve
  // their dependency closure so this fixture checks the ordinary build source.
  const shared = join(dirname(target), "worker", "src", "lib");
  mkdirSync(shared, { recursive: true });
  for (const name of ["owner-evidence.js", "confidence.js", "evidence-lineage.js", "document-answer-reading.js", "answer-sentences.js", "quickbooks-label.js",
    // 0.4.28 provenance reading adds this pure-JS dependency closure.
    "document-answer-provenance.js", "document-answer-context.js", "evidence-authority.js", "query-intent.js", "tax-evidence-scope.js",
    // 0.4.30 Microsoft retained status (confidence.js) adds this closure.
    "microsoft-retained-status.js", "grants.js", "core.js", "query-timing.js"]) {
    cpSync(join(dirname(source), "worker", "src", "lib", name), join(shared, name));
  }
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
    timeout: BUILD_TIMEOUT_MS,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
}

test("isolated frontend fixture retains shared answer rendering modules", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-frontend-import-"));
  try {
    const frontend = join(sandbox, "frontend");
    copyFrontend(FRONTEND, frontend);
    const render = await import(pathToFileURL(join(frontend, "src", "lib", "answer-render.js")));
    const response = { answer: "$42.00 for October 2026.", answer_contract: { version: 1, kind: "ledger" },
      confidence: { percent: 69, basis: ["A payment remains unmatched."], missing: ["The receiving statement."] } };
    assert.equal(render.answerText(response), response.answer);
    assert.equal(render.confidenceText(response), "Confidence: Low (69%). Why: A payment remains unmatched. Missing: The receiving statement.");
    // The isolated fixture must exercise owner presentation and retain the
    // internal formatter used by guards, rather than merely import successfully.
    const before = structuredClone(response);
    assert.equal(render.answerText({ ...response, answer: response.answer + "\nConfidence: Low (69%)" }),
      response.answer + "\n");
    const evidence = render.evidenceNoteText(response);
    assert.match(evidence, /A payment remains unmatched/);
    assert.match(evidence, /Still needed: The receiving statement/);
    assert.doesNotMatch(evidence, /Confidence:|\b(?:High|Medium|Low)\b|\d+%/);
    assert.deepEqual(response, before, "presentation leaves the internal score and evidence unchanged");
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("two consecutive owner-app builds reproduce the reviewed Worker bundle", () => {
  const installedModules = join(FRONTEND, "node_modules");
  assert.equal(existsSync(installedModules), true, "install frontend dependencies before this test");

  const sandbox = mkdtempSync(join(tmpdir(), "brain-frontend-build-"));
  try {
    const frontend = join(sandbox, "frontend");
    const generatedBundle = join(sandbox, "worker", "src", "lib", "app-assets.js");
    copyFrontend(FRONTEND, frontend);
    mkdirSync(dirname(generatedBundle), { recursive: true });
    // Vite writes .vite-temp beside the installed packages. Link packages
    // individually so build caches never write into a shared dependency tree.
    const fixtureModules = join(frontend, "node_modules");
    mkdirSync(fixtureModules);
    for (const entry of readdirSync(installedModules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".vite")) continue;
      symlinkSync(join(installedModules, entry.name), join(fixtureModules, entry.name),
        process.platform === "win32" ? "junction" : "dir");
    }

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

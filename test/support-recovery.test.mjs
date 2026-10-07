import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { supportErrorCode } from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { SUPPORT_ERROR_CODES } from "../support-journal.mjs";
import {
  SUPPORT_RECOVERY_CATALOG,
  renderSupportRecovery,
  supportRecovery,
} from "../support-recovery.mjs";
import {
  HICCUP_SCENARIOS,
  hiccupLabEnvironment,
  hiccupLabPlan,
  runHiccupLab,
} from "../scripts/customer-hiccup-lab.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function safeCliEnvironment() {
  return hiccupLabEnvironment(process.env);
}

test("every stored issue code has one complete human recovery guide", () => {
  assert.deepEqual(Object.keys(SUPPORT_RECOVERY_CATALOG).sort(), [...SUPPORT_ERROR_CODES].sort());
  for (const code of SUPPORT_ERROR_CODES) {
    const recovery = supportRecovery(code.toLowerCase());
    assert.equal(recovery.code, code);
    assert.ok(recovery.title.length >= 8);
    assert.ok(recovery.what_happened.length >= 20);
    assert.ok(recovery.protection.length >= 20);
    assert.ok(["safe_now", "safe_after_step", "review_first"].includes(recovery.retry));
    assert.ok(recovery.next_steps.length >= 2);
    assert.ok(recovery.technician_when.length >= 20);
    const rendered = renderSupportRecovery(recovery);
    for (const label of ["What happened:", "What stayed protected:", "Safe to retry:", "Next step:", "A technician can help when:"]) {
      assert.match(rendered, new RegExp(label));
    }
    assert.doesNotMatch(rendered, /\b(?:never|do not|don't|must)\b/i, `${code} uses command-like public language`);
  }
});

test("index recovery guidance tells the owner to leave active catch-up alone", () => {
  for (const code of ["INDEX_WRITE_FAILED", "VECTOR_DRAIN_FAILED"]) {
    const recovery = supportRecovery(code);
    assert.equal(recovery.retry, "review_first");
    const rendered = renderCliCommands(renderSupportRecovery(recovery));
    assert.match(rendered, /Search is still catching up/);
    assert.match(rendered, /New documents are saved and can already be found by their exact words/);
    assert.match(rendered, /Leave the Brain alone; it catches up fastest when nothing else is running/);
    assert.ok(rendered.includes(renderCliCommands("Check later with brain health.")));
    assert.ok(!rendered.includes(renderCliCommands("brain drain")));
  }
  // An update-paused Brain cannot drain on its own, so the drain guide names
  // the one exception to leaving it alone, in the runnable command form.
  const drain = supportRecovery("VECTOR_DRAIN_FAILED");
  assert.deepEqual([...drain.next_steps], [
    "Leave the Brain alone; it catches up fastest when nothing else is running.",
    "Check later with brain health. If brain health says the Brain is paused for an update, run brain update once more.",
  ]);
  const renderedDrain = renderCliCommands(renderSupportRecovery(drain));
  assert.ok(renderedDrain.includes(renderCliCommands(
    "  2. Check later with brain health. If brain health says the Brain is paused for an update, run brain update once more.",
  )));
});

test("a typed product issue code wins over mutable error wording", () => {
  const error = new Error("provider wording that may change tomorrow");
  error.code = "RATE_LIMITED";
  assert.equal(supportErrorCode(error, { command: "ingest", unexpected: true }), "RATE_LIMITED");
  error.code = "not-a-public-code";
  assert.equal(supportErrorCode(error, { command: "health" }), "HEALTH_CHECK_FAILED");
});

test("Cloudflare inactive-token recovery names the date fix", () => {
  const rendered = renderCliCommands(renderSupportRecovery(supportRecovery("CLOUDFLARE_TOKEN_NOT_ACTIVE")));
  assert.match(rendered, /start date/i);
  assert.match(rendered, /end date/i);
  assert.ok(rendered.includes(renderCliCommands("brain token <manifest> --forget")));
});

test("the installed CLI explains a code in calm text or agent-readable JSON", () => {
  const text = spawnSync(process.execPath, [join(ROOT, "brain.mjs"), "support", "--explain", "AUTH_REQUIRED"], {
    cwd: ROOT,
    env: safeCliEnvironment(),
    encoding: "utf8",
  });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /AUTH_REQUIRED · A sign-in or credential is still needed/);
  assert.match(text.stdout, /Safe to retry:/);
  assert.doesNotMatch(text.stdout, /\b(?:never|do not|don't|must)\b/i);

  const json = spawnSync(process.execPath, [join(ROOT, "brain.mjs"), "support", "--explain", "rate_limited", "--json"], {
    cwd: ROOT,
    env: safeCliEnvironment(),
    encoding: "utf8",
  });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.code, "RATE_LIMITED");
  assert.equal(parsed.retry, "safe_now");
  assert.equal(Object.hasOwn(parsed, "message"), false);
});

test("a configuration failure skips the redundant support tail", () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), "brain-recovery-cli-"));
  try {
    const result = spawnSync(process.execPath, [join(ROOT, "brain.mjs"), "status", join(isolatedHome, "missing.json")], {
      cwd: ROOT,
      env: { ...safeCliEnvironment(), HOME: isolatedHome, USERPROFILE: isolatedHome },
      encoding: "utf8",
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 1);
    assert.doesNotMatch(output, /Issue code: CONFIG_INVALID/);
    assert.ok(!output.includes(renderCliCommands("brain support --explain CONFIG_INVALID")));
    assert.doesNotMatch(output, /\bat .*\.mjs:\d+/);
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("COMMAND_FAILED gives one concrete owner recovery", () => {
  const rendered = renderSupportRecovery(supportRecovery("COMMAND_FAILED"));
  assert.match(rendered, /The command stopped before it finished/);
  assert.match(rendered, /Something named in the red line needs fixing first/);
  assert.match(rendered, /Nothing that already finished was undone/);
  assert.match(rendered, /Fix that one thing, then run the same command again/);
});

test("every literal issue code printed by the CLI has a recovery guide", () => {
  const files = [
    join(ROOT, "brain.mjs"),
    join(ROOT, "doctor.mjs"),
    ...readdirSync(join(ROOT, "operations"))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => join(ROOT, "operations", name)),
  ];
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  const printed = new Set();
  for (const pattern of [
    /issue_code\s*:\s*["']([A-Z][A-Z0-9_]+)["']/g,
    /issue_code\s*\|\|\s*["']([A-Z][A-Z0-9_]+)["']/g,
    /Issue code:[^\n]*["']([A-Z][A-Z0-9_]+)["']/g,
  ]) {
    for (const match of source.matchAll(pattern)) printed.add(match[1]);
  }
  assert.ok(printed.size >= 30, `only ${printed.size} printed issue codes were derived`);
  assert.deepEqual([...printed].filter((code) => !SUPPORT_RECOVERY_CATALOG[code]), []);
});

test("Windows helper launch refusal has calm retry guidance", () => {
  const rendered = renderSupportRecovery(supportRecovery("WINDOWS_DPAPI_LAUNCH_REFUSED"));
  assert.match(rendered, /Windows briefly blocked a helper/);
  assert.match(rendered, /Your keys are safe and nothing changed/);
  assert.match(rendered, /usually works the second time/);
});

test("admin key mismatch recovery gives the setup then health sequence", () => {
  const rendered = renderCliCommands(renderSupportRecovery(supportRecovery("ADMIN_KEY_MISMATCH")));
  assert.match(rendered, /didn't accept this computer's key after 15 tries/);
  assert.match(rendered, /documents are safe and nothing changed/);
  assert.ok(rendered.includes(renderCliCommands("brain setup <manifest>")));
  assert.ok(rendered.includes(renderCliCommands("brain health")));
});

test("an unknown explain code is an anticipated Fatal", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "brain.mjs"), "support", "--explain", "NOT_A_REAL_CODE"], {
    cwd: ROOT,
    env: safeCliEnvironment(),
    encoding: "utf8",
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.equal(result.status, 1);
  assert.match(output, /There isn't a guide for NOT_A_REAL_CODE yet/);
  assert.match(output, /Nothing changed/);
  assert.match(output, /run the command that printed it once more/i);
  assert.doesNotMatch(output, /bug in the installer|unexpected error/i);
});

test("the hiccup lab is offline, credential-scrubbed, and names every remaining field gate", () => {
  const plan = hiccupLabPlan();
  assert.equal(plan.mode, "offline_synthetic_rehearsal");
  assert.equal(plan.live_accounts_contacted, false);
  assert.equal(plan.customer_data_read, false);
  assert.deepEqual(plan.scenarios.map((item) => item.id), HICCUP_SCENARIOS.map((item) => item.id));
  assert.ok(plan.scenarios.length >= 8);
  for (const item of plan.scenarios) {
    assert.ok(item.tests.length >= 2);
    assert.ok(item.remaining_field_gate.length >= 40);
    for (const relativeTest of item.tests) assert.equal(existsSync(join(ROOT, relativeTest)), true, relativeTest);
  }

  const clean = hiccupLabEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    LANG: "en_US.UTF-8",
    CLOUDFLARE_API_TOKEN: "fixture-secret",
    GOOGLE_CLIENT_SECRET: "fixture-secret",
    ZOOM_CLIENT_SECRET: "fixture-secret",
    ANTHROPIC_API_KEY: "fixture-secret",
  });
  assert.deepEqual(clean, {
    BRAIN_HICCUP_LAB: "1",
    CI: "1",
    NO_COLOR: "1",
    PATH: "/safe/bin",
    HOME: "/safe/home",
    LANG: "en_US.UTF-8",
  });
  assert.doesNotMatch(JSON.stringify(clean), /fixture-secret|TOKEN|CLIENT_SECRET|API_KEY/);
});

test("the hiccup runner reports a clean pass and a useful isolated failure", () => {
  const calls = [];
  const output = [];
  const passed = runHiccupLab({
    only: "folder-safety",
    spawn: (node, args, options) => {
      calls.push({ node, args, options });
      return { status: 0, stdout: "synthetic pass", stderr: "" };
    },
    environment: { PATH: "/safe/bin", CLOUDFLARE_API_TOKEN: "ambient-secret" },
    write: (line) => output.push(line),
  });
  assert.equal(passed.ok, true);
  assert.equal(passed.passed, 1);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((call) => call.options.env.CLOUDFLARE_API_TOKEN === undefined));
  assert.match(output.join("\n"), /All 1 offline hiccup rehearsals passed/);
  assert.match(output.join("\n"), /The owner should unplug or rename one approved test folder/);

  const failed = runHiccupLab({
    only: "setup-retry",
    spawn: () => ({ status: 1, stdout: "fixture assertion failed", stderr: "" }),
    write: () => {},
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.results[0].diagnostic, "fixture assertion failed");
  assert.match(failed.results[0].remaining_field_gate, /real Cloudflare/i);
});

// An account with no registered workers.dev subdomain has its own code. It
// used to be recorded as REMOTE_NOT_FOUND, whose guidance says to wait for
// propagation, which never registers a subdomain.
test("an unregistered workers.dev subdomain explains how to register one and rerun", () => {
  assert.ok(SUPPORT_ERROR_CODES.includes("CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED"));
  const recovery = supportRecovery("CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED");
  const rendered = renderCliCommands(renderSupportRecovery(recovery));
  assert.match(rendered, /Workers & Pages/);
  assert.match(rendered, /register a workers\.dev subdomain/i);
  assert.doesNotMatch(rendered, /propagation/i);
  assert.ok(rendered.includes(renderCliCommands("brain setup")),
    "the rerun command must go through the command renderer");
  const error = new Error("provider wording that may change tomorrow");
  error.code = "CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED";
  assert.equal(supportErrorCode(error, { command: "setup" }), "CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED");
});


test("callback timeout recovery is distinct from connectivity and installer defects", () => {
  const error = Object.assign(new Error("fixture"), { supportCode: "OAUTH_SIGN_IN_TIMEOUT" });
  assert.equal(supportErrorCode(error, { command: "connect" }), "OAUTH_SIGN_IN_TIMEOUT");
  const guide = supportRecovery("OAUTH_SIGN_IN_TIMEOUT");
  assert.equal(guide.retry, "safe_now");
  assert.match(guide.protection, /Nothing changed/);
  assert.match(guide.next_steps.join(" "), /same command again/);
  assert.equal(supportErrorCode(new Error("fixture"), { unexpected: true }), "INTERNAL_ERROR");
});

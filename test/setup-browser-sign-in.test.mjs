import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { confirmWorkersPaidForSetup } from "../brain.mjs";

const ACCOUNT = "a".repeat(32);

test("Workers Paid confirmation is bound to the exact verified account", async () => {
  const lines = [];
  const receipt = await confirmWorkersPaidForSetup(
    { id: ACCOUNT, name: "Owner account" },
    { confirmed: true, interactive: false, write: (line) => lines.push(line) },
  );
  assert.deepEqual(receipt, {
    account_id: ACCOUNT,
    confirmed: true,
    source: "owner_flag",
  });
  assert.match(lines.join("\n"), /Owner account/);
  assert.match(lines.join("\n"), /No billing setting was changed/i);
});

test("an agent shell cannot infer or silently supply billing confirmation", async () => {
  await assert.rejects(
    confirmWorkersPaidForSetup(
      { id: ACCOUNT, name: "Owner account" },
      { interactive: false, write: () => undefined },
    ),
    (error) => error?.code === "WORKERS_PAID_CONFIRMATION_REQUIRED" &&
      /No Brain or Cloudflare resources were created/i.test(error.message) &&
      /local browser sign-in may remain saved for retry/i.test(error.message),
  );
});

test("an owner-controlled terminal can confirm after exact account selection", async () => {
  let prompts = 0;
  const receipt = await confirmWorkersPaidForSetup(
    { id: ACCOUNT, name: "Owner account" },
    {
      interactive: true,
      askFn: async () => { prompts += 1; return "yes"; },
      write: () => undefined,
    },
  );
  assert.equal(prompts, 1);
  assert.equal(receipt.source, "owner_prompt");
});

test("Claude-guided fresh browser sign-in refuses incomplete owner context before preflight", () => {
  const sandbox = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "fb-browser-consent-")));
  try {
    const brain = resolve(new URL("../brain.mjs", import.meta.url).pathname);
    const result = spawnSync(process.execPath, [
      brain,
      "setup",
      join(sandbox, "brain.manifest.json"),
      "--browser-sign-in",
    ], {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        HOME: sandbox,
        USERPROFILE: sandbox,
        LOCALAPPDATA: sandbox,
      },
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 1);
    assert.match(output, /needs the owner's reviewed non-secret choices/i);
    assert.match(output, /--name/);
    assert.match(output, /--slug/);
    assert.match(output, /--cloudflare-account-id/);
    assert.match(output, /--workers-paid-confirmed/);
    assert.match(output, /Nothing was changed/i);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("explicit browser sign-in cannot silently fall back to an inherited automation token", () => {
  const sandbox = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "fb-browser-token-conflict-")));
  try {
    const brain = resolve(new URL("../brain.mjs", import.meta.url).pathname);
    const manifest = join(sandbox, "brain.manifest.json");
    const result = spawnSync(process.execPath, [
      brain,
      "setup",
      manifest,
      "--browser-sign-in",
      "--name",
      "Owner Brain",
      "--slug",
      "owner-brain",
      "--cloudflare-account",
      "existing",
      "--cloudflare-account-id",
      ACCOUNT,
      "--workers-paid-confirmed",
    ], {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        HOME: sandbox,
        USERPROFILE: sandbox,
        LOCALAPPDATA: sandbox,
        CLOUDFLARE_API_TOKEN: "fixture-automation-token",
      },
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 1);
    assert.match(output, /browser sign-in was requested/i);
    assert.match(output, /also supplied recovery-token access/i);
    assert.match(output, /confirmations cannot be bypassed/i);
    assert.match(output, /Nothing was changed/i);
    assert.equal(existsSync(manifest), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Claude-guided setup rejects an unsafe slug before browser sign-in", () => {
  const sandbox = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "fb-browser-name-")));
  try {
    const brain = resolve(new URL("../brain.mjs", import.meta.url).pathname);
    const manifest = join(sandbox, "brain.manifest.json");
    const result = spawnSync(process.execPath, [
      brain,
      "setup",
      manifest,
      "--browser-sign-in",
      "--name",
      "Owner Brain",
      "--slug",
      "Owner Brain",
      "--cloudflare-account",
      "existing",
      "--cloudflare-account-id",
      ACCOUNT,
      "--workers-paid-confirmed",
    ], {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        HOME: sandbox,
        USERPROFILE: sandbox,
        LOCALAPPDATA: sandbox,
      },
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 1);
    assert.match(output, /--slug must be 2 to 41 lowercase/i);
    assert.equal(existsSync(manifest), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

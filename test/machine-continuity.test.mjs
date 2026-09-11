import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  cmdMachineContinuity,
  runCliCommandWithCredentialBoundary,
} from "../brain.mjs";
import {
  MACHINE_CONTINUITY_STATUSES,
  assertMachineContinuityPrivacy,
  auditMachineContinuity,
} from "../operations/machine-continuity.mjs";

const PRODUCT_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;
const PACKAGED_CLI = resolve(dirname(fileURLToPath(new URL("../brain.mjs", import.meta.url))), "brain.mjs");
const CUSTOMER_NAME = "Extremely Private Customer Name";
const CUSTOMER_SLUG = "extremely-private-customer";
const CUSTOMER_DOMAIN = "extremely-private-customer.example.invalid";
const CUSTOMER_SOURCE = "private_customer_documents";
const ACCOUNT_ID = "a".repeat(32);
const D1_ID = "11111111-2222-4333-8444-555555555555";
const VECTOR_INDEX = "private-customer-vector-index";
const OWNER_KEY = "owner-secret-that-must-never-appear";
const LOCAL_CURSOR = "opaque-local-cursor-that-must-never-appear";
const REMOTE_CURSOR = "opaque-remote-cursor-that-must-never-appear";
const AMBIENT_ADMIN = "ambient-admin-key-must-not-be-used";
const AMBIENT_STORE = "file";

function manifestFor(root) {
  return {
    manifest_version: 1,
    client: { slug: CUSTOMER_SLUG, display_name: CUSTOMER_NAME },
    brain: {
      version: PRODUCT_VERSION,
      domain: CUSTOMER_DOMAIN,
      worker_name: `${CUSTOMER_SLUG}-brain`,
    },
    infrastructure: {
      cloudflare: {
        account_id: ACCOUNT_ID,
        storage: "d1",
        d1_database_id: D1_ID,
        vectorize_index: VECTOR_INDEX,
      },
    },
    corpora: {
      google_drive: { enabled: true, root_folder_ids: ["raw-drive-folder-id"] },
      slack: { enabled: true, source: "private_customer_slack" },
      local_folder: { enabled: true, path: root, source: CUSTOMER_SOURCE },
    },
    operations: {
      admin_key_secret: "keychain://private-customer-owner/private-account",
      google_token_store: "auto",
      provider_token_stores: { slack: "auto" },
      ingest_cron: "0 9 * * *",
      folder_ingest_cron: "0 * * * *",
      provider_crons: { slack: "15 2 * * *" },
    },
  };
}

function assistantPlan(codexStatus = "not_installed") {
  return {
    items: [
      { scope: "technician-skill", status: "ready" },
      { scope: "claude-code-mcp", status: "ready", protocol_discovery_verified: true },
      {
        scope: "codex-mcp",
        status: codexStatus,
        protocol_discovery_verified: ["ready", "repairable"].includes(codexStatus),
      },
    ],
  };
}

function remoteInventory() {
  return {
    complete: true,
    sources: [
      {
        source_id: "drive",
        registered: true,
        configuration: { cursor: { status: "present", masked: true, value: REMOTE_CURSOR } },
      },
      {
        source_id: "private_customer_slack",
        registered: true,
        configuration: { cursor: { status: "present", masked: true, value: REMOTE_CURSOR } },
      },
      {
        source_id: CUSTOMER_SOURCE,
        registered: true,
        configuration: { cursor: { status: "present", masked: true, value: REMOTE_CURSOR } },
      },
    ],
  };
}

function tree(root) {
  const entries = [];
  const visit = (folder, prefix = "") => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      const label = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        entries.push({ label: `${label}/`, mode: stat.mode & 0o7777 });
        visit(path, label);
      } else {
        entries.push({ label, mode: stat.mode & 0o7777, bytes: readFileSync(path).toString("hex") });
      }
    }
  };
  visit(root);
  return entries;
}

function assertClosedStatuses(value) {
  const allowed = new Set(MACHINE_CONTINUITY_STATUSES);
  (function visit(item, path = "report") {
    if (Array.isArray(item)) return item.forEach((child, index) => visit(child, `${path}[${index}]`));
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (key === "status") assert.ok(allowed.has(child), `${path}.status was ${child}`);
      visit(child, `${path}.${key}`);
    }
  })(value);
}

async function withFixture(run) {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-machine-continuity-"));
  const root = join(sandbox, "customer-root-private");
  const manifestPath = join(sandbox, "brain.manifest.json");
  try {
    mkdirSync(root, { mode: 0o700 });
    const manifest = manifestFor(root);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(
      join(sandbox, ".brain-ingest-drive.json"),
      JSON.stringify({ version: 1, cursor: LOCAL_CURSOR }) + "\n",
      { mode: 0o600 },
    );
    await run({ sandbox, root, manifestPath, manifest });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("continuity audit is read-only, bounded, closed-status, and strips every private locator", async () => {
  await withFixture(async ({ sandbox, root, manifestPath, manifest }) => {
    const before = tree(sandbox);
    let remoteReads = 0;
    let schedulerReads = 0;
    let ownerReads = 0;
    const oldAdmin = process.env.ADMIN_KEY;
    const oldStore = process.env.BRAIN_GOOGLE_TOKEN_STORE;
    process.env.ADMIN_KEY = AMBIENT_ADMIN;
    process.env.BRAIN_GOOGLE_TOKEN_STORE = AMBIENT_STORE;
    try {
      const report = await auditMachineContinuity({
        manifest,
        manifestPath,
        productVersion: PRODUCT_VERSION,
        assistantPlan: assistantPlan(),
        remoteInventoryLoader: async () => {
          remoteReads += 1;
          return remoteInventory();
        },
        providerConfigurationFingerprint: () => "f".repeat(64),
        options: {
          platform: "darwin",
          now: () => new Date("2026-09-10T17:00:00.000Z"),
          cliExecutablePath: PACKAGED_CLI,
          packagedCliPath: PACKAGED_CLI,
          readInstalledManifest: () => manifestPath,
          resolveAdminKey(path, settings) {
            ownerReads += 1;
            assert.equal(path, manifestPath);
            assert.deepEqual(settings, { ignoreEnvironment: true });
            return OWNER_KEY;
          },
          inspectLocalRoot: (path) => path === root,
          inspectCredentials: () => [
            {
              connector: "google",
              status: "ready",
              evidence: {
                configured: true,
                stored_credential_present: true,
                stored_credential_readable: true,
                credential_record_complete: true,
                configured_scopes_present: true,
                ambient_storage_override_ignored: true,
              },
              next_step: "none",
            },
            {
              connector: "slack",
              status: "ready",
              evidence: {
                configured: true,
                stored_credential_present: true,
                stored_credential_readable: true,
                credential_record_complete: true,
                ambient_storage_override_ignored: true,
              },
              next_step: "none",
            },
          ],
          inspectScheduler: async () => {
            schedulerReads += 1;
            return {
              installed: true,
              loaded: true,
              definitionMatches: true,
              interpreterPresent: true,
              lastExitCode: 0,
              lastRunSucceeded: true,
            };
          },
          inspectFileCheckpoint: () => ({ version: 1, cursor: LOCAL_CURSOR }),
          inspectProviderCheckpoint: () => ({
            present: true,
            readable: true,
            source_configuration_bound: true,
            brain_manifest_bound: false,
          }),
        },
      });
      assert.equal(remoteReads, 1, "the existing authenticated D1 inventory is read once");
      assert.equal(ownerReads, 1, "the durable owner credential is checked once with ambient input disabled");
      assert.equal(schedulerReads, 3, "only the three configured schedulers are inspected");
      assert.equal(report.read_only, true);
      assert.equal(report.status, "unproven");
      assert.equal(report.checks.find((item) => item.check === "installed_cli").status, "ready");
      assert.deepEqual(
        report.checks.find((item) => item.check === "claude_code_mcp").evidence,
        { installed: true, exact_configuration: true, protocol_discovery_ready: true },
      );
      assert.equal(report.checks.find((item) => item.check === "codex_mcp").status, "inapplicable");
      assert.equal(report.checks.find((item) => item.check === "deployed_brain_binding").status, "unproven");
      assert.equal(report.remote_source_history.status, "ready");
      assert.equal(report.resume_checkpoints.length, 3);
      assert.ok(report.resume_checkpoints.every((item) => item.status === "unproven"));
      assert.ok(report.resume_checkpoints.every((item) => item.evidence.exact_cursor_comparison === "unproven"));
      assert.deepEqual(tree(sandbox), before, "the complete fixture tree is byte-for-byte unchanged");
      assertClosedStatuses(report);
      assert.doesNotThrow(() => assertMachineContinuityPrivacy(report));

      const json = JSON.stringify(report);
      for (const privateValue of [
        sandbox,
        root,
        manifestPath,
        CUSTOMER_NAME,
        CUSTOMER_SLUG,
        CUSTOMER_DOMAIN,
        CUSTOMER_SOURCE,
        ACCOUNT_ID,
        D1_ID,
        VECTOR_INDEX,
        OWNER_KEY,
        LOCAL_CURSOR,
        REMOTE_CURSOR,
        AMBIENT_ADMIN,
      ]) {
        assert.doesNotMatch(json, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      assert.deepEqual(report.boundaries, {
        writes_files: false,
        installs_or_updates_software: false,
        changes_brain_records: false,
        changes_sources_or_providers: false,
        refreshes_provider_data: false,
        changes_schedulers: false,
        opens_browser_or_prompts: false,
        reads_cloudflare_control_plane: false,
        checks_passkeys_or_devices: false,
        accepts_ambient_credentials: false,
      });
    } finally {
      if (oldAdmin === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = oldAdmin;
      if (oldStore === undefined) delete process.env.BRAIN_GOOGLE_TOKEN_STORE;
      else process.env.BRAIN_GOOGLE_TOKEN_STORE = oldStore;
    }
  });
});

test("missing continuity pieces stay missing without a live call, prompt, install, or repair", async () => {
  await withFixture(async ({ sandbox, manifestPath, manifest }) => {
    const before = tree(sandbox);
    let remoteCalls = 0;
    const report = await auditMachineContinuity({
      manifest,
      manifestPath,
      productVersion: PRODUCT_VERSION,
      assistantPlan: {
        items: [
          { scope: "technician-skill", status: "repairable" },
          { scope: "claude-code-mcp", status: "repairable" },
          { scope: "codex-mcp", status: "preserved" },
        ],
      },
      remoteInventoryLoader: async () => { remoteCalls += 1; throw new Error("no live fixture"); },
      options: {
        platform: "linux",
        now: () => new Date("2026-09-10T17:01:00.000Z"),
        cliExecutablePath: PACKAGED_CLI,
        packagedCliPath: PACKAGED_CLI,
        readInstalledManifest: () => null,
        resolveAdminKey: () => null,
        inspectLocalRoot: () => false,
        inspectCredentials: () => [
          {
            connector: "google",
            status: "missing",
            evidence: { configured: true, stored_credential_present: false, stored_credential_readable: false },
            next_step: "Reconnect the configured Google scopes on this computer, then rerun the audit.",
          },
        ],
      },
    });
    assert.equal(remoteCalls, 0, "a missing durable credential stops before any network attempt");
    assert.equal(report.status, "missing");
    assert.equal(report.remote_source_history.status, "unproven");
    assert.equal(report.schedulers.length, 3);
    assert.ok(report.schedulers.every((item) => item.status === "inapplicable"));
    assert.match(report.smallest_safe_next_step, /brain update <manifest>/i);
    assert.deepEqual(tree(sandbox), before);
    assertClosedStatuses(report);
  });
});

test("MCP readiness needs explicit protocol proof and package wrappers stay valid", async () => {
  await withFixture(async ({ sandbox, manifestPath, manifest }) => {
    const before = tree(sandbox);
    const report = await auditMachineContinuity({
      manifest,
      manifestPath,
      productVersion: PRODUCT_VERSION,
      assistantPlan: {
        items: [
          { scope: "technician-skill", status: "ready" },
          // A config-only or caller-invented ready status is not an MCP probe.
          { scope: "claude-code-mcp", status: "ready" },
          { scope: "codex-mcp", status: "ready", protocol_discovery_verified: true },
        ],
      },
      options: {
        platform: "linux",
        now: () => new Date("2026-09-10T17:01:30.000Z"),
        cliExecutablePath: join(sandbox, "current-package-wrapper"),
        packagedCliPath: PACKAGED_CLI,
        runningPackageEntrypointVerified: true,
        readInstalledManifest: () => manifestPath,
        resolveAdminKey: () => null,
        inspectLocalRoot: () => false,
        inspectCredentials: () => [],
      },
    });
    const claude = report.checks.find((item) => item.check === "claude_code_mcp");
    const codex = report.checks.find((item) => item.check === "codex_mcp");
    const cli = report.checks.find((item) => item.check === "installed_cli");
    assert.equal(claude.status, "unproven");
    assert.equal(claude.evidence.exact_configuration, true);
    assert.equal(claude.evidence.protocol_discovery_ready, false);
    assert.equal(codex.status, "ready");
    assert.equal(codex.evidence.protocol_discovery_ready, true);
    assert.equal(cli.status, "ready");
    assert.equal(cli.evidence.invocation_bound_to_current_package, true);
    const release = report.checks.find((item) => item.check === "cli_release_integrity");
    assert.equal(release.status, "unproven");
    assert.equal(release.evidence.artifact_receipt_verified, false);
    assert.match(release.next_step, /public release target.*artifact receipt/i);
    assert.deepEqual(tree(sandbox), before);
  });
});

test("oversized local-source scope is reported and inspected only to its hard bound", async () => {
  await withFixture(async ({ sandbox, manifestPath, manifest }) => {
    manifest.corpora.upload = {
      enabled: true,
      folders: Array.from({ length: 40 }, (_, index) => join(sandbox, `private-root-${index + 1}`)),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    const before = tree(sandbox);
    let rootReads = 0;
    let remoteCalls = 0;
    const report = await auditMachineContinuity({
      manifest,
      manifestPath,
      productVersion: PRODUCT_VERSION,
      assistantPlan: assistantPlan(),
      remoteInventoryLoader: async () => { remoteCalls += 1; return remoteInventory(); },
      options: {
        platform: "linux",
        now: () => new Date("2026-09-10T17:01:45.000Z"),
        cliExecutablePath: PACKAGED_CLI,
        packagedCliPath: PACKAGED_CLI,
        readInstalledManifest: () => manifestPath,
        resolveAdminKey: () => null,
        inspectLocalRoot: () => { rootReads += 1; return false; },
        inspectCredentials: () => [],
      },
    });
    const scope = report.checks.find((item) => item.check === "source_configuration_scope");
    assert.equal(scope.status, "missing");
    assert.equal(scope.evidence.configured_local_root_count, 41);
    assert.equal(scope.evidence.audited_local_root_count, 32);
    assert.equal(scope.evidence.within_local_root_limit, false);
    assert.equal(scope.evidence.all_source_names_audited, false);
    assert.equal(report.local_source_roots.length, 32);
    assert.equal(rootReads, 32);
    assert.equal(remoteCalls, 0, "missing saved owner access prevents network use even for an invalid scope");
    assert.deepEqual(tree(sandbox), before);
    assert.doesNotThrow(() => assertMachineContinuityPrivacy(report));
  });
});

test("CLI requires the explicit read-only JSON shape before inspecting anything", async () => {
  let planCalls = 0;
  let remoteCalls = 0;
  const options = {
    buildAssistantPlan: async () => { planCalls += 1; return assistantPlan(); },
    remoteInventoryLoader: async () => { remoteCalls += 1; return remoteInventory(); },
  };
  await assert.rejects(
    cmdMachineContinuity("does-not-exist.json", { ...options, flags: {} }),
    /requires --json/i,
  );
  await assert.rejects(
    cmdMachineContinuity("does-not-exist.json", { ...options, flags: { json: true, apply: true } }),
    /unknown option --apply/i,
  );
  await assert.rejects(
    cmdMachineContinuity("does-not-exist.json", { ...options, flags: { json: "yes" } }),
    /requires --json/i,
  );
  assert.equal(planCalls, 0);
  assert.equal(remoteCalls, 0);
});

test("an npm-style global symlink runs the current package CLI without writing locally", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-machine-wrapper-"));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    const wrapperPath = join(sandbox, "brain");
    const manifest = manifestFor(join(sandbox, "unused-root"));
    manifest.corpora = {};
    delete manifest.operations.admin_key_secret;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    symlinkSync(PACKAGED_CLI, wrapperPath);
    const before = tree(sandbox);
    const child = spawnSync(process.execPath, [wrapperPath, "machine-continuity", manifestPath, "--json"], {
      encoding: "utf8",
      env: {
        HOME: sandbox,
        USER: process.env.USER || "fixture-user",
        PATH: "",
        BRAIN_NO_WRANGLER_LOGIN: "1",
      },
      timeout: 15_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const report = JSON.parse(child.stdout);
    assert.equal(report.checks.find((item) => item.check === "installed_cli").status, "ready");
    assert.equal(report.checks.find((item) => item.check === "installed_cli")
      .evidence.invocation_bound_to_current_package, true);
    assert.equal(report.checks.find((item) => item.check === "cli_release_integrity").status, "unproven");
    assert.deepEqual(tree(sandbox), before, "the successful global-wrapper audit writes no local state");

    const beforeRejected = tree(sandbox);
    const rejected = spawnSync(process.execPath, [wrapperPath, "machine-continuity", manifestPath], {
      encoding: "utf8",
      env: {
        HOME: sandbox,
        USER: process.env.USER || "fixture-user",
        PATH: "",
        BRAIN_NO_WRANGLER_LOGIN: "1",
      },
      timeout: 15_000,
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /requires --json/i);
    assert.deepEqual(tree(sandbox), beforeRejected, "the rejected audit does not create a support journal");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("CLI emits one sanitized report and bypasses Wrangler or Cloudflare credential discovery", async () => {
  await withFixture(async ({ root, manifestPath }) => {
    let wrapperCalls = 0;
    let runCalls = 0;
    await runCliCommandWithCredentialBoundary("machine-continuity", async () => { runCalls += 1; }, {
      withWranglerSession: async () => { wrapperCalls += 1; },
    });
    assert.equal(runCalls, 1);
    assert.equal(wrapperCalls, 0);

    const output = [];
    const original = console.log;
    console.log = (...parts) => output.push(parts.join(" "));
    try {
      const report = await cmdMachineContinuity(manifestPath, {
        flags: { json: true },
        buildAssistantPlan: async () => assistantPlan(),
        remoteInventoryLoader: async () => remoteInventory(),
        resolveAdminKey: (_path, settings) => {
          assert.deepEqual(settings, { ignoreEnvironment: true });
          return OWNER_KEY;
        },
        auditOptions: {
          platform: "darwin",
          now: () => new Date("2026-09-10T17:02:00.000Z"),
          cliExecutablePath: PACKAGED_CLI,
          packagedCliPath: PACKAGED_CLI,
          readInstalledManifest: () => manifestPath,
          inspectLocalRoot: (path) => path === root,
          inspectCredentials: () => [],
          inspectScheduler: async () => ({
            installed: true,
            loaded: true,
            definitionMatches: true,
            interpreterPresent: true,
            lastExitCode: 0,
          }),
          inspectProviderCheckpoint: () => ({
            present: true,
            readable: true,
            source_configuration_bound: true,
            brain_manifest_bound: false,
          }),
        },
      });
      assert.deepEqual(JSON.parse(output.join("\n")), report);
      assert.doesNotMatch(output.join("\n"), new RegExp(OWNER_KEY));
    } finally {
      console.log = original;
    }
  });
});

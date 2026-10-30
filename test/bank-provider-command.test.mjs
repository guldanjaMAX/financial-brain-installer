import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cmdBankProvider,
  cmdCheck,
  parseFlags,
  splitStatements,
  VALUE_FLAGS,
} from "../brain.mjs";
import {
  BANK_PROVIDER_STATE_SQL,
  BankProviderCommandError,
  normalizeBankProviderState,
  runBankProviderCommand,
  validateBankProviderManifest,
} from "../operations/bank-provider-command.mjs";
import { writeManifestAtomically } from "../operations/folder-retirement.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "manifest.schema.json"), "utf8"));
const FIXED_NOW = new Date("2026-10-29T13:00:00.000Z");
const D1_DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const STALE_FIELDS = [
  "api_base",
  "link_sdk_url",
  "link_global",
  "registered_redirect_uris",
  "registered_webhook_uris",
  "country_codes",
  "reconciliation_interval_minutes",
];

function bankState(overrides = {}) {
  return {
    bank_connections: 0,
    simplefin_connections: 0,
    non_simplefin_connections: 0,
    bank_ledger_rows: 0,
    simplefin_ledger_rows: 0,
    non_simplefin_ledger_rows: 0,
    deployed_provider: "plaid",
    transition_target: null,
    transition_ref: null,
    ...overrides,
  };
}

function baseManifest(bankFeed = {}) {
  return {
    manifest_version: 1,
    client: { slug: "test-brain", display_name: "Test Brain" },
    brain: { version: "0.4.20" },
    infrastructure: {
      cloudflare: {
        account_id: "REQUIRED_client_account_id",
        storage: "d1",
        d1_database_id: D1_DATABASE_ID,
      },
    },
    corpora: { bank_feed: bankFeed },
    test_extension: { preserved: ["exact", 7, true] },
  };
}

function fixture(t, value = baseManifest()) {
  const parent = process.env.HOME;
  assert.ok(parent, "the test requires an explicit HOME");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, "bank-provider-test-"));
  const manifestPath = join(directory, "brain.manifest.json");
  const bytes = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(manifestPath, bytes, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, manifestPath };
}

function dependencies(counters, state = bankState()) {
  return {
    schema: SCHEMA,
    now: () => FIXED_NOW,
    readFile(path) {
      counters.reads = (counters.reads || 0) + 1;
      return readFileSync(path);
    },
    readRecoveryFence() {
      counters.recovery += 1;
      return counters.openRecovery ? { transaction_id: "fixture" } : null;
    },
    async inspectBankState() {
      counters.inspections += 1;
      return state;
    },
    async withLifecycle(task) {
      counters.lifecycle += 1;
      return task({ assertOwned() { counters.ownership += 1; return true; } });
    },
    async establishTransition(_manifest, transition) {
      counters.transitionWrites = (counters.transitionWrites || 0) + 1;
      return {
        deployed_provider: state.deployed_provider,
        transition_target: "simplefin",
        transition_ref: transition.transition_ref,
      };
    },
    writeManifest(manifestPath, intended, options) {
      counters.writes += 1;
      return writeManifestAtomically(manifestPath, intended, {
        ...options,
        now: () => FIXED_NOW,
        randomBytes: () => Buffer.alloc(12, 7),
      });
    },
  };
}

function terminalLedgerTables() {
  const database = new DatabaseSync(":memory:");
  try {
    const migrationDirectory = new URL("../migrations/d1/", import.meta.url);
    for (const name of readdirSync(migrationDirectory)
      .filter((candidate) => /^\d{4}_.+\.sql$/u.test(candidate)).sort()) {
      const sql = readFileSync(new URL(name, migrationDirectory), "utf8");
      for (const statement of splitStatements(sql)) database.exec(statement);
    }
    return database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fin_%' ORDER BY name",
    ).all()
      .map(({ name }) => String(name))
      .filter((name) => database.prepare(`PRAGMA table_info(${name})`).all()
        .some((column) => column.name === "source_feed"));
  } finally {
    database.close();
  }
}

function ledgerFamilyDifference(queryTables, schemaTables) {
  const query = new Set(queryTables);
  const schema = new Set(schemaTables);
  return {
    missing: [...schema].filter((name) => !query.has(name)).sort(),
    extra: [...query].filter((name) => !schema.has(name)).sort(),
  };
}

async function refusal(run, code) {
  let caught = null;
  await assert.rejects(run, (error) => {
    caught = error;
    return error instanceof BankProviderCommandError && error.code === code;
  });
  return caught;
}

test("preview and approved apply use the real atomic writer, preserve unrelated values, and remove only the Plaid fields", async (t) => {
  const original = baseManifest({
    enabled: false,
    provider: "custom",
    environment: "sandbox",
    api_base: "https://provider.invalid",
    link_sdk_url: "https://provider.invalid/link.js",
    link_global: "ProviderFixture",
    registered_redirect_uris: ["https://brain.invalid/api/bank/callback"],
    registered_webhook_uris: ["https://brain.invalid/api/webhooks/bank"],
    country_codes: ["US"],
    reconciliation_interval_minutes: 30,
  });
  const { directory, manifestPath } = fixture(t, original);
  const counters = { recovery: 0, inspections: 0, lifecycle: 0, ownership: 0, writes: 0 };
  const deps = dependencies(counters);

  const preview = await runBankProviderCommand({
    manifestPath,
    flags: { set: "simplefin", enable: true, json: true },
  }, deps);
  assert.equal(preview.mode, "preview");
  assert.equal(preview.status, "ready");
  assert.equal(preview.write_required, true);
  assert.match(preview.plan_id, /^[a-f0-9]{64}$/u);
  assert.match(preview.apply_command, new RegExp(`${preview.plan_id}$`, "u"));
  assert.ok(preview.apply_command.includes(manifestPath));
  assert.deepEqual(preview.remove_fields, STALE_FIELDS);
  assert.deepEqual(preview.next_steps.map((step) => step.id), [
    "deploy", "owner_app_sign_in", "connect_bank",
  ]);
  assert.equal(counters.inspections, 1, "the green preview reached the aggregate bank-state decision");
  assert.equal(counters.writes, 0);

  const applied = await runBankProviderCommand({
    manifestPath,
    flags: { set: "simplefin", enable: true, apply: true, approve: preview.plan_id },
  }, deps);
  assert.equal(applied.mode, "apply");
  assert.equal(applied.status, "applied");
  assert.equal(counters.lifecycle, 1);
  assert.equal(counters.ownership, 1, "the apply reached the owned manifest-write decision");
  assert.equal(counters.inspections, 2);
  assert.equal(counters.transitionWrites, 1, "apply reached the atomic D1 transition-fence decision");
  assert.equal(counters.writes, 1);

  const saved = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(saved.test_extension, original.test_extension);
  assert.deepEqual(saved.corpora.bank_feed, {
    enabled: true,
    provider: "simplefin",
    environment: "production",
  });
  assert.equal(statSync(manifestPath).mode & 0o777, 0o600);
  const backups = readdirSync(directory).filter((name) => name.includes(".before-bank-provider-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, backups[0]), "utf8")), original);
});

for (const blocked of [
  { name: "active Plaid connection", state: bankState({
    bank_connections: 2, non_simplefin_connections: 2,
  }), field: "bank_connections" },
  { name: "Plaid-derived ledger history", state: bankState({
    bank_ledger_rows: 4, non_simplefin_ledger_rows: 4,
  }), field: "bank_ledger_rows" },
]) {
  test(`the ${blocked.name} refusal reaches the aggregate decision and performs no manifest write`, async (t) => {
    const { manifestPath } = fixture(t, baseManifest({ enabled: false, provider: "plaid", environment: "production" }));
    const counters = { recovery: 0, inspections: 0, lifecycle: 0, ownership: 0, writes: 0 };
    const error = await refusal(() => runBankProviderCommand({
      manifestPath,
      flags: { set: "simplefin", enable: true },
    }, dependencies(counters, blocked.state)), "BANK_PROVIDER_STATE_PRESENT");
    assert.equal(error.receipt.current_state[blocked.field], blocked.state[blocked.field]);
    assert.equal(counters.inspections, 1, "the refusal reached the nonzero aggregate decision");
    assert.equal(counters.writes, 0);
    assert.equal(readFileSync(manifestPath, "utf8").includes('"simplefin"'), false);
  });
}

test("invalid JSON and a schema-invalid manifest refuse before state inspection or write", async (t) => {
  for (const [label, value] of [
    ["invalid JSON", "{\n"],
    ["schema invalid", { manifest_version: 1, client: { slug: "x" } }],
    ["bank feed invalid", baseManifest({ enabled: true, provider: "simplefin", environment: "sandbox" })],
  ]) {
    await t.test(label, async (t) => {
      const { manifestPath } = fixture(t, value);
      const counters = { recovery: 0, inspections: 0, lifecycle: 0, ownership: 0, writes: 0 };
      const error = await refusal(() => runBankProviderCommand({
        manifestPath,
        flags: { set: "simplefin", enable: true },
      }, dependencies(counters)), "BANK_PROVIDER_MANIFEST_INVALID");
      assert.match(error.message, /manifest/i);
      assert.equal(counters.reads, 1, "the invalid-manifest decision read the named manifest once");
      assert.equal(counters.recovery, 0);
      assert.equal(counters.inspections, 0);
      assert.equal(counters.writes, 0);
    });
  }
});

test("an open lifecycle recovery refuses before bank inspection or manifest write", async (t) => {
  const { manifestPath } = fixture(t);
  const counters = {
    recovery: 0, inspections: 0, lifecycle: 0, ownership: 0, writes: 0, openRecovery: true,
  };
  await refusal(() => runBankProviderCommand({
    manifestPath,
    flags: { set: "simplefin", enable: true },
  }, dependencies(counters)), "BANK_PROVIDER_RECOVERY_OPEN");
  assert.equal(counters.recovery, 1, "the recovery-fence decision was reached");
  assert.equal(counters.inspections, 0);
  assert.equal(counters.writes, 0);
});

test("a supported unprovisioned manifest refuses before treating missing state as zero", async (t) => {
  for (const [label, binding] of [
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
  ]) {
    await t.test(label, async (t) => {
      const manifest = baseManifest();
      if (binding === undefined) delete manifest.infrastructure.cloudflare.d1_database_id;
      else manifest.infrastructure.cloudflare.d1_database_id = binding;
      const { manifestPath } = fixture(t, manifest);
      const counters = { recovery: 0, inspections: 0, lifecycle: 0, ownership: 0, writes: 0 };
      const error = await refusal(() => runBankProviderCommand({
        manifestPath,
        flags: { set: "simplefin", enable: true },
      }, dependencies(counters)), "BANK_PROVIDER_D1_UNPROVISIONED");
      assert.match(error.message, /provision/i);
      assert.equal(counters.reads, 1, "the refusal reached the parsed-manifest binding decision");
      assert.equal(counters.recovery, 1);
      assert.equal(counters.inspections, 0, "an absent observation cannot become synthetic zero counts");
      assert.equal(counters.writes, 0);
    });
  }
});

test("every malformed D1 binding refuses at the manifest boundary", async (t) => {
  const cases = [
    ["object", { id: D1_DATABASE_ID }],
    ["array", [D1_DATABASE_ID]],
    ["boolean", true],
    ["number", 7],
    ["provisioner placeholder", "filled_in_by_provisioner"],
    ["malformed string", "not-a-database-id"],
    ["wrong UUID version", "11111111-2222-0333-8444-555555555555"],
    ["wrong UUID variant", "11111111-2222-4333-7444-555555555555"],
  ];
  for (const [label, binding] of cases) {
    await t.test(label, async (t) => {
      const manifest = baseManifest();
      manifest.infrastructure.cloudflare.account_id = "a".repeat(32);
      manifest.infrastructure.cloudflare.d1_database_id = binding;
      const { manifestPath } = fixture(t, manifest);
      const counters = {
        recovery: 0,
        controls: 0,
        queries: 0,
        writes: 0,
      };
      await assert.rejects(
        () => cmdBankProvider([
          manifestPath, "--set", "simplefin", "--enable", "--json",
        ], {
          commandOptions: dependencies(counters),
          async d1Query() {
            counters.queries += 1;
            return { results: [bankState()] };
          },
          async withManifestControl(_path, action) {
            counters.controls += 1;
            return action();
          },
          write() { throw new Error("a refusal must not render a success receipt"); },
        }),
        (error) => {
          const payload = JSON.parse(error.message);
          return payload.error_code === "BANK_PROVIDER_MANIFEST_INVALID";
        },
        label,
      );
      assert.equal(counters.reads, 1, `${label}: the manifest decision was reached`);
      assert.equal(counters.recovery, 0, `${label}: recovery stays behind manifest validation`);
      assert.equal(counters.controls, 0, `${label}: credential custody was not entered`);
      assert.equal(counters.queries, 0, `${label}: no D1 request was attempted`);
      assert.equal(counters.writes, 0, `${label}: no manifest write was attempted`);
    });
  }
});

test("an unrelated manifest edit makes the approval stale after the second state inspection", async (t) => {
  const original = baseManifest({ enabled: false, provider: "plaid", environment: "sandbox" });
  const { manifestPath } = fixture(t, original);
  const counters = { recovery: 0, inspections: 0, lifecycle: 0, ownership: 0, writes: 0 };
  const deps = dependencies(counters);
  const preview = await runBankProviderCommand({
    manifestPath,
    flags: { set: "simplefin", enable: true },
  }, deps);
  writeFileSync(manifestPath, `${JSON.stringify({ ...original, test_extension: { preserved: ["changed"] } }, null, 2)}\n`);

  await refusal(() => runBankProviderCommand({
    manifestPath,
    flags: { set: "simplefin", enable: true, apply: true, approve: preview.plan_id },
  }, deps), "BANK_PROVIDER_APPROVAL_STALE");
  assert.equal(counters.inspections, 2, "apply re-read state before comparing the approved plan");
  assert.equal(counters.lifecycle, 1);
  assert.equal(counters.ownership, 0);
  assert.equal(counters.writes, 0);
});

test("an already exact SimpleFIN manifest is an empty idempotent plan and never writes", async (t) => {
  const { manifestPath } = fixture(t, baseManifest({
    enabled: true, provider: "simplefin", environment: "production",
  }));
  const counters = { recovery: 0, inspections: 0, lifecycle: 0, ownership: 0, writes: 0 };
  const deps = dependencies(counters, bankState({
    bank_connections: 3,
    simplefin_connections: 3,
    bank_ledger_rows: 9,
    simplefin_ledger_rows: 9,
    deployed_provider: "simplefin",
  }));
  const preview = await runBankProviderCommand({
    manifestPath,
    flags: { set: "simplefin", enable: true },
  }, deps);
  assert.equal(preview.status, "unchanged");
  assert.equal(preview.write_required, false);
  assert.equal(preview.current_state.deployed_provider, "simplefin");
  assert.equal(preview.current_state.non_simplefin_connections, 0);
  assert.deepEqual(preview.changes, []);
  const applied = await runBankProviderCommand({
    manifestPath,
    flags: { set: "simplefin", enable: true, apply: true, approve: preview.plan_id },
  }, deps);
  assert.equal(applied.status, "unchanged");
  assert.equal(counters.inspections, 2, "idempotency still reports the aggregate state");
  assert.equal(counters.lifecycle, 1);
  assert.equal(counters.writes, 0);
});

test("a command-created manifest/runtime skew refuses every non-SimpleFIN state sibling", async (t) => {
  for (const [label, state, field] of [
    ["Plaid connection", bankState({
      bank_connections: 1,
      non_simplefin_connections: 1,
      deployed_provider: "plaid",
      transition_target: "simplefin",
      transition_ref: "a".repeat(64),
    }), "non_simplefin_connections"],
    ["Plaid ledger provenance", bankState({
      bank_ledger_rows: 1,
      non_simplefin_ledger_rows: 1,
      deployed_provider: "plaid",
      transition_target: "simplefin",
      transition_ref: "b".repeat(64),
    }), "non_simplefin_ledger_rows"],
  ]) {
    await t.test(label, async (t) => {
      const { manifestPath } = fixture(t, baseManifest({
        enabled: true, provider: "simplefin", environment: "production",
      }));
      const counters = { recovery: 0, inspections: 0, lifecycle: 0, ownership: 0, writes: 0 };
      const error = await refusal(() => runBankProviderCommand({
        manifestPath,
        flags: { set: "simplefin", enable: true },
      }, dependencies(counters, state)), "BANK_PROVIDER_STATE_PRESENT");
      assert.equal(error.receipt.current_state[field], 1);
      assert.equal(counters.inspections, 1, `${label}: the provider-aware decision was reached`);
      assert.equal(counters.writes, 0);
    });
  }
});

test("production preview reads a missing lifecycle root without creating it", async (t) => {
  const { directory, manifestPath } = fixture(t);
  const lifecycleRoot = join(directory, "preview-must-not-create");
  const previous = process.env.BRAIN_LIFECYCLE_LOCK_ROOT;
  process.env.BRAIN_LIFECYCLE_LOCK_ROOT = lifecycleRoot;
  try {
    const receipt = await runBankProviderCommand({
      manifestPath,
      flags: { set: "simplefin", enable: true },
    }, {
      schema: SCHEMA,
      inspectBankState: async () => bankState(),
    });
    assert.equal(receipt.status, "ready");
    assert.equal(existsSync(lifecycleRoot), false, "preview performed zero lifecycle-root writes");
  } finally {
    if (previous === undefined) delete process.env.BRAIN_LIFECYCLE_LOCK_ROOT;
    else process.env.BRAIN_LIFECYCLE_LOCK_ROOT = previous;
  }
});

test("unknown Setup Token input is rejected before any manifest or state read", async (t) => {
  const { manifestPath } = fixture(t);
  const counters = { recovery: 0, inspections: 0, lifecycle: 0, ownership: 0, writes: 0 };
  const error = await refusal(() => runBankProviderCommand({
    manifestPath,
    flags: { set: "simplefin", enable: true, "setup-token": "not-read" },
  }, dependencies(counters)), "BANK_PROVIDER_ARGUMENT_INVALID");
  assert.doesNotMatch(error.message, /not-read/u);
  assert.equal(counters.reads || 0, 0, "argument refusal happened before a manifest read");
  assert.equal(counters.recovery, 0);
  assert.equal(counters.inspections, 0);
  assert.equal(counters.writes, 0);
});

test("the raw argv boundary redacts token input, rejects extra positionals, and performs no reads", async (t) => {
  const { directory, manifestPath } = fixture(t);
  const fixtureValue = ["fixture", "setup", "value"].join("-");
  const env = {
    PATH: process.env.PATH || "",
    HOME: directory,
    BRAIN_NO_WRANGLER_LOGIN: "1",
    BRAIN_LIFECYCLE_LOCK_ROOT: join(directory, "lifecycle-locks"),
    BRAIN_TEST_LAUNCHCTL: process.env.BRAIN_TEST_LAUNCHCTL || "",
    BRAIN_TEST_ADMIN_KEY_FILE: process.env.BRAIN_TEST_ADMIN_KEY_FILE || "",
    npm_config_cache: process.env.npm_config_cache || "",
  };
  const cases = [
    ["unknown equals form", [manifestPath, `--setup-token=${fixtureValue}`, "--set", "simplefin", "--enable", "--json"]],
    ["unknown separate-value form", [manifestPath, "--setup-token", fixtureValue, "--set", "simplefin", "--enable"]],
    ["extra positional before options", [manifestPath, fixtureValue, "--set", "simplefin", "--enable"]],
    ["extra positional after options", [manifestPath, "--set", "simplefin", "--enable", fixtureValue]],
    ["forbidden value in known slot", [manifestPath, "--set", fixtureValue, "--enable"]],
    ["known equals form", [manifestPath, "--set=simplefin", "--enable"]],
    ["repeated switch", [manifestPath, "--set", "simplefin", "--enable", "--enable"]],
  ];
  for (const [label, argv] of cases) {
    const counters = { recovery: 0, inspections: 0, lifecycle: 0, ownership: 0, writes: 0 };
    const error = await refusal(
      () => runBankProviderCommand({ argv }, dependencies(counters)),
      "BANK_PROVIDER_ARGUMENT_INVALID",
    );
    assert.doesNotMatch(error.message, new RegExp(fixtureValue, "u"), label);
    assert.equal(counters.reads || 0, 0, `${label}: argument decision preceded the manifest read`);
    assert.equal(counters.recovery, 0, label);
    assert.equal(counters.inspections, 0, label);
    assert.equal(counters.writes, 0, label);

    const result = spawnSync(process.execPath, [
      join(ROOT, "brain.mjs"), "bank-provider", ...argv,
    ], { cwd: ROOT, env, encoding: "utf8" });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, `${label}: ${output}`);
    assert.doesNotMatch(output, new RegExp(fixtureValue, "u"), label);
    assert.match(output, /argument|option|usage/i, label);
  }
});

test("the package template is refused until its D1 placeholder is provisioned", () => {
  const template = JSON.parse(readFileSync(join(ROOT, "templates/brain.manifest.json"), "utf8"));
  assert.throws(
    () => validateBankProviderManifest(template, SCHEMA),
    (error) => error instanceof BankProviderCommandError &&
      error.code === "BANK_PROVIDER_MANIFEST_INVALID" &&
      /d1_database_id/iu.test(error.message),
    "the shipped provisioner placeholder cannot cross the installed command boundary",
  );
  const provisioned = structuredClone(template);
  provisioned.infrastructure.cloudflare.d1_database_id = D1_DATABASE_ID;
  assert.equal(
    validateBankProviderManifest(provisioned, SCHEMA),
    provisioned,
    "the same template is accepted once the D1 binding is canonical",
  );
  const unrelatedInvalid = structuredClone(provisioned);
  unrelatedInvalid.corpora.imap.host = 7;
  assert.throws(
    () => validateBankProviderManifest(unrelatedInvalid, SCHEMA),
    (error) => error instanceof BankProviderCommandError &&
      error.code === "BANK_PROVIDER_MANIFEST_INVALID" && /imap\.host/iu.test(error.message),
    "the command validates the complete reconciled manifest, not only bank-feed fields",
  );
});

test("the D1 observation covers every terminal-schema ledger family and rejects malformed counts", () => {
  assert.match(BANK_PROVIDER_STATE_SQL, /COUNT\(\*\).*bank_feed_items/su);
  const queryTables = [...BANK_PROVIDER_STATE_SQL.matchAll(/\bFROM\s+(fin_[a-z0-9_]+)\b/giu)]
    .map((match) => match[1]).sort();
  const schemaTables = terminalLedgerTables();
  assert.ok(schemaTables.length > 0, "the migration-derived ledger inventory is nonempty");
  assert.deepEqual(ledgerFamilyDifference(queryTables, schemaTables), { missing: [], extra: [] });
  assert.deepEqual(
    ledgerFamilyDifference(queryTables.slice(1), schemaTables),
    { missing: [queryTables[0]], extra: [] },
    "the negative sibling proves one uniformly omitted family makes the inventory gate red",
  );
  assert.doesNotMatch(BANK_PROVIDER_STATE_SQL, /SELECT\s+\*/iu);
  assert.deepEqual(normalizeBankProviderState({ results: [bankState()] }), bankState());
  for (const result of [null, { results: [] }, { results: [{ bank_connections: -1, bank_ledger_rows: 0 }] }]) {
    assert.throws(() => normalizeBankProviderState(result), /aggregate bank state/i);
  }
});

test("the shared parser leaves bare --set to the existing check command decision", async (t) => {
  assert.equal(VALUE_FLAGS.has("set"), false);
  const flags = parseFlags(["--set"]);
  assert.deepEqual(flags, { set: true });
  const manifest = baseManifest();
  manifest.brain.domain = "brain.example.invalid";
  const { manifestPath } = fixture(t, manifest);
  await assert.rejects(
    () => cmdCheck(manifestPath, { flags, adminKey: "" }),
    /no durable admin key was found/i,
    "bare --set passed the shared parser and the check command's own switch decision",
  );
});

test("the provisioned adapter accepts zero only after one control wrapper and aggregate query", async (t) => {
  const manifest = baseManifest({ enabled: false });
  manifest.infrastructure.cloudflare.account_id = "a".repeat(32);
  const { manifestPath } = fixture(t, manifest);
  const counters = {
    recovery: 0, inspections: 0, lifecycle: 0, ownership: 0, writes: 0,
    controls: 0, queries: 0, output: [],
  };
  const receipt = await cmdBankProvider([
    manifestPath, "--set", "simplefin", "--enable", "--json",
  ], {
    commandOptions: dependencies(counters),
    async d1Query(accountId, databaseId, sql) {
      counters.queries += 1;
      assert.equal(accountId, "a".repeat(32));
      assert.equal(databaseId, D1_DATABASE_ID);
      assert.equal(sql, BANK_PROVIDER_STATE_SQL);
      return { results: [bankState()] };
    },
    async withManifestControl(path, action, options) {
      counters.controls += 1;
      assert.equal(path, manifestPath);
      assert.deepEqual(options, { command: "bank-provider" });
      return action();
    },
    write(line) { counters.output.push(line); },
  });
  assert.equal(receipt.status, "ready");
  assert.equal(counters.reads, 1);
  assert.equal(counters.recovery, 1);
  assert.equal(counters.controls, 1, "the command reached its Cloudflare control decision once");
  assert.equal(counters.queries, 1, "zero counts came from one aggregate query");
  assert.equal(counters.writes, 0);
  assert.equal(JSON.parse(counters.output[0]).status, "ready");
});

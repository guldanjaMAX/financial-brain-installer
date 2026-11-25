import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as brain from "../brain.mjs";
import { validateBankProviderManifest } from "../operations/bank-provider-command.mjs";

const schema = JSON.parse(readFileSync(new URL("../manifest.schema.json", import.meta.url), "utf8"));
const domain = "fixture-brain.owner-subdomain.workers.dev";
const account = { id: "a".repeat(32) };
const fixture = () => ({ manifest_version: 1, client: { slug: "fixture", display_name: "Owner" },
  brain: { version: "0.1.9", worker_name: "fixture-brain" },
  infrastructure: { cloudflare: { account_id: account.id, d1_database_id: "11111111-2222-4333-8444-555555555555", storage: "d1" } } });
function workspace(t, raw = JSON.stringify(fixture(), null, 2) + "\n") {
  const dir = mkdtempSync(join(tmpdir(), "domain-save-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "brain.manifest.json");
  writeFileSync(path, raw, { mode: 0o600 });
  return { dir, path, raw };
}

for (const guidedSetup of [false, true]) {
  test(`R3 optional-save contract: propagation is typed only for guided setup (${guidedSetup})`, async t => {
    const f = workspace(t); const lines = []; let probes = 0, reads = 0, clock = 0;
    const result = await brain.saveMissingBrainDomain(f.path, {
      guidedSetup,
      readSubdomain: async () => { reads++; return { subdomain: "owner-subdomain" }; },
      request: async () => { probes++; clock += 1_000; return new Response("fixture", { status: 404 }); },
      now: () => clock, wait: async ms => { clock += ms; }, report: line => lines.push(line),
    });
    assert.equal(reads, 1); assert.ok(probes > 1, "the real retry and exhaustion decisions were reached");
    assert.equal(clock, 60_000, "the existing budget is unchanged");
    assert.equal(readFileSync(f.path, "utf8"), f.raw);
    if (guidedSetup) {
      assert.deepEqual(result, { status: "pending", code: "BRAIN_ADDRESS_PENDING" });
      assert.deepEqual(lines, [], "the setup caller owns the supported resume line");
    } else {
      assert.equal(result, null, "update callers keep the existing optional-save result");
      assert.equal(lines.length, 1); assert.match(lines[0], /BRAIN_DOMAIN_NOT_SAVED/);
    }
  });
}

test("verified persistence inserts only domain bytes and replaces the file atomically", async t => {
  const raw = JSON.stringify(fixture(), null, "\t").replaceAll("\n", "\r\n")
    .replace('"manifest_version": 1,', '"manifest_version": 1, "retained_number":9007199254740993, "retained_text":"\\u0061",') + "\r\n";
  const f = workspace(t, raw);
  const before = lstatSync(f.path);
  let reads = 0, probes = 0;
  assert.equal(await brain.persistWorkersDevDomain(f.path, JSON.parse(raw), account, "fixture-brain", {
    readSubdomain: async () => { reads++; return { subdomain: "owner-subdomain" }; },
    verifyWorkersDevCandidate: async candidate => { probes++; assert.equal(candidate, domain); return { ok: true }; },
  }), domain);
  const output = readFileSync(f.path, "utf8");
  assert.equal(output.replace(`,"domain":${JSON.stringify(domain)}`, ""), raw);
  assert.equal(reads, 1); assert.equal(probes, 1);
  assert.notEqual(lstatSync(f.path).ino, before.ino);
  assert.equal(lstatSync(f.path).mode & 0o777, before.mode & 0o777);
  assert.deepEqual(readdirSync(f.dir), ["brain.manifest.json"]);
  validateBankProviderManifest(JSON.parse(output), schema);
});

for (const saved of [domain, "brain.example.invalid", "", null]) {
  test(`an existing domain property is untouched (${JSON.stringify(saved)})`, async t => {
    const value = fixture(); value.brain.domain = saved;
    const f = workspace(t, JSON.stringify(value));
    let calls = 0;
    assert.equal(await brain.persistWorkersDevDomain(f.path, value, account, "fixture-brain", {
      readSubdomain: async () => { calls++; return { subdomain: "owner-subdomain" }; },
      verifyWorkersDevCandidate: async () => { calls++; return { ok: true }; },
    }), saved, "the existing-property decision returned its exact value");
    assert.equal(readFileSync(f.path, "utf8"), f.raw);
    assert.equal(calls, 0);
  });
}

test("optional denied domain read is reached once, stays unchanged and prints one calm code line", async t => {
  const f = workspace(t);
  const lines = []; let reads = 0, probes = 0;
  const result = await brain.saveMissingBrainDomain(f.path, {
    readSubdomain: async () => { reads++; const error = new Error("GET failed (403): 10000"); error.status = 403; throw error; },
    verifyWorkersDevCandidate: async () => { probes++; return { ok: true }; },
    report: line => lines.push(line),
  });
  assert.equal(result, null); assert.equal(reads, 1); assert.equal(probes, 0);
  assert.equal(readFileSync(f.path, "utf8"), f.raw);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /BRAIN_DOMAIN_NOT_SAVED/);
  assert.match(lines[0], /https:\/\/financialbrain\.ai\/help\/BRAIN_DOMAIN_NOT_SAVED/);
  assert.doesNotMatch(lines[0], /token|paste|recovery|sign in|10000/i);
});

test("optional save has a successful verified control and dry-run performs no read or write", async t => {
  const f = workspace(t);
  let reads = 0, probes = 0;
  const options = {
    readSubdomain: async () => { reads++; return { subdomain: "owner-subdomain" }; },
    verifyWorkersDevCandidate: async () => { probes++; return { ok: true }; },
  };
  assert.equal(await brain.saveMissingBrainDomain(f.path, { ...options, dryRun: true }), null);
  assert.equal(readFileSync(f.path, "utf8"), f.raw); assert.equal(reads, 0);
  assert.equal(await brain.saveMissingBrainDomain(f.path, options), domain);
  assert.equal(reads, 1); assert.equal(probes, 1);
  validateBankProviderManifest(JSON.parse(readFileSync(f.path, "utf8")), schema);
});

const { verifyDomainUpgradeCases } = await import("./fixtures/domain-upgrade-cases.mjs");
test("real upgrade saves missing domains after verification and leaves existing, custom and denied arms safe", async () => {
  await verifyDomainUpgradeCases(brain.cmdUpgrade);
});

for (const denied of [true, false]) {
  test(`real credential boundary continues without renewal or recovery after optional save (denied=${denied})`, async t => {
    const f = workspace(t); let requests = 0, renewals = 0, prompts = 0, tokens = 0, continued = 0;
    const priorFetch = globalThis.fetch;
    const priorToken = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    t.after(() => { globalThis.fetch = priorFetch;
      if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = priorToken;
    });
    globalThis.fetch = async input => {
      requests++;
      assert.equal(new URL(String(input)).pathname, `/client/v4/accounts/${account.id}/workers/subdomain`);
      return new Response(JSON.stringify({ success: !denied, result: denied ? null : { subdomain: "owner-subdomain" },
        errors: denied ? [{ code: 10000, message: "Authentication error" }] : [] }), { status: denied ? 403 : 200 });
    };
    const lines = [];
    await brain.withCloudflareControlCredential(async () => {
      const result = await brain.saveMissingBrainDomain(f.path, {
        report: line => lines.push(line), verifyWorkersDevCandidate: async () => ({ ok: true }),
      });
      assert.equal(result, denied ? null : domain); continued++;
    }, {
      accountId: account.id, authProfile: "fixture-profile", manifestPath: f.path,
      interactive: true, allowBrowserReauth: true, allowTokenRecovery: true,
      askFn: async () => { prompts++; throw new Error("unexpected prompt"); },
      withToken: async () => { tokens++; throw new Error("unexpected token recovery"); },
      oauthOptions: { processRunner: () => { renewals++; throw new Error("unexpected credential helper"); } },
      withOAuthSession: async ({ action }) => action({
        token: Buffer.from(["fixture", "access"].join("-")), profile: "fixture-profile", account,
        preflight: { status: "ready", account },
      }),
    });
    assert.equal(requests, 1); assert.equal(continued, 1);
    assert.equal(renewals, 0); assert.equal(prompts, 0); assert.equal(tokens, 0);
    if (denied) { assert.equal(readFileSync(f.path, "utf8"), f.raw); assert.equal(lines.length, 1); }
    else assert.equal(JSON.parse(readFileSync(f.path, "utf8")).brain.domain, domain);
  });
}

test("a failed identity probe and a concurrent edit both preserve the owner manifest", async t => {
  for (const arm of ["wrong-brain", "edit"]) {
    const f = workspace(t); let probes = 0; const lines = [];
    const edited = f.raw + " ";
    assert.equal(await brain.saveMissingBrainDomain(f.path, {
      readSubdomain: async () => ({ subdomain: "owner-subdomain" }), report: line => lines.push(line),
      verifyWorkersDevCandidate: async () => {
        probes++;
        if (arm === "edit") writeFileSync(f.path, edited);
        return { ok: arm === "edit", reason: "different brain" };
      },
    }), null);
    assert.equal(probes, 1); assert.equal(lines.length, 1);
    assert.equal(readFileSync(f.path, "utf8"), arm === "edit" ? edited : f.raw);
    assert.deepEqual(readdirSync(f.dir), ["brain.manifest.json"]);
  }
});

test("direct deploy cannot save an old account's address into an edited manifest", async t => {
  const f = workspace(t); const original = JSON.parse(f.raw);
  const changed = structuredClone(original); changed.infrastructure.cloudflare.account_id = "b".repeat(32);
  const edited = JSON.stringify(changed); let reads = 0;
  await assert.rejects(brain.persistWorkersDevDomain(f.path, original, account, "fixture-brain", {
    readSubdomain: async () => { reads++; writeFileSync(f.path, edited); return { subdomain: "owner-subdomain" }; },
    verifyWorkersDevCandidate: async () => ({ ok: true }),
  }), /manifest.*changed|identity.*changed/i);
  assert.equal(reads, 1); assert.equal(readFileSync(f.path, "utf8"), edited);
});

for (const identity of ["fixture", "different-brain"]) {
  test(`the production identity probe decides the optional save (${identity})`, async t => {
    const f = workspace(t); let reads = 0, health = 0; const lines = [];
    const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    const result = await brain.saveMissingBrainDomain(f.path, {
      readSubdomain: async () => { reads++; return { subdomain: "owner-subdomain" }; },
      request: async (url, init) => {
        health++; assert.equal(url, `https://${domain}/health`);
        assert.equal(init.headers?.Authorization, undefined, "the untrusted candidate receives no admin credential");
        return new Response(JSON.stringify({ brain: identity, version }), { status: 200 });
      },
      report: line => lines.push(line),
    });
    assert.equal(reads, 1); assert.equal(health, 1);
    if (identity === "fixture") { assert.equal(result, domain); assert.equal(lines.length, 0); }
    else { assert.equal(result, null); assert.equal(readFileSync(f.path, "utf8"), f.raw); assert.equal(lines.length, 1); }
  });
}

for (const subdomain of [undefined, "", "invalid.label", "../invalid"]) {
  test(`an unusable subdomain cannot be replaced with a guessed label (${JSON.stringify(subdomain)})`, async t => {
    const f = workspace(t); let reads = 0, probes = 0; const lines = [];
    assert.equal(await brain.saveMissingBrainDomain(f.path, {
      readSubdomain: async () => { reads++; return { subdomain }; },
      verifyWorkersDevCandidate: async () => { probes++; return { ok: true }; },
      report: line => lines.push(line),
    }), null);
    assert.equal(reads, 1); assert.equal(probes, 0); assert.equal(lines.length, 1);
    assert.equal(readFileSync(f.path, "utf8"), f.raw);
  });
}

for (const hasDomain of [false, true]) {
  test(`real update preview never saves a domain (saved=${hasDomain})`, async t => {
    const value = fixture(); value.brain.version = "0.4.17";
    if (hasDomain) value.brain.domain = "brain.example.invalid";
    const f = workspace(t, JSON.stringify(value)); let decisions = 0, requests = 0, keys = 0;
    const sha = "a".repeat(64);
    const options = {
      runtimeRoot: f.dir, runtimeAllowlist: ["brain.mjs"],
      verifyRuntime: () => ({ schema_version: 1, identity_scheme: "brain.runtime-payload.sha256.v1",
        runtime_payload_sha256: sha, file_count: 1, total_bytes: 1, expected_runtime_sha256: sha, verified_passes: 2 }),
      pinRuntimePackage: () => ({ manifest: { name: "brain-installer", version: "0.4.29" } }),
      discoverInstalledManifest: () => ({ path: f.path, source: "explicit" }),
      resolveDocumentsUrl: manifest => { decisions++; return brain.updatePreviewDocumentsUrl(manifest); },
      revalidateRuntimePackage: () => {},
      resolveAdminKey: () => { keys++; return ["fixture", "admin"].join("-"); },
      request: async () => {
        requests++;
        return Response.json({ version: "0.4.17", backend: "d1", vector_drain_mode: "active", rows: [],
          vector_backlog: { pending: 0, pending_is_capped: false, pending_display: "0", upserts: 0, deletes: 0,
            submitted: 0, component_counts_exact: true, oldest_queued_at: null },
          vector_readiness: { ready: true, reason: null, expected_vectors: 0, actual_vectors: 0, pending: 0,
            pending_is_capped: false, submitted: 0, submitted_counts_exact: true, oldest_queued_at: null } });
      },
      write: () => {},
    };
    const argv = [f.path, "--preview", "--json", "--expect-runtime-sha256", sha];
    if (hasDomain) {
      const receipt = await brain.cmdUpdatePreview(argv, options);
      assert.equal(receipt.authorizes_update, false); assert.equal(requests, 1); assert.equal(keys, 1);
    } else {
      await assert.rejects(brain.cmdUpdatePreview(argv, options), error => {
        assert.equal(error.payload.error_code, "UPDATE_PREVIEW_BRAIN_DOMAIN_INVALID"); return true;
      });
      assert.equal(requests, 0); assert.equal(keys, 0);
    }
    assert.equal(decisions, 1, "both arms reached the saved-address decision in the actual preview");
    assert.equal(readFileSync(f.path, "utf8"), f.raw);
    assert.deepEqual(readdirSync(f.dir), ["brain.manifest.json"]);
  });
}

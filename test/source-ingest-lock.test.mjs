import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalSourceIngestStatePath,
  SourceIngestLockError,
  acquireSourceIngestLock,
  sourceIngestLockPath,
  withSourceIngestLock,
} from "../operations/source-ingest-lock.mjs";
import {
  applyDriveRemovals,
  cmdConnect,
  cmdIngestCalendar,
  cmdIngestLocal,
  cmdIngestRemote,
  makeOcrCallback,
  planLoad,
  reconcileDocumentFamilies,
  requestIngestBatch,
} from "../brain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "brain.mjs");
const LOCK_MODULE = new URL("../operations/source-ingest-lock.mjs", import.meta.url).href;
const OLD = new Date(Date.now() - 180_000);
let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "brain-source-ingest-lock-"));
  const home = join(root, "home");
  const manifests = join(root, "manifests");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(manifests, { mode: 0o700 });
  const manifestPath = join(manifests, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture" },
    brain: { domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
    corpora: {
      slack: { enabled: true, source: "client-chat", channel_ids: ["C1"] },
      upload: { enabled: true },
      google_drive: { enabled: true },
      gmail: { enabled: true },
      calendar: { enabled: true },
    },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
  }));
  return { root, home, manifests, manifestPath };
};

if (process.platform !== "win32") {
  const f = fixture();
  try {
    const target = join(f.root, "runtime-link-target");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, join(f.home, ".brain"), "dir");
    assert.throws(
      () => sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_unsafe",
    );
    check("a runtime-directory symlink is rejected without changing its target permissions",
      (lstatSync(target).mode & 0o077) !== 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }

  const f2 = fixture();
  try {
    const runtimeDir = join(f2.home, ".brain");
    const target = join(f2.root, "locks-link-target");
    mkdirSync(runtimeDir, { mode: 0o700 });
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, join(runtimeDir, "locks"), "dir");
    assert.throws(
      () => sourceIngestLockPath({ manifestPath: f2.manifestPath, sourceName: "gmail", home: f2.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_unsafe",
    );
    check("an ingest-lock-directory symlink is rejected without changing its target permissions",
      (lstatSync(target).mode & 0o077) !== 0);
  } finally {
    rmSync(f2.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const holder = acquireSourceIngestLock({
      sourceName: "google",
      sharedRecord: "provider:google",
      home: f.home,
    });
    let credentialCalls = 0;
    await assert.rejects(
      cmdConnect("google", {
        argv: [process.execPath, CLI, "connect", "google", "--scopes", "drive"],
        env: { GOOGLE_CLIENT_ID: "fixture-client-id" },
        sourceIngestLockOptions: { home: f.home },
        loadGoogleTokens: () => { credentialCalls++; return {}; },
        authorizeGoogle: async () => {
          credentialCalls++;
          return { access_token: "fixture-access-token", refresh_token: "fixture-refresh-token" };
        },
        saveGoogleTokens: () => { credentialCalls++; },
      }),
      /google ingest is already running/i,
    );
    check("Google connect contention stops before credential read, OAuth, or credential write",
      credentialCalls === 0 && holder.assertOwned() === true,
      `credential calls=${credentialCalls}`);
    holder.release();

    let ownershipChecks = 0;
    let authorizeCalls = 0;
    let identityCalls = 0;
    let saveCalls = 0;
    await assert.rejects(
      cmdConnect("google", {
        argv: [process.execPath, CLI, "connect", "google", "--scopes", "drive"],
        env: { GOOGLE_CLIENT_ID: "fixture-client-id" },
        withSourceIngestLock: async (lockOptions, task) => {
          assert.equal(lockOptions.sharedRecord, "provider:google");
          return task({
            assertOwned: () => {
              ownershipChecks++;
              if (ownershipChecks > 1) {
                throw new SourceIngestLockError("fixture Google credential lease was lost", {
                  code: "source_ingest_lock_lost",
                });
              }
              return true;
            },
          });
        },
        loadGoogleTokens: () => ({}),
        authorizeGoogle: async () => {
          authorizeCalls++;
          return { access_token: "fixture-access-token", refresh_token: "fixture-refresh-token" };
        },
        fetchConnectedAccountEmail: async () => { identityCalls++; return "owner@fixture.invalid"; },
        saveGoogleTokens: () => { saveCalls++; },
      }),
      /fixture Google credential lease was lost/,
    );
    check("a Google connect that loses ownership after OAuth cannot inspect or overwrite the credential record",
      authorizeCalls === 1 && ownershipChecks === 2 && identityCalls === 0 && saveCalls === 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const aliasRoot = join(f.root, "manifest-hard-link");
    mkdirSync(aliasRoot, { mode: 0o700 });
    const hardLink = join(aliasRoot, "brain.manifest.json");
    linkSync(f.manifestPath, hardLink);
    let refusal = null;
    assert.throws(
      () => canonicalSourceIngestStatePath({
        manifestPath: hardLink,
        sourceName: "gmail",
      }),
      (error) => {
        refusal = error;
        return error instanceof SourceIngestLockError &&
          error.code === "source_ingest_lock_unsafe";
      },
    );
    check("a hard-linked manifest is refused without exposing its private path",
      refusal !== null &&
      !refusal.message.includes(f.root) &&
      !existsSync(join(f.home, ".brain")));

    assert.throws(
      () => acquireSourceIngestLock({
        manifestPath: f.manifestPath,
        statePath: join(f.manifests, ".brain-ingest-gmail.json"),
        sourceName: "gmail",
        home: f.home,
      }),
      (error) => error instanceof SourceIngestLockError &&
        error.code === "source_ingest_lock_unsafe",
    );
    check("an explicit state path cannot bypass the hard-linked manifest refusal",
      !existsSync(join(f.home, ".brain")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"));
    const sharedHolder = acquireSourceIngestLock({
      sourceName: "google",
      sharedRecord: "provider:google",
      home: f.home,
    });
    const cases = [
      {
        sourceName: "drive",
        invoke: (options) => cmdIngestRemote(
          manifest,
          f.manifestPath,
          { from: "drive", source: "drive" },
          options,
        ),
      },
      {
        sourceName: "gmail",
        invoke: (options) => cmdIngestRemote(
          manifest,
          f.manifestPath,
          { from: "gmail", source: "gmail" },
          options,
        ),
      },
      {
        sourceName: "calendar",
        invoke: (options) => cmdIngestCalendar(
          manifest,
          f.manifestPath,
          { from: "calendar", source: "calendar" },
          options,
        ),
      },
    ];

    for (const item of cases) {
      let boundaryCalls = 0;
      await assert.rejects(
        item.invoke({
          sourceIngestLockOptions: { home: f.home },
          resolveBaseUrl: async () => { boundaryCalls++; return "https://fixture.invalid"; },
          resolveAdminKey: () => { boundaryCalls++; return "fixture-admin-key"; },
          getAccessToken: async () => { boundaryCalls++; return "fixture-access-token"; },
          ingestLib: async () => { boundaryCalls++; throw new Error("writer core entered"); },
          googleCalendar: {
            syncAll: async () => { boundaryCalls++; throw new Error("writer core entered"); },
            ingestEnvelopes: async () => { boundaryCalls++; throw new Error("writer core entered"); },
          },
        }),
        /ingest is already running/,
      );
      const sourceLock = sourceIngestLockPath({
        manifestPath: f.manifestPath,
        sourceName: item.sourceName,
        home: f.home,
      });
      check(`${item.sourceName} stops at the shared Google credential lease before credential or network access`,
        boundaryCalls === 0 && !existsSync(sourceLock),
        `boundary calls=${boundaryCalls}`);
    }
    sharedHolder.release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"));
    const uploadRoot = join(f.root, "upload-order");
    mkdirSync(uploadRoot, { mode: 0o700 });
    const sentinel = new Error("fixture writer core reached");
    const cases = [
      {
        name: "upload",
        expected: ["source:upload"],
        invoke: (options) => cmdIngestLocal(
          manifest,
          f.manifestPath,
          { path: uploadRoot, source: "upload" },
          { ...options, ingestLib: async () => { throw sentinel; } },
        ),
      },
      ...["drive", "gmail"].map((sourceName) => ({
        name: sourceName,
        expected: [`source:${sourceName}`, "shared:provider:google", "credential:google"],
        invoke: (options) => cmdIngestRemote(
          manifest,
          f.manifestPath,
          { from: sourceName, source: sourceName },
          {
            ...options,
            ingestLib: async () => ({
              batchStream: async function* () {},
              splitOversized: () => [],
              loadState: () => { throw sentinel; },
              saveState: () => {},
              prefetch: () => [],
            }),
          },
        ),
      })),
      {
        name: "calendar",
        expected: ["source:calendar", "shared:provider:google", "credential:google"],
        invoke: (options) => cmdIngestCalendar(
          manifest,
          f.manifestPath,
          { from: "calendar", source: "calendar" },
          {
            ...options,
            googleCalendar: { syncAll: async () => { throw sentinel; }, ingestEnvelopes: async () => {} },
            loadCalendarState: () => { throw sentinel; },
          },
        ),
      },
    ];

    for (const item of cases) {
      const order = [];
      await assert.rejects(
        item.invoke({
          withSourceIngestLock: async (lockOptions, task) => {
            order.push(lockOptions.sharedRecord
              ? `shared:${lockOptions.sharedRecord}`
              : `source:${lockOptions.sourceName}`);
            return task({ assertOwned: () => true });
          },
          resolveBaseUrl: async () => "https://fixture.invalid",
          resolveAdminKey: () => "fixture-admin-key",
          loadGoogleTokens: () => {
            order.push("credential:google");
            return {
              google: {
                client_id: "fixture-client-id",
                client_secret: null,
                refresh_token: "fixture-refresh-token",
                scopes: ["drive", "gmail", "calendar"],
              },
            };
          },
        }),
        (error) => error === sentinel,
      );
      check(`${item.name} uses the fixed source-then-shared lock order exactly once`,
        JSON.stringify(order) === JSON.stringify(item.expected),
        JSON.stringify(order));
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"));
    const tokenRoot = join(f.root, "legacy-google");
    const tokenPath = join(tokenRoot, "google-tokens.json");
    mkdirSync(tokenRoot, { mode: 0o700 });
    const credential = {
      google: {
        client_id: "fixture-client-id",
        client_secret: null,
        refresh_token: "fixture-refresh-token",
        scopes: ["drive", "gmail", "calendar"],
      },
    };
    writeFileSync(tokenPath, JSON.stringify(credential, null, 2), { mode: 0o600 });
    const original = readFileSync(tokenPath);
    let dpapiCalls = 0;
    const googleStorageOptions = {
      backend: "file",
      platform: "win32",
      path: tokenPath,
      runPowerShell: () => {
        dpapiCalls++;
        throw new Error("a read-only path attempted DPAPI migration");
      },
    };
    let prelockCredentialReads = 0;

    const mutatingEntries = await planLoad({
      m: manifest,
      manifestPath: f.manifestPath,
      flags: { only: "drive" },
      platform: "win32",
      options: {
        googleStorageOptions,
        inspectGoogleCredential: () => {
          prelockCredentialReads++;
          throw new Error("a mutating load plan opened the Google credential");
        },
      },
    });
    const mutatingDrive = mutatingEntries.find((entry) => entry.key === "google_drive");
    check("a mutating load plan checks only Google storage metadata before the source leases",
      mutatingDrive?.status === "ready" && prelockCredentialReads === 0 &&
      dpapiCalls === 0 && readFileSync(tokenPath).equals(original));

    const previewEntries = await planLoad({
      m: manifest,
      manifestPath: f.manifestPath,
      flags: { only: "drive", "dry-run": true },
      platform: "win32",
      options: { googleStorageOptions },
    });
    const previewDrive = previewEntries.find((entry) => entry.key === "google_drive");
    check("the real dry-run load probe reads a legacy Google credential without migrating it",
      previewDrive?.status === "ready" && dpapiCalls === 0 && readFileSync(tokenPath).equals(original));

    const drySentinel = new Error("fixture dry writer core reached");
    for (const sourceName of ["drive", "gmail"]) {
      await assert.rejects(
        cmdIngestRemote(
          manifest,
          f.manifestPath,
          { from: sourceName, source: sourceName, "dry-run": true },
          {
            googleStorageOptions,
            loadGoogleTokens: () => { throw new Error("a dry run used the mutating Google token loader"); },
            ingestLib: async () => ({
              batchStream: async function* () {},
              splitOversized: () => [],
              loadState: () => { throw drySentinel; },
              saveState: () => {},
              prefetch: () => [],
            }),
          },
        ),
        (error) => error === drySentinel,
      );
      check(`${sourceName} dry run does not migrate the legacy Google credential`,
        dpapiCalls === 0 && readFileSync(tokenPath).equals(original));
    }

    await assert.rejects(
      cmdIngestCalendar(
        manifest,
        f.manifestPath,
        { from: "calendar", source: "calendar", "dry-run": true },
        {
          googleStorageOptions,
          loadGoogleTokens: () => { throw new Error("a dry run used the mutating Google token loader"); },
          googleCalendar: { syncAll: async () => { throw drySentinel; }, ingestEnvelopes: async () => {} },
          loadCalendarState: () => { throw drySentinel; },
        },
      ),
      (error) => error === drySentinel,
    );
    check("calendar dry run does not migrate the legacy Google credential",
      dpapiCalls === 0 && readFileSync(tokenPath).equals(original) &&
      JSON.stringify(readdirSync(tokenRoot)) === JSON.stringify(["google-tokens.json"]));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const first = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    const aliasRoot = join(f.root, "manifest-alias");
    if (process.platform !== "win32") {
      symlinkSync(f.manifests, aliasRoot, "dir");
      const capturedStatePath = canonicalSourceIngestStatePath({
        manifestPath: join(aliasRoot, "brain.manifest.json"),
        sourceName: "gmail",
      });
      const alias = sourceIngestLockPath({
        manifestPath: join(aliasRoot, "brain.manifest.json"),
        sourceName: "gmail",
        home: f.home,
      });
      check("canonical aliases share one source-state lock", first === alias);

      const retarget = join(f.root, "retargeted-manifests");
      mkdirSync(retarget, { mode: 0o700 });
      writeFileSync(join(retarget, "brain.manifest.json"), "{}", { mode: 0o600 });
      unlinkSync(aliasRoot);
      symlinkSync(retarget, aliasRoot, "dir");
      const movedStatePath = canonicalSourceIngestStatePath({
        manifestPath: join(aliasRoot, "brain.manifest.json"),
        sourceName: "gmail",
      });
      const capturedLock = sourceIngestLockPath({
        statePath: capturedStatePath,
        sourceName: "gmail",
        home: f.home,
      });
      check("a captured canonical state path remains bound after a symlink parent is retargeted",
        capturedStatePath !== movedStatePath && capturedLock === first);

      const fileAliasRoot = join(f.root, "manifest-file-alias");
      mkdirSync(fileAliasRoot, { mode: 0o700 });
      const fileAlias = join(fileAliasRoot, "brain.manifest.json");
      symlinkSync(f.manifestPath, fileAlias, "file");
      const fileAliasStatePath = canonicalSourceIngestStatePath({
        manifestPath: fileAlias,
        sourceName: "gmail",
      });
      const fileAliasLock = sourceIngestLockPath({
        manifestPath: fileAlias,
        sourceName: "gmail",
        home: f.home,
      });
      check("a manifest-file symlink resolves to the target's source state and lock",
        fileAliasStatePath === capturedStatePath && fileAliasLock === first);
      const targetOwner = acquireSourceIngestLock({
        manifestPath: f.manifestPath,
        sourceName: "gmail",
        home: f.home,
      });
      assert.throws(
        () => acquireSourceIngestLock({
          manifestPath: fileAlias,
          sourceName: "gmail",
          home: f.home,
        }),
        (error) => error instanceof SourceIngestLockError &&
          error.code === "source_ingest_already_running",
      );
      check("a manifest-file alias cannot acquire a second live writer lease",
        targetOwner.assertOwned() === true);
      targetOwner.release();
    }
    const other = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail-archive", home: f.home });
    check("different source-state files receive different locks", first !== other);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const owner = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "upload",
      home: f.home,
    });
    owner.release();
    let ocrMutations = 0;
    const ocr = makeOcrCallback({
      base: "https://brain.invalid",
      adminKey: "synthetic-admin-key",
      model: "fixture-model",
      maxPages: 1,
      assertOwned: owner.assertOwned,
      httpImpl: async () => {
        ocrMutations++;
        return new Response(JSON.stringify({ text: "fixture" }), { status: 200 });
      },
    });
    await assert.rejects(
      ocr({ png_base64: "fixture" }, { page: 1, totalPages: 1 }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_lost",
    );
    check("a lost local-folder owner cannot begin an OCR mutation", ocrMutations === 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const owner = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "drive",
      home: f.home,
    });
    let mutationAttempts = 0;
    let waits = 0;
    await assert.rejects(
      requestIngestBatch({
        base: "https://brain.invalid",
        adminKey: "synthetic-admin-key",
        docs: [{ source_type: "drive", source_id: "document-1" }],
        attempts: 3,
        delayMs: 0,
        sleep: async () => { waits++; },
        assertOwned: owner.assertOwned,
        fetchImpl: async () => {
          mutationAttempts++;
          owner.release();
          const error = new Error("synthetic lost response");
          error.cause = { code: "ECONNRESET" };
          throw error;
        },
      }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_lost",
    );
    check("a batch retry rechecks ownership before a second mutating POST",
      mutationAttempts === 1 && waits === 1,
      `mutation attempts=${mutationAttempts} waits=${waits}`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const brainSource = readFileSync(CLI, "utf8");
  const loadCommand = brainSource.slice(
    brainSource.indexOf("export async function cmdLoad("),
    brainSource.indexOf("export function gmailFailureEvidence"),
  );
  check("all supported provenance writers fence batch and receipt mutations with the active owner",
    (brainSource.match(/saveState, assertOwned: assertLockOwned/g) || []).length >= 2 &&
    (brainSource.match(/const recordSourceReceipt = \(receipt\) => \{/g) || []).length >= 3 &&
    /ingestEnvelopes\(\{[\s\S]*assertOwned: assertLockOwned/.test(brainSource));
  check("a lock-lost failure cannot overwrite a successor's source receipt",
    /runOpened && !runClosed && error\?\.code !== "source_ingest_lock_lost"\) \{\s+assertLockOwned\?\.\(\);\s+try \{/.test(brainSource));
  check("brain load delegates source leases to each writer instead of nesting an outer lease",
    !/runMutatingSourceIngest|withSourceIngestLock/.test(loadCommand));
}

{
  const f = fixture();
  try {
    const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"));
    const uploadRoot = join(f.root, "upload");
    mkdirSync(uploadRoot, { mode: 0o700 });
    const cases = [
      {
        sourceName: "upload",
        invoke: (options, flags = {}) => cmdIngestLocal(
          manifest,
          f.manifestPath,
          { path: uploadRoot, source: "upload", ...flags },
          options,
        ),
      },
      {
        sourceName: "drive",
        invoke: (options, flags = {}) => cmdIngestRemote(
          manifest,
          f.manifestPath,
          { from: "drive", source: "drive", ...flags },
          options,
        ),
      },
      {
        sourceName: "gmail",
        invoke: (options, flags = {}) => cmdIngestRemote(
          manifest,
          f.manifestPath,
          { from: "gmail", source: "gmail", ...flags },
          options,
        ),
      },
      {
        sourceName: "calendar",
        invoke: (options, flags = {}) => cmdIngestCalendar(
          manifest,
          f.manifestPath,
          { from: "calendar", source: "calendar", ...flags },
          options,
        ),
      },
    ];

    for (const item of cases) {
      const holder = acquireSourceIngestLock({
        manifestPath: f.manifestPath,
        sourceName: item.sourceName,
        home: f.home,
      });
      const beforeManifest = readFileSync(f.manifestPath, "utf8");
      const beforeEntries = readdirSync(f.manifests).sort();
      const statePath = canonicalSourceIngestStatePath({
        manifestPath: f.manifestPath,
        sourceName: item.sourceName,
      });
      let boundaryCalls = 0;
      const options = {
        sourceIngestLockOptions: { home: f.home },
        resolveBaseUrl: async () => { boundaryCalls++; return "https://fixture.invalid"; },
        resolveAdminKey: () => { boundaryCalls++; return "fixture-admin-key"; },
        getAccessToken: async () => { boundaryCalls++; return "fixture-access-token"; },
        ingestLib: async () => { boundaryCalls++; throw new Error("writer core entered"); },
        googleCalendar: {
          syncAll: async () => { boundaryCalls++; throw new Error("writer core entered"); },
          ingestEnvelopes: async () => { boundaryCalls++; throw new Error("writer core entered"); },
        },
      };
      await assert.rejects(
        item.invoke(options),
        /ingest is already running/,
      );
      check(`${item.sourceName} contention stops before credentials, network, or writer-core access`,
        boundaryCalls === 0, `boundary calls=${boundaryCalls}`);
      check(`${item.sourceName} contention creates no resume state, receipt, or manifest write`,
        !existsSync(statePath) &&
        readFileSync(f.manifestPath, "utf8") === beforeManifest &&
        JSON.stringify(readdirSync(f.manifests).sort()) === JSON.stringify(beforeEntries));

      const drySentinel = new Error(`${item.sourceName} dry core reached`);
      await assert.rejects(
        item.invoke({
          ...options,
          ingestLib: async () => { throw drySentinel; },
          googleCalendar: {
            syncAll: async () => { throw drySentinel; },
            ingestEnvelopes: async () => { throw new Error("dry run sent calendar envelopes"); },
          },
        }, { "dry-run": true }),
        (error) => error === drySentinel,
      );
      check(`${item.sourceName} dry run remains lock-free beside a live writer`,
        holder.assertOwned() === true && !existsSync(statePath));
      holder.release();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const owner = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "gmail",
      home: f.home,
    });
    owner.release();
    let destructiveCalls = 0;
    await assert.rejects(
      applyDriveRemovals({
        uids: ["gmail:message-1"],
        base: "https://brain.invalid",
        adminKey: "synthetic-admin-key",
        state: { done: {}, removed: {} },
        dryRun: false,
        assertOwned: owner.assertOwned,
        fetchImpl: async () => {
          destructiveCalls++;
          return new Response("{}", { status: 200 });
        },
      }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_lost",
    );
    check("a lost Gmail owner cannot begin a destructive source-family request",
      destructiveCalls === 0, `destructive calls=${destructiveCalls}`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const owner = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "gmail",
      home: f.home,
    });
    let destructiveCalls = 0;
    let waits = 0;
    await assert.rejects(
      reconcileDocumentFamilies({
        families: [{
          base_doc_uid: "gmail:message-1",
          keep_doc_uids: ["gmail:message-1#part1of2", "gmail:message-1#part2of2"],
        }],
        base: "https://brain.invalid",
        adminKey: "synthetic-admin-key",
        assertOwned: owner.assertOwned,
        fetchImpl: async () => {
          destructiveCalls++;
          owner.release();
          const error = new Error("synthetic lost response");
          error.name = "TimeoutError";
          throw error;
        },
        sleep: async () => { waits++; },
        onRetry: () => {},
      }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_lost",
    );
    check("a Gmail cleanup retry rechecks its owner and cannot issue a second destructive request",
      destructiveCalls === 1 && waits === 1,
      `destructive calls=${destructiveCalls} waits=${waits}`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    let partialOwnerPath = null;
    const writeFailure = Object.assign(new Error("fixture owner write stopped"), { code: "ENOSPC" });
    assert.throws(
      () => acquireSourceIngestLock({
        manifestPath: f.manifestPath,
        sourceName: "gmail",
        home: f.home,
        writeOwner: (path, _content, options) => {
          partialOwnerPath = path;
          writeFileSync(path, "{", options);
          throw writeFailure;
        },
      }),
      (error) => error === writeFailure,
    );
    const path = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    check("a partial owner write is removed with its failed acquisition",
      partialOwnerPath !== null && !existsSync(partialOwnerPath) && !existsSync(path));
    const retry = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    check("an owner-record write failure leaves the source immediately retryable", retry.assertOwned() === true);
    retry.release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const path = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    const deadPid = 99_999_999;
    const token = "a".repeat(32);
    mkdirSync(path, { mode: 0o700 });
    const ownerPath = join(path, `owner-${deadPid}-${token}.json`);
    writeFileSync(ownerPath, "{", { mode: 0o600 });
    assert.throws(
      () => acquireSourceIngestLock({
        manifestPath: f.manifestPath,
        sourceName: "gmail",
        home: f.home,
        isOwnerAlive: () => false,
      }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_unsafe",
    );
    check("a recent malformed owner fails closed", existsSync(ownerPath));
    utimesSync(ownerPath, OLD, OLD);
    const recovered = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "gmail",
      home: f.home,
      isOwnerAlive: () => false,
    });
    check("a private correctly named malformed owner recovers only when stale and dead",
      recovered.assertOwned() === true);
    recovered.release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const holder = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    let entered = false;
    await assert.rejects(
      withSourceIngestLock(
        { manifestPath: f.manifestPath, sourceName: "gmail", home: f.home },
        async () => { entered = true; },
      ),
      (error) => error instanceof SourceIngestLockError &&
        error.code === "source_ingest_already_running" && error.retryable === true,
    );
    check("a live owner blocks a second task before its callback starts", entered === false);
    holder.release();

    const value = await withSourceIngestLock(
      { manifestPath: f.manifestPath, sourceName: "gmail", home: f.home },
      async ({ assertOwned }) => { assertOwned(); return 42; },
    );
    check("a successful task returns its value and releases the lease", value === 42 && !existsSync(holder.path));

    await assert.rejects(
      withSourceIngestLock(
        { manifestPath: f.manifestPath, sourceName: "gmail", home: f.home },
        async () => { throw new Error("fixture task stopped"); },
      ),
      /fixture task stopped/,
    );
    check("a thrown task also releases the lease", !existsSync(holder.path));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const live = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    const liveOwner = join(live.path, readdirSync(live.path)[0]);
    utimesSync(liveOwner, OLD, OLD);
    assert.throws(
      () => acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_already_running",
    );
    check("an old heartbeat cannot evict a live process", existsSync(liveOwner));
    live.release();

    for (const sourceName of ["upload", "drive", "gmail", "calendar"]) {
      const crashed = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName, home: f.home });
      const crashedOwner = join(crashed.path, readdirSync(crashed.path)[0]);
      utimesSync(crashedOwner, OLD, OLD);
      const successor = acquireSourceIngestLock({
        manifestPath: f.manifestPath,
        sourceName,
        home: f.home,
        isOwnerAlive: () => false,
      });
      check(`${sourceName} replaces a stale dead owner with a fresh lease`, successor.assertOwned() === true);
      check(`${sourceName} old holder cannot release its successor's token`,
        crashed.release() === false && successor.assertOwned() === true);
      successor.release();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const path = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    mkdirSync(path, { mode: 0o700 });
    assert.throws(
      () => acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_already_running",
    );
    check("a newly created ownerless directory is treated as an initializing live lock", existsSync(path));
    utimesSync(path, OLD, OLD);
    const recovered = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    check("an old empty crash residue can be recovered", recovered.assertOwned() === true);
    recovered.release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  let child = null;
  try {
    const childSource = `
      import { acquireSourceIngestLock } from ${JSON.stringify(LOCK_MODULE)};
      acquireSourceIngestLock({ manifestPath: process.argv[1], sourceName: "gmail", home: process.argv[2] });
      console.log("READY");
      setInterval(() => {}, 1_000);
    `;
    child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", childSource, f.manifestPath, f.home],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolveReady, rejectReady) => {
      let output = "";
      const timer = setTimeout(() => rejectReady(new Error("fixture lock child did not start")), 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!output.includes("READY")) return;
        clearTimeout(timer);
        resolveReady();
      });
      child.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
      child.once("exit", (code) => {
        if (output.includes("READY")) return;
        clearTimeout(timer);
        rejectReady(new Error(`fixture lock child exited ${code}`));
      });
    });
    const path = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    check("a separate process owns the same source lease", existsSync(path));
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const ownerPath = join(path, readdirSync(path)[0]);
    utimesSync(ownerPath, OLD, OLD);
    const recovered = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    check("a killed subprocess lease is reclaimed after its stale boundary", recovered.assertOwned() === true);
    recovered.release();
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
    rmSync(f.root, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const f = fixture();
  try {
    const permissive = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    chmodSync(permissive.path, 0o755);
    assert.throws(
      () => acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_unsafe",
    );
    check("a permissive live lock directory fails closed", (lstatSync(permissive.path).mode & 0o077) !== 0);
    chmodSync(permissive.path, 0o700);
    permissive.release();

    const path = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    const target = join(f.root, "unsafe-target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, path, "dir");
    assert.throws(
      () => acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_unsafe",
    );
    check("a symbolic-link lock path fails closed", lstatSync(path).isSymbolicLink());
    unlinkSync(path);
    rmdirSync(target);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const holder = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    const environment = {};
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    environment.HOME = f.home;
    environment.USERPROFILE = f.home;
    environment.NO_COLOR = "1";
    environment.BRAIN_GOOGLE_TOKEN_STORE = "file";
    const result = spawnSync(
      process.execPath,
      [CLI, "ingest", f.manifestPath, "--from", "gmail"],
      { encoding: "utf8", env: environment, timeout: 15_000 },
    );
    const output = `${result.stdout || ""}${result.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    check("the CLI refuses a second Gmail writer before credential or network access",
      result.status === 1 && /Gmail ingest is already running/.test(output) &&
      !/admin key|connect google|network|fetch/i.test(output), output.slice(-500));

    const dryResult = spawnSync(
      process.execPath,
      [CLI, "ingest", f.manifestPath, "--from", "gmail", "--dry-run"],
      { encoding: "utf8", env: environment, timeout: 15_000 },
    );
    const dryOutput = `${dryResult.stdout || ""}${dryResult.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    check("a read-only Gmail dry run does not contend with the durable writer",
      dryResult.status === 1 && !/Gmail ingest is already running/.test(dryOutput) &&
      /connect google|not connected|token/i.test(dryOutput), dryOutput.slice(-500));
    holder.release();

    const providerHolder = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "client-chat",
      home: f.home,
    });
    environment.BRAIN_SLACK_TOKEN_STORE = "file";
    const providerResult = spawnSync(
      process.execPath,
      [CLI, "ingest", f.manifestPath, "--from", "slack"],
      { encoding: "utf8", env: environment, timeout: 15_000 },
    );
    const providerOutput = `${providerResult.stdout || ""}${providerResult.stderr || ""}`
      .replace(/\x1b\[[0-9;]*m/g, "");
    check("manual and scheduled provider commands share one canonical source lease",
      providerResult.status === 1 && /client-chat ingest is already running/.test(providerOutput) &&
      !/admin key|not connected|network|fetch/i.test(providerOutput), providerOutput.slice(-500));

    const providerDryResult = spawnSync(
      process.execPath,
      [CLI, "ingest", f.manifestPath, "--from", "slack", "--dry-run"],
      { encoding: "utf8", env: environment, timeout: 15_000 },
    );
    const providerDryOutput = `${providerDryResult.stdout || ""}${providerDryResult.stderr || ""}`
      .replace(/\x1b\[[0-9;]*m/g, "");
    check("a provider dry run stays read-only and does not contend with its writer",
      providerDryResult.status === 1 && !/ingest is already running/.test(providerDryOutput) &&
      /not connected/.test(providerDryOutput), providerDryOutput.slice(-500));
    providerHolder.release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

console.log(`\n${ran} source ingest lock checks passed.`);

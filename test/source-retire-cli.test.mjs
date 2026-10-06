import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { cmdSources } from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { createProductFixture } from "../worker/test/product-contract-fixture.mjs";

const WINDOWS_RENDER_OPTIONS = Object.freeze({
  platform: "win32",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  scriptPath: "C:\\Program Files\\Financial Brain\\node_modules\\financial-brain-installer\\brain.mjs",
  env: { PATH: "" },
  existsSync: () => false,
});

function tempManifest(contents) {
  const root = mkdtempSync(join(process.env.HOME, "source-retire-cli-"));
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "retire-fixture.invalid" },
    corpora: {},
    ...contents,
  }));
  return { root, manifest };
}

function captureLogs(run) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  return Promise.resolve()
    .then(run)
    .then((value) => ({ value, output: lines.join("\n") }))
    .finally(() => { console.log = original; });
}

function client(fixture, counters = { requests: 0, credentials: 0 }) {
  return {
    counters,
    resolveAdminKey(path, options) {
      counters.credentials++;
      assert.ok(path.endsWith("brain.manifest.json"));
      assert.deepEqual(options, { ignoreEnvironment: true });
      return fixture.env.ADMIN_KEY;
    },
    async fetchImpl(url, init) {
      counters.requests++;
      return fixture.worker.fetch(
        new Request(url, init),
        fixture.env,
        { waitUntil() {}, passThroughOnException() {} },
      );
    },
  };
}

async function seed(fixture, source = "upload", count = 2) {
  const registered = await fixture.post(
    "/api/admin/brain/source-register", { source, kind: "upload" },
    { "X-Admin-Key": fixture.env.ADMIN_KEY },
  );
  assert.equal(registered.status, 200, await registered.text());
  for (let i = 0; i < count; i++) {
    const stored = await fixture.post("/api/admin/brain/ingest", {
      source_type: source,
      source_id: `cli-record-${i + 1}`,
      title: `CLI record ${i + 1}`,
      content: `Invented CLI content ${i + 1}.`,
    }, { "X-Admin-Key": fixture.env.ADMIN_KEY });
    assert.ok(stored.status === 200 || stored.status === 201, await stored.text());
  }
  const failed = await fixture.post("/api/admin/brain/source-receipt", {
    source, kind: "upload", status: "error", issue_code: "INGEST_FAILED",
    completed_at: "2026-10-01T00:00:00.000Z",
  }, { "X-Admin-Key": fixture.env.ADMIN_KEY });
  assert.equal(failed.status, 200, await failed.text());
}

test("brain sources --retire succeeds end to end and renders its Windows undo command", async () => {
  const fixture = await createProductFixture();
  const { root, manifest } = tempManifest({});
  try {
    await seed(fixture, "upload", 2);
    const access = client(fixture);
    const renderWindows = (text) => renderCliCommands(text, WINDOWS_RENDER_OPTIONS);
    const beforeCommand = renderWindows("brain sources <manifest> --json");
    const retireCommand = renderWindows("brain sources <manifest> --retire upload");
    assert.match(beforeCommand, /^& 'C:\\Program Files\\nodejs\\node\.exe'.* sources <manifest> --json$/);
    assert.match(retireCommand, /^& 'C:\\Program Files\\nodejs\\node\.exe'.* sources <manifest> --retire upload$/);
    const { value, output } = await captureLogs(() => cmdSources(manifest, {
      flags: { retire: "upload" },
      ...access,
      renderCliCommands: renderWindows,
    }));
    const upload = value.sources.find((row) => row.source_id === "upload");
    assert.equal(upload.freshness.state, "manual");
    assert.equal(upload.storage.logical_documents, 2);
    assert.match(output, /"upload" is retired: its 2 record\(s\) stay searchable/);
    assert.match(output, /Undo: & 'C:\\Program Files\\nodejs\\node\.exe' 'C:\\Program Files\\Financial Brain/);
    assert.match(output, /--unretire upload/);
    assert.equal(access.counters.credentials, 1);
    assert.ok(access.counters.requests >= 2, "the write and inventory read-back both ran");
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the manifest folder guard runs before any request or credential read", async () => {
  for (const folders of [
    ["/invented/archive"],
    [{ path: "/invented/archive" }],
  ]) {
    const fixture = await createProductFixture();
    const { root, manifest } = tempManifest({ corpora: { upload: { enabled: true, folders } } });
    const access = client(fixture);
    try {
      await assert.rejects(
        cmdSources(manifest, { flags: { retire: "upload" }, ...access }),
        /"upload" is still filled by a folder in this manifest, so the next load would bring it back\. Nothing was changed\./,
      );
      assert.deepEqual(access.counters, { requests: 0, credentials: 0 });
    } finally {
      fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("folder guard controls reach the Worker for another name and for a disabled upload corpus", async () => {
  for (const scenario of [
    {
      corpora: { upload: { enabled: true, folders: ["/invented/archive"] } },
      source: "archive-2026",
    },
    {
      corpora: { upload: { enabled: false, folders: ["/invented/archive"] } },
      source: "upload",
    },
  ]) {
    const fixture = await createProductFixture();
    const { root, manifest } = tempManifest({ corpora: scenario.corpora });
    const access = client(fixture);
    try {
      await seed(fixture, scenario.source, 1);
      const value = await cmdSources(manifest, {
        flags: { retire: scenario.source }, ...access, silent: true,
      });
      assert.equal(value.sources.find((row) => row.source_id === scenario.source).freshness.state, "manual");
      assert.equal(access.counters.credentials, 1);
      assert.ok(access.counters.requests >= 2, "the allowed control reached the Worker and read back inventory");
    } finally {
      fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an older Worker 404 gives the update instruction once and does not read inventory", async () => {
  const fixture = await createProductFixture();
  const { root, manifest } = tempManifest({});
  let requests = 0;
  let credentials = 0;
  try {
    await assert.rejects(cmdSources(manifest, {
      flags: { retire: "upload" },
      resolveAdminKey() { credentials++; return fixture.env.ADMIN_KEY; },
      async fetchImpl() {
        requests++;
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404, headers: { "Content-Type": "application/json" },
        });
      },
    }), /This Brain does not support retiring a source yet; update it first\. Nothing was changed\./);
    assert.equal(credentials, 1);
    assert.equal(requests, 1);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retirement flags reject every forbidden combination before credentials or requests", async () => {
  const fixture = await createProductFixture();
  const { root, manifest } = tempManifest({});
  try {
    for (const flags of [
      { retire: "upload", unretire: "upload" },
      { retire: "upload", add: "archive-2026" },
      { retire: "upload", refresh: "never" },
      { retire: "upload", json: true },
      { retire: "upload", recovery: true },
    ]) {
      const access = client(fixture);
      await assert.rejects(cmdSources(manifest, { flags, ...access }), /cannot be combined/);
      assert.deepEqual(access.counters, { requests: 0, credentials: 0 });
    }
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

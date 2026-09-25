import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyCliCredentialBoundary,
  cmdUpdate,
  dispatchUpdateCli,
  readUpdateBacklog,
  updateCommandTarget,
} from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const PENDING_MESSAGE = (pending) => renderCliCommands(
  `This Brain is still processing ${pending} queued search update(s). Updating now would pause it mid-queue. ` +
    "Nothing was changed. Wait until `brain health` says query-ready, then run the update again.",
);

const UNREADABLE_MESSAGE = renderCliCommands(
  "The authenticated documents backlog read failed after 1 read, so this Brain's queued search updates could not " +
    "be read. Updating now could pause it mid-queue. Nothing was changed. A large Brain's database can be briefly " +
    "too busy to answer: wait a few minutes, then run `brain update` again. Never run `brain drain` in a loop to " +
    "get past this.",
);

const FORCE_WARNING = (pending) => renderCliCommands(
  `This Brain is still processing ${pending} queued search update(s). ` +
    "`--force` will update anyway and may pause it mid-queue.",
);

function fixtureManifest() {
  return {
    client: { slug: "fixture" },
    brain: { version: "0.4.7", domain: "brain.example.invalid" },
    infrastructure: {
      cloudflare: {
        account_id: "1".repeat(32),
        auth_profile: `financial-brain-${"2".repeat(24)}`,
        storage: "d1",
        d1_database_id: "11111111-2222-4333-8444-555555555555",
      },
    },
  };
}

function projectionInventory(overrides = {}) {
  const pending = overrides.pending ?? 0;
  const upserts = overrides.upserts ?? pending;
  const deletes = overrides.deletes ?? 0;
  const submitted = overrides.submitted ?? 0;
  const expected = overrides.expected ?? 4;
  const actual = overrides.actual ?? expected;
  const ready = overrides.ready ?? (pending === 0 && actual === expected);
  const oldestQueuedAt = Object.hasOwn(overrides, "oldestQueuedAt")
    ? overrides.oldestQueuedAt
    : pending > 0 ? 1_750_000_000_000 : null;
  return {
    version: overrides.version ?? "0.4.7",
    backend: overrides.backend ?? "d1",
    vector_drain_mode: overrides.drainMode ?? "active",
    rows: [],
    vector_backlog: {
      pending,
      upserts,
      deletes,
      submitted,
      oldest_queued_at: oldestQueuedAt,
    },
    vector_readiness: {
      ready,
      reason: Object.hasOwn(overrides, "reason")
        ? overrides.reason
        : ready ? null : submitted > 0
          ? "accepted_mutation_processing"
          : "vector_work_queued",
      expected_vectors: expected,
      actual_vectors: actual,
      pending,
      submitted,
      oldest_queued_at: oldestQueuedAt,
    },
  };
}

function streamedResponse(body, { status = 200, contentLength } = {}) {
  const bytes = Buffer.from(String(body), "utf8");
  let sent = false;
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    async json() {
      return JSON.parse(bytes.toString("utf8"));
    },
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
}

function inventoryResponse(inventory, options = {}) {
  return streamedResponse(JSON.stringify(inventory), options);
}

function updateHarness(manifestPath, readUpdateBacklog, events) {
  return {
    discoverInstalledManifest: () => ({ path: manifestPath, source: "remembered" }),
    readUpdateBacklog: async (...args) => {
      events.push("authenticated documents backlog read");
      return readUpdateBacklog(...args);
    },
    adoptCloudflareAuthProfile: async () => {
      events.push("profile adoption");
    },
    withCloudflareControl: async (action) => {
      events.push("control boundary");
      return action();
    },
    cmdVerify: async () => {
      events.push("verification");
    },
    cmdUpgrade: async () => {
      events.push("paused vector-drain deployment");
      return { updated: true };
    },
    reconcileExistingOwnerAgents: null,
    writeClaudeWorkspaceGuideAfterUpdate: null,
    installTechnicianSkills: () => [{ root: ".codex", status: "verified" }],
    reportSkillRefreshOk: () => {},
    reportSkillRefreshWarning: () => {},
  };
}

async function withFixture(run) {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-update-pending-"));
  const manifestPath = join(sandbox, "brain.manifest.json");
  const original = `${JSON.stringify(fixtureManifest(), null, 2)}\n`;
  writeFileSync(manifestPath, original);
  try {
    await run({ manifestPath, original });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("pending vector work refuses before adoption, verification, deployment, or a manifest write", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    const events = [];
    let error = null;
    try {
      await cmdUpdate(manifestPath, updateHarness(
        manifestPath,
        async () => ({ pending: 7 }),
        events,
      ));
    } catch (caught) {
      error = caught;
    }

    assert.equal(error?.message, PENDING_MESSAGE(7));
    assert.deepEqual(events, ["authenticated documents backlog read"]);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("an unreadable backlog fails closed and names the failed read", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    const events = [];
    let error = null;
    try {
      await cmdUpdate(manifestPath, updateHarness(
        manifestPath,
        async () => {
          throw new Error("private transport detail must not escape");
        },
        events,
      ));
    } catch (caught) {
      error = caught;
    }

    assert.equal(error?.message, UNREADABLE_MESSAGE);
    assert.doesNotMatch(error?.message || "", /private transport detail/);
    assert.deepEqual(events, ["authenticated documents backlog read"]);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("an empty backlog reaches the paused-deployment stage", async () => {
  await withFixture(async ({ manifestPath }) => {
    const events = [];
    const result = await cmdUpdate(manifestPath, updateHarness(
      manifestPath,
      async () => ({ pending: 0 }),
      events,
    ));

    assert.deepEqual(result, { updated: true });
    assert.deepEqual(events, [
      "authenticated documents backlog read",
      "profile adoption",
      "control boundary",
      "verification",
      "paused vector-drain deployment",
    ]);
  });
});

test("force with pending work proceeds after one risk warning", async () => {
  await withFixture(async ({ manifestPath }) => {
    const events = [];
    const output = [];
    const priorLog = console.log;
    console.log = (...values) => output.push(values.map(String).join(" "));
    let result;
    try {
      result = await dispatchUpdateCli([manifestPath, "--force"], {
        updateOptions: updateHarness(manifestPath, async () => ({ pending: 3 }), events),
      });
    } finally {
      console.log = priorLog;
    }

    assert.deepEqual(result, { updated: true });
    assert.equal(
      output.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
        .filter((line) => line.includes(FORCE_WARNING(3))).length,
      1,
    );
    assert.equal(events.at(-1), "paused vector-drain deployment");
  });
});

test("work enqueued after the initial gate refuses at the immediate pre-pause gate", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    const events = [];
    let error = null;
    try {
      await cmdUpdate(manifestPath, {
        discoverInstalledManifest: () => ({ path: manifestPath, source: "remembered" }),
        readUpdateBacklog: async () => {
          events.push("initial backlog read");
          return { pending: 0 };
        },
        adoptCloudflareAuthProfile: async () => events.push("profile adoption"),
        withCloudflareControl: async (action) => {
          events.push("control boundary");
          return action();
        },
        cmdVerify: async () => events.push("verification"),
        upgradeOptions: {
          resolveAccount: async () => ({ id: "1".repeat(32) }),
          d1Query: async (_account, _database, sql) => {
            if (/sqlite_master/iu.test(sql)) return { results: [{ name: "install_state" }] };
            if (/SELECT \* FROM install_state/iu.test(sql)) {
              events.push("install state");
              return {
                results: [{
                  client_slug: "fixture",
                  product_version: "0.4.7",
                  schema_version: 46,
                }],
              };
            }
            if (/INSERT INTO upgrade_runs/iu.test(sql)) events.push("history write");
            return { results: [] };
          },
          cf: async () => {
            events.push("bookmark");
            return { bookmark: "fixture-bookmark" };
          },
          readUpdateBacklog: async () => {
            events.push("pre-pause backlog read");
            return { pending: 1 };
          },
          cmdDeploy: async () => {
            events.push("paused deployment");
            throw new Error("control probe: current behavior reached deployment");
          },
          cmdHealth: async () => events.push("health"),
          cmdMigrate: async () => events.push("migration"),
        },
        reconcileExistingOwnerAgents: null,
        writeClaudeWorkspaceGuideAfterUpdate: null,
      });
    } catch (caught) {
      error = caught;
    }

    assert.ok(error, "the second queue decision must refuse");
    assert.deepEqual(events, [
      "initial backlog read",
      "profile adoption",
      "control boundary",
      "verification",
      "install state",
      "bookmark",
      "pre-pause backlog read",
      "history write",
    ]);
    assert.doesNotMatch(events.join(","), /deployment|migration|health/u);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("the production reader uses the authenticated documents aggregate without normalizing pending", async () => {
  await withFixture(async ({ manifestPath }) => {
    const calls = [];
    const receipt = await readUpdateBacklog(manifestPath, {
      resolveAdminKey: (path, options) => {
        calls.push({ stage: "credential", path, options });
        return "unit-test-admin-key";
      },
      http: async (url, init, options) => {
        calls.push({ stage: "request", url, init, options });
        return inventoryResponse(projectionInventory({
          pending: 4,
          upserts: 3,
          deletes: 1,
          submitted: 2,
        }));
      },
    });

    assert.deepEqual(receipt, { pending: 4 });
    assert.equal(calls[0].options.ignoreEnvironment, true);
    assert.equal(calls[0].options.read(calls[0].path), readFileSync(manifestPath, "utf8"));
    assert.equal(calls[1].url, "https://brain.example.invalid/api/admin/brain/documents");
    assert.equal(calls[1].init.headers["X-Admin-Key"], "unit-test-admin-key");
    assert.equal(calls[1].options.what, "the update backlog check");
  });
});

test("the production reader refuses partial or inconsistent aggregate receipts", async () => {
  await withFixture(async ({ manifestPath }) => {
    const cases = [];
    for (const field of [
      "version", "backend", "vector_drain_mode", "vector_backlog", "vector_readiness",
    ]) {
      const inventory = projectionInventory();
      delete inventory[field];
      cases.push([`missing aggregate ${field}`, inventory]);
    }
    for (const field of ["upserts", "deletes", "submitted", "oldest_queued_at"]) {
      const inventory = projectionInventory();
      delete inventory.vector_backlog[field];
      cases.push([`missing backlog ${field}`, inventory]);
    }
    for (const field of [
      "ready", "reason", "expected_vectors", "actual_vectors", "pending", "submitted",
      "oldest_queued_at",
    ]) {
      const inventory = projectionInventory();
      delete inventory.vector_readiness[field];
      cases.push([`missing readiness ${field}`, inventory]);
    }
    const inconsistent = projectionInventory({ pending: 2, upserts: 1, deletes: 0 });
    cases.push(["inconsistent queue total", inconsistent]);
    cases.push(["submitted exceeds pending", projectionInventory({ pending: 1, submitted: 2 })]);
    const errorReceipt = projectionInventory();
    errorReceipt.vector_backlog.error = "private detail must not escape";
    cases.push(["queue error receipt", errorReceipt]);
    const mismatched = projectionInventory({ pending: 2, submitted: 1 });
    mismatched.vector_readiness.pending = 1;
    cases.push(["mismatched readiness queue", mismatched]);

    for (const [name, inventory] of cases) {
      let requests = 0;
      await assert.rejects(
        readUpdateBacklog(manifestPath, {
          resolveAdminKey: () => "unit-test-admin-key",
          http: async () => {
            requests++;
            return inventoryResponse(inventory);
          },
        }),
        (error) => error?.message === "authenticated documents backlog read failed",
        name,
      );
      assert.equal(requests, 1, `${name} must reach the authenticated aggregate decision`);
    }
  });
});

test("the production reader requires exact HTTP 200 and a bounded streamed body", async () => {
  await withFixture(async ({ manifestPath }) => {
    for (const [name, response] of [
      ["non-200 2xx", inventoryResponse(projectionInventory(), { status: 206 })],
      ["oversized", inventoryResponse(projectionInventory(), { contentLength: 4 * 1024 * 1024 + 1 })],
    ]) {
      let requests = 0;
      await assert.rejects(
        readUpdateBacklog(manifestPath, {
          resolveAdminKey: () => "unit-test-admin-key",
          http: async () => {
            requests++;
            return response;
          },
        }),
        (error) => error?.message === "authenticated documents backlog read failed",
        name,
      );
      assert.equal(requests, 1, `${name} must reach the authenticated response decision`);
    }
  });
});

test("the production reader stops a manifest replacement before attaching the key", async () => {
  await withFixture(async ({ manifestPath }) => {
    let credentialReads = 0;
    let replacementAttempted = false;
    let requests = 0;
    await assert.rejects(
      readUpdateBacklog(manifestPath, {
        resolveAdminKey: (path, options) => {
          credentialReads++;
          assert.equal(options.read(path), readFileSync(manifestPath, "utf8"));
          const replacement = fixtureManifest();
          replacement.brain.domain = "replacement.example.invalid";
          writeFileSync(manifestPath, `${JSON.stringify(replacement, null, 2)}\n`);
          replacementAttempted = true;
          return "unit-test-admin-key";
        },
        http: async () => {
          requests++;
          return inventoryResponse(projectionInventory());
        },
      }),
      (error) => error?.message === "authenticated documents backlog read failed",
    );
    assert.equal(credentialReads, 1, "the pinned credential decision must be reached");
    assert.equal(replacementAttempted, true, "the manifest replacement seam must run");
    assert.equal(requests, 0, "no key may reach a destination after manifest replacement");
  });
});

test("the force switch remains on the live update boundary and is documented", () => {
  for (const argv of [
    ["--force"],
    ["brain.manifest.json", "--force"],
    ["--force", "brain.manifest.json"],
    ["brain.manifest.json", "--adopt-cloudflare-profile", "--force"],
  ]) {
    assert.equal(classifyCliCredentialBoundary("update", argv), "update");
  }
  assert.equal(updateCommandTarget("--force", { force: "brain.manifest.json" }), "brain.manifest.json");

  const help = spawnSync(process.execPath, [fileURLToPath(new URL("../brain.mjs", import.meta.url)), "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes(renderCliCommands("brain update     [manifest] --force")));
  assert.match(help.stdout, /queued search update/);
});

/* ---- transient D1 CPU resets on large Brains (field report, 2026-09-25) ---- */

const CPU_RESET_BODY = JSON.stringify({
  error: "D1_ERROR: D1 DB exceeded its CPU time limit and was reset.",
});

const UNREADABLE_AFTER = (reads) => renderCliCommands(
  `The authenticated documents backlog read failed after ${reads} read${reads === 1 ? "" : "s"}, ` +
    "so this Brain's queued search updates could not be read. Updating now could pause it mid-queue. " +
    "Nothing was changed. A large Brain's database can be briefly too busy to answer: wait a few minutes, " +
    "then run `brain update` again. Never run `brain drain` in a loop to get past this.",
);

// Replays one scripted response per request and records every request, sleep
// and per-attempt timeout so no test ever waits on a real backoff.
function scriptedReader(manifestPath, script) {
  const log = { requests: 0, sleeps: [], timeouts: [] };
  const options = {
    resolveAdminKey: () => "unit-test-admin-key",
    sleep: async (ms) => {
      log.sleeps.push(ms);
    },
    http: async (_url, _init, requestOptions) => {
      log.timeouts.push(requestOptions?.timeoutMs);
      const step = script[log.requests++];
      if (!step) throw new Error("the scripted fixture ran out of responses");
      if (step.network) {
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET", retryable: true });
      }
      return streamedResponse(step.body, { status: step.status });
    },
  };
  return { log, options, read: () => readUpdateBacklog(manifestPath, options) };
}

test("two transient 500s then an empty backlog proceeds after bounded backoff", async () => {
  await withFixture(async ({ manifestPath }) => {
    const { log, read } = scriptedReader(manifestPath, [
      { status: 500, body: CPU_RESET_BODY },
      { status: 500, body: CPU_RESET_BODY },
      { status: 200, body: JSON.stringify(projectionInventory({ pending: 0 })) },
    ]);

    assert.deepEqual(await read(), { pending: 0 });
    assert.equal(log.requests, 3);
    assert.deepEqual(log.sleeps, [10_000, 30_000]);
    assert.ok(log.timeouts.every((ms) => Number.isSafeInteger(ms) && ms >= 90_000), JSON.stringify(log.timeouts));
  });
});

test("a CPU-reset body, a network error, and 502 are each retried", async () => {
  await withFixture(async ({ manifestPath }) => {
    const { log, read } = scriptedReader(manifestPath, [
      { network: true },
      { status: 502, body: "bad gateway" },
      { status: 200, body: JSON.stringify(projectionInventory({ pending: 0 })) },
    ]);
    assert.deepEqual(await read(), { pending: 0 });
    assert.equal(log.requests, 3);

    const cpu = scriptedReader(manifestPath, [
      { status: 400, body: CPU_RESET_BODY },
      { status: 200, body: JSON.stringify(projectionInventory({ pending: 0 })) },
    ]);
    assert.deepEqual(await cpu.read(), { pending: 0 });
    assert.equal(cpu.log.requests, 2);
  });
});

test("three transient 500s refuse the update and name how many reads were tried", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    const { log, options } = scriptedReader(manifestPath, [
      { status: 500, body: CPU_RESET_BODY },
      { status: 500, body: CPU_RESET_BODY },
      { status: 500, body: CPU_RESET_BODY },
    ]);
    const events = [];
    let error = null;
    try {
      await cmdUpdate(manifestPath, {
        ...updateHarness(manifestPath, readUpdateBacklog, events),
        updateBacklogOptions: options,
      });
    } catch (caught) {
      error = caught;
    }

    assert.equal(error?.message, UNREADABLE_AFTER(3));
    assert.doesNotMatch(error?.message || "", /CPU time limit|D1_ERROR/);
    assert.equal(log.requests, 3);
    assert.deepEqual(log.sleeps, [10_000, 30_000]);
    assert.deepEqual(events, ["authenticated documents backlog read"]);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("401, 403 and 404 refuse at once without a retry", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    for (const status of [401, 403, 404]) {
      const { log, options } = scriptedReader(manifestPath, [
        { status, body: CPU_RESET_BODY },
        { status: 200, body: JSON.stringify(projectionInventory({ pending: 0 })) },
      ]);
      const events = [];
      let error = null;
      try {
        await cmdUpdate(manifestPath, {
          ...updateHarness(manifestPath, readUpdateBacklog, events),
          updateBacklogOptions: options,
        });
      } catch (caught) {
        error = caught;
      }

      assert.equal(error?.message, UNREADABLE_AFTER(1), `HTTP ${status}`);
      assert.equal(log.requests, 1, `HTTP ${status} must not be retried`);
      assert.deepEqual(log.sleeps, [], `HTTP ${status} must not back off`);
      assert.deepEqual(events, ["authenticated documents backlog read"]);
      assert.equal(readFileSync(manifestPath, "utf8"), original);
    }
  });
});

test("a readable backlog with pending work refuses before any deploy call", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    const { log, options } = scriptedReader(manifestPath, [
      { status: 500, body: CPU_RESET_BODY },
      { status: 200, body: JSON.stringify(projectionInventory({ pending: 5, upserts: 5 })) },
    ]);
    const events = [];
    let decided = null;
    let error = null;
    try {
      await cmdUpdate(manifestPath, {
        ...updateHarness(manifestPath, async (...args) => {
          decided = await readUpdateBacklog(...args);
          events.push("queue decision");
          return decided;
        }, events),
        updateBacklogOptions: options,
      });
    } catch (caught) {
      error = caught;
    }

    assert.deepEqual(decided, { pending: 5 }, "the queue decision point must be reached");
    assert.equal(error?.message, PENDING_MESSAGE(5));
    assert.equal(log.requests, 2);
    assert.deepEqual(events, ["authenticated documents backlog read", "queue decision"]);
    assert.ok(!events.includes("paused vector-drain deployment"), "the deploy must never be reached");
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("a missing admin key refuses without sending a read or claiming one", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    let requests = 0;
    const events = [];
    let error = null;
    try {
      await cmdUpdate(manifestPath, {
        ...updateHarness(manifestPath, readUpdateBacklog, events),
        updateBacklogOptions: {
          resolveAdminKey: () => undefined,
          sleep: async () => assert.fail("no backoff without a read"),
          http: async () => {
            requests++;
            return inventoryResponse(projectionInventory());
          },
        },
      });
    } catch (caught) {
      error = caught;
    }

    assert.equal(error?.message, renderCliCommands(
      "The authenticated documents backlog read could not be sent: this computer's admin key or Brain address " +
        "could not be loaded. Nothing was changed. Fix that, then run `brain update` again.",
    ));
    assert.equal(requests, 0);
    assert.deepEqual(events, ["authenticated documents backlog read"]);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

/* ---- one backlog rule for health, preview, and both update gates ---- */

// The pre-pause gate and the initial gate read the same receipt through the
// shared projection validator. A pre-summary Worker's exact receipt carries
// none of the three bounded fields; a bounded Worker carries all three plus
// the readiness pair. Anything in between matches no shipped Worker.
function boundedInventory(overrides = {}) {
  const inventory = projectionInventory(overrides);
  const capped = overrides.capped === true;
  Object.assign(inventory.vector_backlog, {
    pending_is_capped: capped,
    pending_display: capped ? "10,000+" : String(inventory.vector_backlog.pending),
    component_counts_exact: !capped,
  });
  Object.assign(inventory.vector_readiness, {
    pending_is_capped: capped,
    submitted_counts_exact: !capped,
  });
  return inventory;
}

function cappedInventory() {
  return boundedInventory({ capped: true, pending: 10_001, upserts: 10_001, submitted: 0 });
}

const CAPPED_PENDING_MESSAGE = renderCliCommands(
  "This Brain is still processing over 10,000 queued search update(s). Updating now would pause it mid-queue. " +
    "Nothing was changed. Wait until `brain health` says query-ready, then run the update again.",
);

// A refusal inside an upgrade stage is wrapped with the stage name and the
// recovery bookmark guidance; the gate's own sentence is the first line.
function prePauseRefusal(message) {
  return `update stopped during paused vector-drain deployment: ${message}\n`;
}

// Drives the real cmdUpgrade through the immediate pre-pause gate with the
// production reader and one scripted aggregate response.
async function prePauseGate(manifestPath, inventory) {
  const events = [];
  const { log, options } = scriptedReader(manifestPath, [
    { status: 200, body: JSON.stringify(inventory) },
  ]);
  let error = null;
  try {
    await cmdUpdate(manifestPath, {
      discoverInstalledManifest: () => ({ path: manifestPath, source: "remembered" }),
      readUpdateBacklog: async () => ({ pending: 0 }),
      adoptCloudflareAuthProfile: async () => {},
      withCloudflareControl: async (action) => action(),
      cmdVerify: async () => {},
      upgradeOptions: {
        resolveAccount: async () => ({ id: "1".repeat(32) }),
        d1Query: async (_account, _database, sql) => {
          if (/sqlite_master/iu.test(sql)) return { results: [{ name: "install_state" }] };
          if (/SELECT \* FROM install_state/iu.test(sql)) {
            return {
              results: [{ client_slug: "fixture", product_version: "0.4.7", schema_version: 46 }],
            };
          }
          return { results: [] };
        },
        cf: async () => ({ bookmark: "fixture-bookmark" }),
        readUpdateBacklog,
        updateBacklogOptions: options,
        cmdDeploy: async () => {
          events.push("paused deployment");
          throw new Error("fixture stop after the paused deployment started");
        },
        cmdHealth: async () => events.push("health"),
        cmdMigrate: async () => events.push("migration"),
      },
      reconcileExistingOwnerAgents: null,
      writeClaudeWorkspaceGuideAfterUpdate: null,
    });
  } catch (caught) {
    error = caught;
  }
  return { error, events, log };
}

test("a pre-summary Worker's exact empty backlog proceeds through both gates", async () => {
  await withFixture(async ({ manifestPath }) => {
    const legacy = projectionInventory({ pending: 0 });
    assert.equal(Object.hasOwn(legacy.vector_backlog, "pending_is_capped"), false);
    const { read } = scriptedReader(manifestPath, [
      { status: 200, body: JSON.stringify(legacy) },
    ]);
    assert.deepEqual(await read(), { pending: 0 });

    const { error, events, log } = await prePauseGate(manifestPath, legacy);
    assert.equal(log.requests, 1);
    assert.deepEqual(events, ["paused deployment"], error?.message);
  });
});

test("a pre-summary Worker's exact queued backlog refuses at both gates", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    const legacy = projectionInventory({ pending: 3, upserts: 2, deletes: 1, submitted: 1 });
    const { read } = scriptedReader(manifestPath, [
      { status: 200, body: JSON.stringify(legacy) },
    ]);
    assert.deepEqual(await read(), { pending: 3 });

    const initial = scriptedReader(manifestPath, [{ status: 200, body: JSON.stringify(legacy) }]);
    const events = [];
    await assert.rejects(
      cmdUpdate(manifestPath, {
        ...updateHarness(manifestPath, readUpdateBacklog, events),
        updateBacklogOptions: initial.options,
      }),
      (error) => error?.message === PENDING_MESSAGE(3),
    );
    assert.deepEqual(events, ["authenticated documents backlog read"]);

    const prePause = await prePauseGate(manifestPath, legacy);
    assert.ok(prePause.error?.message?.startsWith(prePauseRefusal(renderCliCommands(
      "This Brain gained 3 queued search update(s) before the paused deployment. " +
        "The paused deployment was not started. Wait until `brain health` says query-ready, then run the update again.",
    ))), prePause.error?.message);
    assert.deepEqual(prePause.events, []);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("a bounded Worker's exact empty backlog proceeds through both gates", async () => {
  await withFixture(async ({ manifestPath }) => {
    const bounded = boundedInventory({ pending: 0 });
    const { read } = scriptedReader(manifestPath, [
      { status: 200, body: JSON.stringify(bounded) },
    ]);
    assert.deepEqual(await read(), { pending: 0 });

    const { error, events } = await prePauseGate(manifestPath, bounded);
    assert.deepEqual(events, ["paused deployment"], error?.message);
  });
});

test("a capped backlog is never read as zero and refuses at both gates", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    const { read } = scriptedReader(manifestPath, [
      { status: 200, body: JSON.stringify(cappedInventory()) },
    ]);
    const receipt = await read();
    assert.equal(receipt.pending_is_capped, true);
    assert.ok(receipt.pending > 10_000, JSON.stringify(receipt));

    const initial = scriptedReader(manifestPath, [
      { status: 200, body: JSON.stringify(cappedInventory()) },
    ]);
    const events = [];
    await assert.rejects(
      cmdUpdate(manifestPath, {
        ...updateHarness(manifestPath, readUpdateBacklog, events),
        updateBacklogOptions: initial.options,
      }),
      (error) => error?.message === CAPPED_PENDING_MESSAGE,
    );
    assert.deepEqual(events, ["authenticated documents backlog read"]);

    const prePause = await prePauseGate(manifestPath, cappedInventory());
    assert.ok(prePause.error?.message?.startsWith(prePauseRefusal(renderCliCommands(
      "This Brain gained over 10,000 queued search update(s) before the paused deployment. " +
        "The paused deployment was not started. Wait until `brain health` says query-ready, then run the update again.",
    ))), prePause.error?.message);
    assert.deepEqual(prePause.events, []);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("partial or malformed bounded receipts refuse on one read at both gates", async () => {
  await withFixture(async ({ manifestPath, original }) => {
    const cases = [];
    for (const kept of [
      ["pending_is_capped"],
      ["pending_display"],
      ["component_counts_exact"],
      ["pending_is_capped", "pending_display"],
      ["pending_display", "component_counts_exact"],
    ]) {
      const inventory = boundedInventory({ pending: 0 });
      for (const field of ["pending_is_capped", "pending_display", "component_counts_exact"]) {
        if (!kept.includes(field)) delete inventory.vector_backlog[field];
      }
      cases.push([`backlog keeps only ${kept.join("+")}`, inventory]);
    }
    const halfReadiness = boundedInventory({ pending: 0 });
    delete halfReadiness.vector_readiness.submitted_counts_exact;
    cases.push(["readiness keeps half of its bounded pair", halfReadiness]);
    const boundedBacklogLegacyReadiness = boundedInventory({ pending: 0 });
    delete boundedBacklogLegacyReadiness.vector_readiness.pending_is_capped;
    delete boundedBacklogLegacyReadiness.vector_readiness.submitted_counts_exact;
    cases.push(["bounded backlog with pre-summary readiness", boundedBacklogLegacyReadiness]);
    const extraField = projectionInventory({ pending: 0 });
    extraField.vector_backlog.pending_estimate = 0;
    cases.push(["pre-summary backlog with an unknown field", extraField]);
    const cappedZero = cappedInventory();
    Object.assign(cappedZero.vector_backlog, { pending: 0, upserts: 0 });
    Object.assign(cappedZero.vector_readiness, { pending: 0 });
    cases.push(["capped flag on a zero count", cappedZero]);
    const cappedWithoutDisplay = cappedInventory();
    cappedWithoutDisplay.vector_backlog.pending_display = null;
    cases.push(["capped flag without its display", cappedWithoutDisplay]);
    const stringFlag = boundedInventory({ pending: 0 });
    stringFlag.vector_backlog.pending_is_capped = "false";
    cases.push(["capped flag as a string", stringFlag]);
    const uncappedOverLimit = boundedInventory({ pending: 10_001, upserts: 10_001 });
    cases.push(["uncapped count above the bound", uncappedOverLimit]);

    for (const [name, inventory] of cases) {
      const { log, read } = scriptedReader(manifestPath, [
        { status: 200, body: JSON.stringify(inventory) },
        { status: 200, body: JSON.stringify(projectionInventory({ pending: 0 })) },
      ]);
      await assert.rejects(
        read(),
        (error) => error?.message === "authenticated documents backlog read failed" && error.attempts === 1,
        name,
      );
      assert.equal(log.requests, 1, `${name} must not be retried`);
      assert.deepEqual(log.sleeps, [], `${name} must not back off`);

      const prePause = await prePauseGate(manifestPath, inventory);
      assert.ok(prePause.error?.message?.startsWith(prePauseRefusal(renderCliCommands(
        "The immediate pre-pause documents backlog read failed after 1 read, " +
          "so this Brain's queued search updates could not be read. The paused deployment was not started. " +
          "A large Brain's database can be briefly too busy to answer: wait a few minutes, then run " +
          "`brain update` again. Never run `brain drain` in a loop to get past this.",
      ))), `${name}: ${prePause.error?.message}`);
      assert.deepEqual(prePause.events, [], `${name} must not start the paused deployment`);
    }
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

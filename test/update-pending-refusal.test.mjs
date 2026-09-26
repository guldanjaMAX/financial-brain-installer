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
    "`--force` continues past this first check only; the final check just before the paused deployment " +
    "reads the queue again and still refuses queued work.",
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
// and per-attempt timeout so no test ever waits on a real backoff. A pre-0.4.7
// receipt with queued work is followed by one public /health read; that read
// is answered from `health` (a step like the script's) and logged apart.
function scriptedReader(manifestPath, script, { health } = {}) {
  const log = { requests: 0, sleeps: [], timeouts: [], healthReads: 0, healthInits: [] };
  const options = {
    resolveAdminKey: () => "unit-test-admin-key",
    sleep: async (ms) => {
      log.sleeps.push(ms);
    },
    http: async (url, init, requestOptions) => {
      if (new URL(url).pathname === "/health") {
        log.healthReads += 1;
        log.healthInits.push(init);
        if (!health) throw new Error("the scripted fixture has no /health answer");
        if (health.network) {
          throw Object.assign(new Error("connection reset"), { code: "ECONNRESET", retryable: true });
        }
        return streamedResponse(health.body, { status: health.status ?? 200 });
      }
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

/* ---- resuming an earlier attempt, pre-0.4.7 Workers, and domainless manifests ---- */

const PRODUCT_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

// The exact authenticated envelope v0.4.6 handleDocuments returns for a D1
// Brain: backend, rows, outboxDepth, and vectorReadiness. It carries neither
// the Worker version nor its vector drain mode.
function v046DocumentsEnvelope(pending = 0) {
  const oldest = pending > 0 ? 1_750_000_000_000 : null;
  return {
    backend: "d1",
    rows: [{ source: "drive", documents: 3, chunks: 9 }],
    vector_backlog: { pending, upserts: pending, deletes: 0, submitted: 0, oldest_queued_at: oldest },
    vector_readiness: {
      ready: pending === 0,
      reason: pending > 0 ? "vector_work_queued" : null,
      expected_vectors: 9,
      actual_vectors: 9,
      pending,
      submitted: 0,
      oldest_queued_at: oldest,
      mutation_submitted_at: null,
      projection_status: "verified",
      bootstrap_epoch: 0,
      action: pending > 0
        ? "Run `brain drain <manifest>`; it confirms provider visibility without re-embedding accepted rows."
        : null,
    },
  };
}

async function withManifest(mutate, run) {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-update-resume-"));
  const manifestPath = join(sandbox, "brain.manifest.json");
  const manifest = fixtureManifest();
  mutate(manifest);
  const original = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, original);
  try {
    await run({ manifestPath, original });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// Drives the real cmdUpdate into the real cmdUpgrade with the production
// reader at BOTH gates. Only the HTTP transport, the Cloudflare control-plane
// stubs, and the paused deployment itself are faked; the deployment throws a
// fixture stop so reaching it is the observable "the update proceeded" signal.
async function throughBothGates(manifestPath, {
  first,
  second = first,
  force = false,
  subdomain = "owner-sub",
  health,
} = {}) {
  const events = [];
  const cfPaths = [];
  const urls = [];
  const initial = scriptedReader(manifestPath, [{ status: 200, body: JSON.stringify(first) }], { health });
  const prePause = scriptedReader(manifestPath, [{ status: 200, body: JSON.stringify(second) }], { health });
  for (const [label, reader] of [["initial", initial], ["pre-pause", prePause]]) {
    const scripted = reader.options.http;
    reader.options.http = async (url, ...rest) => {
      // The public drain-mode read is logged by the reader itself.
      if (new URL(url).pathname !== "/health") {
        events.push(`${label} backlog read`);
        urls.push(url);
      }
      return scripted(url, ...rest);
    };
  }
  const output = [];
  const priorLog = console.log;
  console.log = (...values) => output.push(values.map(String).join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
  let error = null;
  try {
    await cmdUpdate(manifestPath, {
      discoverInstalledManifest: () => ({ path: manifestPath, source: "remembered" }),
      readUpdateBacklog,
      updateBacklogOptions: initial.options,
      forceQueuedUpdate: force,
      adoptCloudflareAuthProfile: async () => events.push("profile adoption"),
      withCloudflareControl: async (action) => action(),
      cmdVerify: async () => events.push("verification"),
      upgradeOptions: {
        resolveAccount: async () => ({ id: "1".repeat(32) }),
        d1Query: async (_account, _database, sql) => {
          if (/sqlite_master/iu.test(sql)) return { results: [{ name: "install_state" }] };
          if (/SELECT \* FROM install_state/iu.test(sql)) {
            return {
              results: [{ client_slug: "fixture", product_version: "0.4.6", schema_version: 46 }],
            };
          }
          return { results: [] };
        },
        cf: async (path) => {
          cfPaths.push(path);
          if (path.endsWith("/workers/subdomain")) return subdomain ? { subdomain } : {};
          return { bookmark: "fixture-bookmark" };
        },
        readUpdateBacklog,
        updateBacklogOptions: prePause.options,
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
  } finally {
    console.log = priorLog;
  }
  return { error, events, output, cfPaths, urls, initial: initial.log, prePause: prePause.log };
}

const PROCEEDED = [
  "initial backlog read",
  "profile adoption",
  "verification",
  "pre-pause backlog read",
  "paused deployment",
];

const RESUME_PAUSED_PENDING_MESSAGE = (pending, consequence) => renderCliCommands(
  `This Brain is still paused for an update that has not finished, and it has ${pending} queued search ` +
    "update(s). A paused Brain does not process its queue, so waiting will not clear it, and this update will " +
    `not continue over queued work. ${consequence} Do not run \`brain drain\` or clear VECTOR_DRAIN_MODE by hand. ` +
    "Run `brain health` and keep its output for support.",
);

test("a Worker paused on this CLI's version by an earlier failed update resumes through both gates", async () => {
  await withManifest(() => {}, async ({ manifestPath, original }) => {
    const paused = boundedInventory({ version: PRODUCT_VERSION, drainMode: "paused-for-upgrade" });
    const run = await throughBothGates(manifestPath, { first: paused });
    assert.deepEqual(run.events, PROCEEDED, run.error?.message);
    assert.equal(run.initial.requests, 1);
    assert.equal(run.prePause.requests, 1);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("a Worker already active on this CLI's version with an older manifest proceeds through both gates", async () => {
  await withManifest(() => {}, async ({ manifestPath }) => {
    const active = boundedInventory({ version: PRODUCT_VERSION, drainMode: "active" });
    const run = await throughBothGates(manifestPath, { first: active });
    assert.deepEqual(run.events, PROCEEDED, run.error?.message);
  });
});

test("a paused resume generation with queued work refuses truthfully at both gates, even with force", async () => {
  await withManifest(() => {}, async ({ manifestPath, original }) => {
    const queued = boundedInventory({ version: PRODUCT_VERSION, drainMode: "paused-for-upgrade", pending: 7 });
    const run = await throughBothGates(manifestPath, { first: queued });
    assert.equal(run.error?.message, RESUME_PAUSED_PENDING_MESSAGE(7, "Nothing was changed."));
    assert.doesNotMatch(run.error?.message || "", /mid-queue|busy|few minutes/u);
    // The decision point was reached: exactly one successful read, no retry.
    assert.deepEqual(run.events, ["initial backlog read"]);
    assert.deepEqual(run.initial.sleeps, []);

    const forced = await throughBothGates(manifestPath, { first: queued, force: true });
    assert.ok(forced.error?.message?.startsWith(prePauseRefusal(RESUME_PAUSED_PENDING_MESSAGE(
      7, "The paused deployment was not started.",
    ))), forced.error?.message);
    assert.deepEqual(forced.events, [
      "initial backlog read",
      "profile adoption",
      "verification",
      "pre-pause backlog read",
    ]);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("control: a Worker and manifest on the same older version, active, proceed through both gates", async () => {
  await withManifest(() => {}, async ({ manifestPath }) => {
    const run = await throughBothGates(manifestPath, { first: boundedInventory({ version: "0.4.7" }) });
    assert.deepEqual(run.events, PROCEEDED, run.error?.message);
  });
});

test("a Worker newer than this CLI refuses on one read with a truthful generation message", async () => {
  await withManifest(() => {}, async ({ manifestPath, original }) => {
    const newer = boundedInventory({ version: "9.9.9", drainMode: "active" });
    const run = await throughBothGates(manifestPath, { first: newer });
    assert.equal(run.error?.message, renderCliCommands(
      `This Brain's Worker reports version 9.9.9 (active), but this manifest records 0.4.7 and this CLI is ` +
        `${PRODUCT_VERSION}. That is not an earlier update of this CLI to resume, so its queued search updates ` +
        "cannot be bound to this manifest. Nothing was changed. Run `brain health` to see what is serving; " +
        "if the Worker is newer than this CLI, install that release, then run `brain update` again.",
    ));
    assert.doesNotMatch(run.error?.message || "", /busy|few minutes/u);
    assert.deepEqual(run.events, ["initial backlog read"]);
    assert.equal(run.initial.requests, 1);
    assert.deepEqual(run.initial.sleeps, []);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("a Worker older than this manifest is not a resume and refuses at the generation decision", async () => {
  await withManifest(() => {}, async ({ manifestPath }) => {
    const older = boundedInventory({ version: "0.4.6", drainMode: "paused-for-upgrade" });
    const run = await throughBothGates(manifestPath, { first: older });
    assert.match(run.error?.message || "", /reports version 0\.4\.6 \(paused-for-upgrade\), but this manifest records 0\.4\.7/u);
    assert.deepEqual(run.events, ["initial backlog read"]);
  });
});

test("the exact v0.4.6 envelope with an empty queue proceeds through both gates", async () => {
  await withManifest((manifest) => { manifest.brain.version = "0.4.6"; }, async ({ manifestPath }) => {
    const run = await throughBothGates(manifestPath, { first: v046DocumentsEnvelope(0) });
    assert.deepEqual(run.events, PROCEEDED, run.error?.message);
  });
});

test("the exact v0.4.6 envelope with queued work refuses at both gates", async () => {
  await withManifest((manifest) => { manifest.brain.version = "0.4.6"; }, async ({ manifestPath, original }) => {
    const queued = v046DocumentsEnvelope(7);
    const run = await throughBothGates(manifestPath, { first: queued, health: V046_HEALTH_ACTIVE });
    assert.equal(run.error?.message, PENDING_MESSAGE(7));
    assert.deepEqual(run.events, ["initial backlog read"]);
    // The public drain mode was read once to choose truthful advice.
    assert.equal(run.initial.healthReads, 1);

    const late = await throughBothGates(manifestPath, {
      first: v046DocumentsEnvelope(0),
      second: queued,
      health: V046_HEALTH_ACTIVE,
    });
    assert.equal(late.initial.healthReads, 0, "an empty legacy queue needs no drain-mode read");
    assert.equal(late.prePause.healthReads, 1);
    assert.ok(late.error?.message?.startsWith(prePauseRefusal(renderCliCommands(
      "This Brain gained 7 queued search update(s) before the paused deployment. " +
        "The paused deployment was not started. Wait until `brain health` says query-ready, then run the update again.",
    ))), late.error?.message);
    assert.equal(late.events.includes("paused deployment"), false);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

// Byte-for-byte what the v0.4.6 Worker router returns for a nine-chunk D1
// Brain with an empty outbox and matching counts that is still not
// query-ready. Generated once from `git show v0.4.6:worker/src` answering
// over sqlite at the v0.4.6 schema; each reason is one branch of that
// release's vectorReadiness.
function v046NotReadyEnvelope(reason) {
  const readiness = {
    projection_bootstrap_required: {
      mutation_submitted_at: null,
      projection_status: "bootstrap_required",
      action: "Run `brain update <manifest>` to resume the bounded legacy vector bootstrap.",
    },
    projection_unverified: {
      mutation_submitted_at: null,
      projection_status: "pending",
      action: "Run `brain drain <manifest>` to finish the exact vector verification receipt.",
    },
    accepted_mutation_processing: {
      mutation_submitted_at: 1_750_000_000_000,
      projection_status: "verified",
      action: "Wait for Vectorize processing, then run `brain drain <manifest>` again.",
    },
  }[reason];
  return {
    backend: "d1",
    rows: [{
      source_type: "drive",
      documents: 3,
      logical_documents: 3,
      stored_documents: 3,
      document_counts_exact: true,
      chunks: 9,
      chunk_counts_exact: true,
      total: 9,
      embedded: 9,
      last_ingested: null,
    }],
    vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0, oldest_queued_at: null },
    vector_readiness: {
      ready: false,
      reason,
      expected_vectors: 9,
      actual_vectors: 9,
      pending: 0,
      submitted: 0,
      oldest_queued_at: null,
      mutation_submitted_at: readiness.mutation_submitted_at,
      projection_status: readiness.projection_status,
      bootstrap_epoch: 0,
      action: readiness.action,
    },
  };
}

const V046_NOT_READY_REASONS = [
  "projection_bootstrap_required",
  "projection_unverified",
  "accepted_mutation_processing",
];

for (const reason of V046_NOT_READY_REASONS) {
  test(`the exact v0.4.6 envelope with an empty queue that is not ready (${reason}) proceeds through both gates`, async () => {
    await withManifest((manifest) => { manifest.brain.version = "0.4.6"; }, async ({ manifestPath, original }) => {
      const run = await throughBothGates(manifestPath, { first: v046NotReadyEnvelope(reason) });
      assert.deepEqual(run.events, PROCEEDED, run.error?.message);
      assert.equal(run.initial.requests, 1);
      assert.equal(run.prePause.requests, 1);
      assert.deepEqual(run.initial.sleeps, []);
      assert.equal(readFileSync(manifestPath, "utf8"), original);
    });
  });
}

test("the exact v0.4.6 not-ready envelope with queued work still refuses at both gates", async () => {
  await withManifest((manifest) => { manifest.brain.version = "0.4.6"; }, async ({ manifestPath, original }) => {
    // Bootstrap state is reported ahead of queue state, so a queued Brain
    // awaiting its bootstrap carries the bootstrap reason and a pending count.
    const queued = v046NotReadyEnvelope("projection_bootstrap_required");
    Object.assign(queued.vector_backlog, { pending: 2, upserts: 2, oldest_queued_at: 1_750_000_000_000 });
    Object.assign(queued.vector_readiness, { pending: 2, oldest_queued_at: 1_750_000_000_000 });
    const run = await throughBothGates(manifestPath, { first: queued, health: V046_HEALTH_ACTIVE });
    assert.equal(run.error?.message, PENDING_MESSAGE(2));
    assert.deepEqual(run.events, ["initial backlog read"]);
    assert.equal(run.initial.requests, 1);
    assert.equal(run.initial.healthReads, 1);

    const late = await throughBothGates(manifestPath, {
      first: v046NotReadyEnvelope("projection_bootstrap_required"),
      second: queued,
      health: V046_HEALTH_ACTIVE,
    });
    assert.ok(late.error?.message?.startsWith(prePauseRefusal(renderCliCommands(
      "This Brain gained 2 queued search update(s) before the paused deployment. " +
        "The paused deployment was not started. Wait until `brain health` says query-ready, then run the update again.",
    ))), late.error?.message);
    assert.equal(late.prePause.requests, 1);
    assert.equal(late.events.includes("paused deployment"), false);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

/* ---- a v0.4.6 Worker left paused for an upgrade ---- */

// Byte-for-byte what the v0.4.6 Worker router returns on public /health and on
// the authenticated documents route for a nine-chunk D1 Brain, active and
// paused for an upgrade. Generated once from `git show v0.4.6:worker/src`
// answering over sqlite at the v0.4.6 schema; only `ts` is a live clock.
const V046_HEALTH_ACTIVE = {
  body: '{"ok":true,"status":"ok","accepting_documents":true,"brain":"brain","version":"0.4.6","schema_version":46,' +
    '"vector_writer_protocol":"lease-v1","vector_drain_mode":"active","ts":"2026-09-26T08:18:06.443Z"}',
};
const V046_HEALTH_PAUSED = {
  body: '{"ok":false,"status":"paused-for-upgrade","reason":"This brain cannot accept documents right now. An update ' +
    'paused its corpus writes and did not finish. Anything added while it is paused is refused rather than stored.",' +
    '"accepting_documents":false,"brain":"brain","version":"0.4.6","vector_writer_protocol":"lease-v1",' +
    '"vector_drain_mode":"paused-for-upgrade","ts":"2026-09-26T08:18:06.926Z"}',
};
const V046_ROWS = '"rows":[{"source_type":"drive","documents":3,"logical_documents":3,"stored_documents":3,' +
  '"document_counts_exact":true,"chunks":9,"chunk_counts_exact":true,"total":9,"embedded":9,"last_ingested":null}]';
const V046_PAUSED_EMPTY_ENVELOPE = '{"backend":"d1",' + V046_ROWS + ',"vector_backlog":{"pending":0,"upserts":0,' +
  '"deletes":0,"submitted":0,"oldest_queued_at":null},"vector_readiness":{"ready":true,"reason":null,' +
  '"expected_vectors":9,"actual_vectors":9,"pending":0,"submitted":0,"oldest_queued_at":null,' +
  '"mutation_submitted_at":null,"projection_status":"verified","bootstrap_epoch":0,"action":null}}';
const V046_PAUSED_QUEUED_ENVELOPE = '{"backend":"d1",' + V046_ROWS + ',"vector_backlog":{"pending":7,"upserts":7,' +
  '"deletes":0,"submitted":0,"oldest_queued_at":1750000000000},"vector_readiness":{"ready":false,' +
  '"reason":"vector_work_queued","expected_vectors":9,"actual_vectors":9,"pending":7,"submitted":0,' +
  '"oldest_queued_at":1750000000000,"mutation_submitted_at":null,"projection_status":"pending","bootstrap_epoch":0,' +
  '"action":"This brain is paused for an upgrade, so reindex and drain both return 503 until it finishes. Complete ' +
  'or resume the update first; the pause lifts with it. Once it is running again, the remedy is: Run `brain drain ' +
  '<manifest>`; it confirms provider visibility without re-embedding accepted rows."}}';

const V046_PAUSED_QUEUED_MESSAGE = (pending, consequence) => renderCliCommands(
  `This Brain's Worker is version 0.4.6, it is still paused for an update that did not finish, and it has ${pending} ` +
    "queued search update(s). A paused 0.4.6 Worker does not process its queue, so waiting will not clear it, and " +
    `this update will not continue over queued work. ${consequence} To let the queue drain, install the 0.4.6 ` +
    "release and run `brain deploy` with it; that returns the 0.4.6 Worker to active. Wait until `brain health` " +
    "says query-ready, then install this release again and run `brain update`. Do not run `brain rollback`, and do " +
    "not clear VECTOR_DRAIN_MODE by hand.",
);

const DRAIN_MODE_UNKNOWN_MESSAGE = (pending, consequence) => renderCliCommands(
  `This Brain has ${pending} queued search update(s), and its public health check could not be read to tell ` +
    `whether its Worker is paused for an update that did not finish. ${consequence} Run \`brain health\`. If it ` +
    "says query-ready later, run the update again. If it reports the Worker paused for an upgrade, keep that " +
    "output for support; do not run `brain rollback` or clear VECTOR_DRAIN_MODE by hand.",
);

test("a paused v0.4.6 Worker with queued work refuses with advice that can drain it, never wait or rollback", async () => {
  await withManifest((manifest) => { manifest.brain.version = "0.4.6"; }, async ({ manifestPath, original }) => {
    const queued = JSON.parse(V046_PAUSED_QUEUED_ENVELOPE);
    const run = await throughBothGates(manifestPath, { first: queued, health: V046_HEALTH_PAUSED });
    assert.equal(run.error?.message, V046_PAUSED_QUEUED_MESSAGE(7, "Nothing was changed."));
    assert.doesNotMatch(run.error?.message || "", /mid-queue|few minutes|Updating now/u);
    assert.deepEqual(run.events, ["initial backlog read"]);
    assert.equal(run.initial.requests, 1);
    assert.equal(run.initial.healthReads, 1);
    // Public /health is read without the durable admin key.
    assert.equal(JSON.stringify(run.initial.healthInits).includes("unit-test-admin-key"), false);
    assert.equal(run.urls.length, 1);

    const forced = await throughBothGates(manifestPath, { first: queued, health: V046_HEALTH_PAUSED, force: true });
    assert.ok(forced.error?.message?.startsWith(prePauseRefusal(V046_PAUSED_QUEUED_MESSAGE(
      7, "The paused deployment was not started.",
    ))), forced.error?.message);
    assert.deepEqual(forced.events, [
      "initial backlog read",
      "profile adoption",
      "verification",
      "pre-pause backlog read",
    ]);
    assert.equal(forced.prePause.healthReads, 1);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("a paused v0.4.6 Worker with an empty queue proceeds through both gates as a resumable paused generation", async () => {
  await withManifest((manifest) => { manifest.brain.version = "0.4.6"; }, async ({ manifestPath }) => {
    const run = await throughBothGates(manifestPath, {
      first: JSON.parse(V046_PAUSED_EMPTY_ENVELOPE),
      health: V046_HEALTH_PAUSED,
    });
    assert.deepEqual(run.events, PROCEEDED, run.error?.message);
    assert.equal(run.initial.requests, 1);
    assert.equal(run.prePause.requests, 1);
  });
});

test("an active v0.4.6 Worker with queued work keeps the wait-until-query-ready advice", async () => {
  await withManifest((manifest) => { manifest.brain.version = "0.4.6"; }, async ({ manifestPath }) => {
    const queued = JSON.parse(V046_PAUSED_QUEUED_ENVELOPE.replace(
      /"action":"This brain is paused[^"]*the remedy is: /u, '"action":"',
    ));
    const run = await throughBothGates(manifestPath, { first: queued, health: V046_HEALTH_ACTIVE });
    assert.equal(run.error?.message, PENDING_MESSAGE(7));
    assert.equal(run.initial.healthReads, 1);
  });
});

test("queued v0.4.6 work with an unreadable or contradictory /health refuses without claiming either mode", async () => {
  await withManifest((manifest) => { manifest.brain.version = "0.4.6"; }, async ({ manifestPath, original }) => {
    const paused = JSON.parse(V046_HEALTH_PAUSED.body);
    const unreadable = [
      { status: 500, body: "{}" },
      { network: true },
      { body: "not json" },
      // A 0.4.7 or later release reports its drain mode in the receipt itself.
      { body: JSON.stringify({ ...paused, version: "0.4.7" }) },
      // Status and drain mode must agree.
      { body: JSON.stringify({ ...paused, status: "ok" }) },
      { body: JSON.stringify({ ...paused, vector_drain_mode: "draining" }) },
      { body: JSON.stringify({ ...paused, version: undefined }) },
    ];
    for (const health of unreadable) {
      const run = await throughBothGates(manifestPath, { first: JSON.parse(V046_PAUSED_QUEUED_ENVELOPE), health });
      assert.equal(run.error?.message, DRAIN_MODE_UNKNOWN_MESSAGE(7, "Nothing was changed."), JSON.stringify(health));
      assert.deepEqual(run.events, ["initial backlog read"]);
      assert.equal(run.initial.healthReads, 1);
      assert.deepEqual(run.initial.sleeps, []);
    }
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("a malformed v0.4.6 not-ready envelope still refuses on one read", async () => {
  await withManifest((manifest) => { manifest.brain.version = "0.4.6"; }, async ({ manifestPath }) => {
    const incoherent = [
      // An empty queue cannot be explained by queued work.
      (body) => { body.vector_readiness.reason = "vector_work_queued"; },
      // Not ready with no reason at all.
      (body) => { body.vector_readiness.reason = null; },
      // A mismatched count must name the mismatch, not the exactness marker.
      (body) => { body.vector_readiness.actual_vectors = 8; },
      // Readiness and the outbox disagree about the queue.
      (body) => { body.vector_readiness.pending = 1; },
      // A version field is not part of the v0.4.6 envelope.
      (body) => { body.extra = true; },
    ];
    for (const mutate of incoherent) {
      const body = v046NotReadyEnvelope("projection_unverified");
      mutate(body);
      const { log, read } = scriptedReader(manifestPath, [{ status: 200, body: JSON.stringify(body) }]);
      await assert.rejects(read(), (error) => error?.attempts === 1 && !error.generation, JSON.stringify(body));
      assert.equal(log.requests, 1);
      assert.deepEqual(log.sleeps, []);
    }
  });
});

test("the v0.4.6 envelope is refused for a manifest that records 0.4.7 or later", async () => {
  await withManifest(() => {}, async ({ manifestPath }) => {
    const { log, read } = scriptedReader(manifestPath, [
      { status: 200, body: JSON.stringify(v046DocumentsEnvelope(0)) },
    ]);
    await assert.rejects(read(), (error) => error?.attempts === 1);
    assert.equal(log.requests, 1);
  });
});

test("a versionless manifest is older than every release: legacy envelope and resume generation are both read", async () => {
  await withManifest((manifest) => { delete manifest.brain.version; }, async ({ manifestPath }) => {
    const legacy = await throughBothGates(manifestPath, { first: v046DocumentsEnvelope(0) });
    assert.deepEqual(legacy.events, PROCEEDED, legacy.error?.message);
    const legacyQueued = await throughBothGates(manifestPath, {
      first: v046DocumentsEnvelope(2),
      health: V046_HEALTH_ACTIVE,
    });
    assert.equal(legacyQueued.error?.message, PENDING_MESSAGE(2));
    assert.equal(legacyQueued.initial.healthReads, 1);
    const resumed = await throughBothGates(manifestPath, {
      first: boundedInventory({ version: PRODUCT_VERSION, drainMode: "paused-for-upgrade" }),
    });
    assert.deepEqual(resumed.events, PROCEEDED, resumed.error?.message);
  });
});

test("a manifest with no Brain address defers the first read and resolves workers.dev read-only before the pause", async () => {
  await withManifest((manifest) => { delete manifest.brain.domain; }, async ({ manifestPath, original }) => {
    const run = await throughBothGates(manifestPath, { first: boundedInventory({ version: "0.4.7" }) });
    assert.deepEqual(run.events, [
      "profile adoption",
      "verification",
      "pre-pause backlog read",
      "paused deployment",
    ], run.error?.message);
    assert.equal(run.initial.requests, 0);
    assert.ok(run.output.some((line) => line.includes(renderCliCommands(
      "This manifest records no Brain address, so no queued-update read was sent yet. The same read runs once " +
        "Cloudflare access is confirmed, immediately before the paused deployment.",
    ))), run.output.join("\n"));
    assert.deepEqual(run.cfPaths.filter((path) => path.endsWith("/workers/subdomain")),
      [`/accounts/${"1".repeat(32)}/workers/subdomain`]);
    assert.deepEqual(run.urls, ["https://fixture-brain.owner-sub.workers.dev/api/admin/brain/documents"]);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
  });
});

test("a manifest with no resolvable Brain address refuses before the pause and says no read was sent", async () => {
  await withManifest((manifest) => { delete manifest.brain.domain; }, async ({ manifestPath }) => {
    const run = await throughBothGates(manifestPath, {
      first: boundedInventory({ version: "0.4.7" }),
      subdomain: null,
    });
    assert.ok(run.error?.message?.startsWith(prePauseRefusal(renderCliCommands(
      "The immediate pre-pause documents backlog read could not be sent: this computer's admin key or Brain " +
        "address could not be loaded, so no read was sent. The paused deployment was not started. " +
        "Fix that, then run `brain update` again.",
    ))), run.error?.message);
    assert.equal(run.initial.requests + run.prePause.requests, 0);
    assert.equal(run.events.includes("paused deployment"), false);
  });
});

test("force says the truth: the pre-pause gate still refuses queued work and says it still has it", async () => {
  await withManifest(() => {}, async ({ manifestPath, original }) => {
    const queued = boundedInventory({ version: "0.4.7", pending: 3 });
    const run = await throughBothGates(manifestPath, { first: queued, force: true });
    assert.equal(run.output.filter((line) => line.includes(FORCE_WARNING(3))).length, 1, run.output.join("\n"));
    assert.ok(run.error?.message?.startsWith(prePauseRefusal(renderCliCommands(
      "This Brain still has 3 queued search update(s) before the paused deployment. " +
        "The paused deployment was not started. Wait until `brain health` says query-ready, then run the update again.",
    ))), run.error?.message);
    assert.equal(run.events.includes("paused deployment"), false);
    assert.equal(readFileSync(manifestPath, "utf8"), original);

    const help = spawnSync(process.execPath, [fileURLToPath(new URL("../brain.mjs", import.meta.url)), "--help"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.doesNotMatch(help.stdout, /update despite queued search updates/u);
    assert.ok(help.stdout.includes(renderCliCommands(
      "continue past the first queued search update check;",
    )), help.stdout);
  });
});

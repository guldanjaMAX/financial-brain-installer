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
  "The authenticated documents backlog read failed, so this Brain's queued search updates could not be read. " +
    "Updating now could pause it mid-queue. Nothing was changed. Fix the failed read, wait until `brain health` " +
    "says query-ready, then run the update again.",
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

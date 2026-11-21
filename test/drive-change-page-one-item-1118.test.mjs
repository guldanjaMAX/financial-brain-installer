import assert from "node:assert/strict";
import test from "node:test";
import * as drive from "../connectors/google-drive.mjs";
import { driveIncrementalCommand, renderDriveIncrementalStatus, runDriveIncremental } from "../operations/drive-incremental.mjs";

const file = (id, parents) => ({ id, name: `${id}.txt`, mimeType: "text/plain", parents });
const change = (file) => ({ fileId: file.id, file });

const folder = (id, parents, extra = {}) => ({ id, name: id, mimeType: drive.FOLDER_MIME, parents, ...extra });

function fixture(item, entries = [], { accepted, roots = ["watched", "also-watched"] } = {}) {
  const healthy = file("healthy", ["watched"]);
  const byId = new Map([...entries, healthy,
    { id: "watched", name: "Watched", mimeType: drive.FOLDER_MIME },
    { id: "also-watched", name: "Also watched", mimeType: drive.FOLDER_MIME },
    { id: "elsewhere", name: "Elsewhere", mimeType: drive.FOLDER_MIME },
  ].map((entry) => [entry.id, entry]));
  const reads = [], written = [], saves = [], writtenFiles = [];
  const opts = { attempts: 1, fetchImpl: async (input) => {
    const url = new URL(input);
    const id = url.pathname.split("/").at(-1);
    reads.push(id);
    if (id === "changes") return Response.json({
      changes: url.searchParams.get("pageToken") === "before" ? [item, change(healthy)] : [],
      newStartPageToken: "after",
    });
    assert.ok(byId.has(id), "unexpected metadata lookup");
    return Response.json(byId.get(id));
  } };
  const state = { sync_token: "before", done: accepted ?? { "drive:removed": "accepted", "drive:orphan": "accepted" } };
  const args = {
    drive: { ...drive,
      listChangePage: (get, token, config) => drive.listChangePage(get, token, { ...opts, ...config }),
      getFileMetadata: (get, id) => drive.getFileMetadata(get, id, opts),
      changeScope: (get, entry, config) => drive.changeScope(get, entry, { ...config, opts }),
    },
    getToken: async () => "synthetic",
    state, save: () => saves.push(structuredClone(state)), sourceName: "drive",
    policy: { rootFolderIds: roots },
    processFile: async (entry, folder) => {
      written.push([entry.id, folder]);
      writtenFiles.push(entry);
      return { created: 1 };
    },
  };
  const run = (more = {}) => runDriveIncremental({ ...args, ...more });
  return { args, state, run, reads, written, saves, writtenFiles };
}

async function settle(h) {
  let result;
  const outcome = await h.run().then(value => { result = value; return "settled"; },
    error => error.message);
  assert.deepEqual([outcome, h.state.sync_token], ["settled", "after"]);
  assert.equal(result.feed_caught_up, true);
  assert.equal(h.saves.at(-1).sync_token, "after");
  return result;
}

test("a parentless file is skipped beside a healthy change without deleting the prior document", async () => {
  const orphan = file("orphan");
  const h = fixture(change(orphan), [orphan]);
  const result = await settle(h);
  assert.deepEqual(h.written, [["healthy", "Watched"]]);
  assert.equal(result.skipped, 1);
  assert.equal(h.state.skipped["drive:orphan"], "outside the watched folders");
  assert.match(renderDriveIncrementalStatus(h.state), /Skipped outside the watched folders: 1/);
  assert.equal(h.state.done["drive:orphan"], "accepted");
  assert.equal(h.state.drive_pending_removals["drive:orphan"].reason, "left_configured_roots");
  assert.equal(result.complete, false);
});

let seed = 0x111802;
function order(values) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const offset = (seed >>> 16) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

for (const [label, parents, entries, expectedPath, reached] of [
  ["sole direct parent", ["bridge"], [folder("bridge", order(["elsewhere", "watched"]))], "Watched/bridge", "bridge"],
  ["multiple direct parents", order(["bridge", "elsewhere"]), [folder("bridge", order(["elsewhere", "watched"]))], "Watched/bridge", "bridge"],
  ["nested shared branches", ["bridge"], [
    folder("bridge", order(["elsewhere", "shared", "trail", "trail"])),
    folder("shared", ["elsewhere"]), folder("trail", order(["shared", "watched"])),
  ], "Watched/trail/bridge", "trail"],
  ["cyclic sibling", ["bridge"], [folder("bridge", order(["cycle", "watched"])), folder("cycle", ["bridge"])], "Watched/bridge", "cycle"],
  ["trashed sibling", ["bridge"], [folder("bridge", order(["discarded", "watched"])), folder("discarded", ["watched"], { trashed: true })], "Watched/bridge", "discarded"],
  ["two proved paths", ["bridge"], [folder("bridge", order(["watched", "also-watched"]))], "Also watched/bridge", "also-watched"],
]) test(`legacy ancestry resolves ${label}`, async () => {
  const item = file("legacy", parents);
  const h = fixture(change(item), [item, ...entries]);
  await settle(h);
  assert.ok(h.reads.includes(reached), "branch decision reached");
  assert.ok(h.saves.some(state => state.sync_token === "before" && state.drive_change_page?.offset === 2));
  assert.deepEqual(h.written, [["legacy", expectedPath], ["healthy", "Watched"]]);
});

test("branching ancestry holds an unproved item at the total walk limit", async () => {
  const branches = Array.from({ length: 101 }, (_, i) => folder(`a-${String(i).padStart(3, "0")}`));
  const bridge = folder("bridge", order([...branches.map(entry => entry.id), "watched"]));
  const item = file("legacy", ["bridge"]);
  const h = fixture(change(item), [item, bridge, ...branches]);
  const result = await settle(h);
  assert.equal(h.reads.filter(id => id === "bridge" || id.startsWith("a-")).length, 100, "total walk limit reached");
  assert.equal(h.state.drive_failures["drive:legacy"].code, "ancestor_depth_limit");
  assert.equal(result.complete, false);
  assert.deepEqual(h.written, [["healthy", "Watched"]]);
});

let reviewSeed = 0x72d31120;
function reviewOrder(values) {
  reviewSeed = (Math.imul(reviewSeed, 1664525) + 1013904223) >>> 0;
  return (reviewSeed >>> 16) & 1 ? values : [...values].reverse();
}

function reviewEdgeOrders(malformed, sibling) {
  const first = reviewOrder([malformed, sibling]);
  return [first, [...first].reverse()];
}

for (const [label, malformed] of Object.entries({
  null: null, empty: "", number: 1, boolean: false, object: {}, array: [],
  whitespace: " ", control: "bad\n", oversized: "x".repeat(251),
})) for (const placement of ["ancestor", "direct"]) test(`malformed ${placement} edge (${label}) cannot hide a watched sibling or prove absence`, async () => {
  for (const sibling of ["elsewhere", "watched"]) {
    const orders = reviewEdgeOrders(malformed, sibling);
    for (const edges of orders) {
      const nested = placement === "ancestor";
      const item = file("legacy", nested ? ["bridge"] : edges);
      const h = fixture(change(item), nested ? [item, folder("bridge", edges)] : [item]);
      const result = await settle(h);
      assert.ok(h.reads.includes(nested ? "bridge" : "legacy"), "edge metadata reached");
      const gap = h.state.drive_failures["drive:legacy"];
      if (sibling === "elsewhere") {
        assert.equal(gap?.retryable, true);
        assert.match(gap.reason, /ancestor metadata is incomplete or mismatched/);
        assert.equal(result.complete, false);
        assert.deepEqual(h.written, [["healthy", "Watched"]]);
      } else {
        assert.deepEqual(h.written, [["legacy", nested ? "Watched/bridge" : "Watched"], ["healthy", "Watched"]]);
        assert.equal(gap, undefined);
        assert.equal(result.complete, true);
      }
      assert.deepEqual(h.reads, ["changes", "legacy", ...(nested ? ["bridge"] : []), sibling, "healthy",
        ...(sibling === "watched" ? [] : ["watched"])]);
      assert.equal(result.pending_removals, 0);
    }
    assert.deepEqual(orders.map(edges => edges.indexOf(sibling)).sort(), [0, 1],
      `both edge placements are exercised with ${sibling}`);
  }
});

for (const nested of [false, true]) test(`malformed ${nested ? "ancestor" : "direct"} edge remains retryable at the visit limit`, async () => {
  const branches = Array.from({ length: 100 }, (_, i) => folder(`a-${String(i).padStart(3, "0")}`));
  for (const malformed of [false, true]) {
    const edges = [null, ...branches.map(entry => entry.id), "watched"].slice(malformed ? 0 : 1);
    const item = file("legacy", nested ? ["bridge"] : edges);
    const bridge = folder("bridge", edges);
    const h = fixture(change(item), [item, ...branches, ...(nested ? [bridge] : [])]);
    const result = await settle(h);
    assert.equal(h.reads.filter(id => id === "bridge" || id.startsWith("a-")).length, 100, "visit limit reached");
    assert.equal(h.reads.filter(id => id === "watched").length, 1, "only the healthy suffix reached its root");
    assert.deepEqual(h.written, [["healthy", "Watched"]]);
    assert.equal(result.complete, false);
    const gap = h.state.drive_failures["drive:legacy"];
    assert.equal(gap.retryable, malformed);
    if (malformed) {
      assert.match(gap.reason, /ancestor metadata is incomplete or mismatched/);
      (nested ? bridge : item).parents = ["watched"];
      const recovered = await settle(h);
      assert.deepEqual(h.written, [["healthy", "Watched"], ["legacy", nested ? "Watched/bridge" : "Watched"]]);
      assert.equal(h.state.drive_failures["drive:legacy"], undefined);
      assert.equal(recovered.complete, true);
    } else assert.equal(gap.code, "ancestor_depth_limit");
  }
});

test("a quiet Drive command retains removal review when policy invalidates accepted parts", async () => {
  const uid = "drive:outside";
  const decision = { id: "outside", reason: "left_configured_roots" };
  for (const fingerprint of ["old", "new", "awaiting restore", "absent"]) {
    const invalidated = fingerprint === "new" || fingerprint === "awaiting restore";
    const hasProof = fingerprint === "old" || fingerprint === "new";
    const h = fixture(null, [file("outside", ["elsewhere"])], { accepted: hasProof ? { [uid]: "accepted" } : {} });
    h.state.sync_token = "after";
    h.state.drive_pending_removals = { [uid]: decision };
    const parts = [{ source_id: "outside", content_hash: "a".repeat(64), chunk_count: 1 }];
    const geometry = { size: 1000, overlap: 100 };
    if (hasProof) h.state.drive_accepted_parts = { [uid]: { revision: "accepted", policy_fingerprint: "old", parts, geometry } };
    if (fingerprint === "awaiting restore") h.state.drive_restore_pending = {
      [uid]: { id: "outside", reason: "current_database_unconfirmed" },
    };
    let readbacks = 0;
    const result = await driveIncrementalCommand({
      ...h.args, policyFingerprint: fingerprint === "old" ? "old" : "new",
      flags: {}, now: () => 0, receipt: async () => {}, write: () => {}, display: String,
      base: "https://fixture.invalid",
      request: async (url, options) => {
        assert.equal(new URL(url).pathname, "/api/admin/brain/ingest-part-proof");
        assert.deepEqual(JSON.parse(options.body), { source: "drive", source_ids: ["outside"] });
        readbacks++;
        return Response.json({ source: "drive", database: { instance: "a".repeat(32), nonce: "b".repeat(32), generation: 1 },
          parts, geometry });
      },
    });
    assert.equal(readbacks, fingerprint === "old" ? 2 : Number(hasProof));
    assert.deepEqual(h.reads, invalidated ? ["outside", "elsewhere", "changes"] : ["changes"]);
    assert.equal(h.state.done[uid], fingerprint === "old" ? "accepted" : undefined);
    assert.equal(Boolean(h.state.drive_accepted_parts?.[uid]), fingerprint === "old");
    assert.equal(Boolean(h.state.drive_restore_pending[uid]), invalidated);
    assert.deepEqual(h.saves.at(-1).drive_pending_removals[uid], fingerprint === "absent" ? undefined : decision);
    assert.equal(result.pending_removals, Number(fingerprint !== "absent"));
  }
});

for (const [label, parents] of Object.entries({
  omitted: undefined, empty: [], outside: ["elsewhere"],
  "multiple outside": reviewOrder(["elsewhere", "external"]),
})) test(`carried outside decision reconciles against retained evidence (${label})`, async () => {
  const item = file("outside", parents);
  const uid = "drive:outside";
  for (const retained of reviewOrder(["revision", "parts", "neither"])) {
    const h = fixture(change(item), [item, folder("external")],
      { accepted: retained === "revision" ? { [uid]: "accepted" } : {} });
    if (retained === "parts") h.state.drive_accepted_parts = { [uid]: { revision: "accepted" } };
    h.state.drive_pending_removals = { [uid]: { id: "outside", reason: "left_configured_roots" } };
    const result = await settle(h);
    assert.ok(h.reads.includes("outside"), "current metadata reached");
    for (const id of parents || []) assert.ok(h.reads.includes(id), "outside branch checked");
    assert.equal(h.state.skipped[uid], "outside the watched folders");
    assert.deepEqual(h.written, [["healthy", "Watched"]]);
    assert.equal(h.state.drive_pending_removals[uid]?.reason,
      retained === "neither" ? undefined : "left_configured_roots");
    assert.equal(result.complete, retained === "neither");
  }
});

test("a quiet page reconciles carried outside decisions and preserves other review reasons", async () => {
  const uid = "drive:outside";
  const h = fixture(null, [], { accepted: {} });
  h.state.sync_token = "after";
  h.state.drive_pending_removals = {
    [uid]: { id: "outside", reason: "left_configured_roots" },
    "drive:retained": { id: "retained", reason: "left_configured_roots" },
    "drive:removed": { id: "removed", reason: "removed_or_access_lost" },
  };
  h.state.drive_accepted_parts = { "drive:retained": { revision: "accepted" } };
  h.state.skipped = { [uid]: "outside the watched folders" };
  const result = await settle(h);
  assert.deepEqual(h.reads, ["changes"], "quiet terminal page reached");
  assert.deepEqual(h.saves.at(-1).drive_pending_removals, {
    "drive:retained": { id: "retained", reason: "left_configured_roots" },
    "drive:removed": { id: "removed", reason: "removed_or_access_lost" },
  });
  assert.equal(h.state.skipped[uid], "outside the watched folders");
  assert.equal(result.pending_removals, 2);
});

for (const [label, parents] of [
  ["omitted parents", undefined],
  ["empty parents", []],
  ["outside parent", ["elsewhere"]],
  ["outside parents", order(["elsewhere", "external", "elsewhere"])],
]) test(`removal review requires retained evidence with ${label}`, async () => {
  const item = file("outside", parents);
  for (const retained of [false, true]) {
    const h = fixture(change(item), [item, folder("external")],
      { accepted: retained ? { "drive:outside": "accepted" } : {} });
    const result = await settle(h);
    assert.ok(h.reads.includes("outside"), "current metadata decision reached");
    for (const id of parents || []) assert.ok(h.reads.includes(id), "outside branch checked");
    assert.equal(h.state.skipped["drive:outside"], "outside the watched folders");
    assert.match(renderDriveIncrementalStatus(h.state), /Skipped outside the watched folders: 1/);
    assert.deepEqual(h.written, [["healthy", "Watched"]]);
    assert.equal(result.complete, !retained);
    assert.equal(result.pending_removals, Number(retained));
    assert.equal(h.state.drive_pending_removals["drive:outside"]?.reason,
      retained ? "left_configured_roots" : undefined);
  }
});

test("a multi-parent file selects a watched parent deterministically in either order", async () => {
  for (const [parents, expectedParent, expectedFolder] of [
    [["elsewhere", "watched", "also-watched"], "also-watched", "Also watched"],
    [["also-watched", "watched", "elsewhere"], "also-watched", "Also watched"],
    [["elsewhere", "watched"], "watched", "Watched"],
  ]) {
    const item = file("multi", parents);
    const h = fixture(change(item), [item]);
    await settle(h);
    assert.deepEqual(h.written, [["multi", expectedFolder], ["healthy", "Watched"]]);
    const selected = h.writtenFiles[0];
    const { envelope, version } = await drive.toEnvelope(async () => "synthetic", selected,
      { pathOf: () => expectedFolder }, { fetchImpl: async () => new Response(
        "The synthetic project review records the decision to approve the next scheduled inspection. This document lists the evidence and the follow-up review for the plan.") });
    assert.equal(envelope.metadata.parent_folder_id, expectedParent);
    assert.notEqual(version, drive.driveVersion({ ...selected, scope_parent_id: "same-name-folder" }, expectedFolder));
  }
});

for (const [problem, item, reason] of [
  ["mismatched ID", { fileId: "expected", file: file("wrong", ["watched"]) }, /does not match/],
  ["missing metadata", { fileId: "expected" }, /missing file metadata/],
]) test(`a change with a ${problem} is durably held without an unverified read or write`, async () => {
  const h = fixture(item);
  const result = await settle(h);
  assert.equal(result.failures, 1);
  assert.equal(result.complete, false);
  assert.equal(h.state.drive_failures["drive:expected"].code, "invalid_change_identity");
  assert.match(h.state.drive_failures["drive:expected"].reason, reason);
  assert.ok(h.saves.some(state => state.sync_token === "before" && state.drive_failures?.["drive:expected"]));
  assert.deepEqual(h.reads, ["changes", "healthy", "watched"]);
  assert.deepEqual(h.written, [["healthy", "Watched"]]);
});

test("an ID-only removal still enters owner review while the healthy change settles", async () => {
  const h = fixture({ fileId: "removed", removed: true });
  const result = await settle(h);
  assert.equal(result.pending_removals, 1);
  assert.equal(h.state.drive_pending_removals["drive:removed"].reason, "removed_or_access_lost");
  assert.equal(h.state.done["drive:removed"], "accepted");
  assert.deepEqual(h.written, [["healthy", "Watched"]]);
});

test("malformed identities are visible and cannot become metadata requests, even on reset", async () => {
  for (const item of [null, { fileId: 3 }, { fileId: "unsafe\n", removed: true },
    { fileId: "x".repeat(251), removed: true }]) {
    const h = fixture(item);
    const result = await settle(h);
    assert.equal(result.failures, 1);
    assert.equal(result.pending_removals, 0);
    assert.equal(Object.values(h.state.drive_failures)[0].code, "invalid_change_identity");
    await h.run({ retryFailures: true });
    assert.deepEqual(h.reads, ["changes", "healthy", "watched", "changes"]);
  }
});

test("page-level protocol violations still fail closed", async () => {
  for (const [page, reason] of [
    [{ changes: {}, newStartPageToken: "after" }, "invalidChangeList"],
    [{ changes: [null, null], newStartPageToken: "after" }, "invalidChangeList"],
    [{ changes: [null], nextPageToken: "before" }, "repeatedPageToken"],
    [{ changes: [null], nextPageToken: "next", newStartPageToken: "after" }, "repeatedPageToken"],
  ]) {
    await assert.rejects(drive.listChangePage(async () => "synthetic", "before",
      { pageSize: 1, fetchImpl: async () => Response.json(page) }), { reason });
  }
});

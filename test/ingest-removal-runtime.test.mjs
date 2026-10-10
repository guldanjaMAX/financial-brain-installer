import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { ingestRemovalRuntime, createIngestRemovalReview } from "../operations/ingest-removal-plan.mjs";
import { buildDriveRemovalPlan } from "../operations/drive-removal-plan.mjs";
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";

const shipped = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).files;
// Include every shipped subtree, including scripts, build helpers, evaluation,
// shell tools and configuration read at runtime. No second directory allowlist.
const paths = [...new Set(shipped.map(path => path.endsWith("/") ? `${path}imported.mjs` : path))];
function runtimeFixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "removal-runtime-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  for (const path of paths) write(path, "// shipped fixture revision one\n");
  write("brain.mjs", paths.filter(path => path.endsWith(".mjs") && path !== "brain.mjs")
    .map(path => `import './${path}';`).join("\n"));
  write("package.json", JSON.stringify({ type: "module", files: shipped, dependencies: { direct: "1.0.0" } }));
  write("node_modules/direct/package.json", JSON.stringify({ dependencies: { hoisted: "1.0.0" },
    peerDependencies: { optional: "1.0.0" }, peerDependenciesMeta: { optional: { optional: true } } }));
  write("node_modules/direct/index.js", "// direct module\n");
  write("node_modules/hoisted/package.json", "{}");
  write("node_modules/hoisted/index.js", "// hoisted transitive module\n");
  return { root, write, runtime: () => ingestRemovalRuntime(root) };
}

test("every shipped runtime subtree and transitive dependency binds exact apply", async t => {
  const f = runtimeFixture(t);
  assert.match(f.runtime(), /^[a-f0-9]{64}$/);
  const store = ingestPlanStore();
  t.after(() => store.db.close());
  for (let i = 0; i < 20; i++) store.put(`drive:item${i}`);
  const state = { done: {}, skipped: {} };
  const review = createIngestRemovalReview({ state, saveState() {}, source: "drive", manifest: {},
    manifestPath: "/fixture/manifest.json", base: "https://fixture.invalid", runtime: f.runtime, request: store.request });
  const plan = () => review.finish({ sourcePlan: buildDriveRemovalPlan({
    storedFamilies: store.uids(), vanishedCandidates: ["drive:item0"],
  }) });
  const targets = [...paths, "node_modules/direct/index.js", "node_modules/hoisted/index.js"];
  for (const path of targets) {
    await assert.rejects(plan(), { code: "SAFETY_REVIEW_REQUIRED" });
    const saved = state.ingest_removal_plan;
    assert.deepEqual(saved.targets, ["drive:item0"], "a real nonempty plan was reached");
    const before = readFileSync(join(f.root, path));
    f.write(path, Buffer.concat([before, Buffer.from("\n// changed runtime bytes\n")]));
    assert.notEqual(f.runtime(), saved.runtime, path);
    await assert.rejects(review.apply(saved.fingerprint), /runtime no longer matches/, path);
    assert.equal(store.calls.apply, 0, path);
    f.write(path, before);
    assert.equal(f.runtime(), saved.runtime, "restoring exact bytes restores the binding");
  }
  await review.apply(state.ingest_removal_plan.fingerprint);
  assert.equal(store.calls.apply, 1, "matching runtime green control applies");
  assert.equal(store.uids().includes("drive:item0"), false);
  assert.ok(store.calls.preview > targets.length);
  t.diagnostic(`${targets.length} file mutations refused before any apply`);
});

test("manifest entries fail closed and runtime links remain refused", t => {
  const f = runtimeFixture(t);
  const before = f.runtime();
  const pkg = JSON.parse(readFileSync(join(f.root, "package.json")));
  for (const files of [[], undefined, ["../outside.mjs"], ["components/*.mjs"], ["missing.mjs"]]) {
    f.write("package.json", JSON.stringify({ ...pkg, files }));
    assert.throws(f.runtime);
  }
  f.write("package.json", JSON.stringify(pkg));
  assert.equal(f.runtime(), before);
  // Windows may require a privilege to create native file links. The portable
  // lstat controls below still exercise both file and parent-link refusal there.
  if (process.platform === "win32") return;
  const target = "components/imported.mjs";
  const bytes = readFileSync(join(f.root, target));
  rmSync(join(f.root, target));
  symlinkSync("../brain.mjs", join(f.root, target));
  assert.throws(f.runtime, /link/);
  rmSync(join(f.root, target));
  f.write(target, bytes);
  assert.equal(f.runtime(), before);
  // A link in an explicitly listed file's parent must also be refused.
  rmSync(join(f.root, "tools"), { recursive: true });
  symlinkSync("components", join(f.root, "tools"), "dir");
  assert.throws(f.runtime, /link/);
});

test("adding an optional installed dependency changes the runtime", t => {
  const f = runtimeFixture(t);
  const before = f.runtime();
  f.write("node_modules/optional/package.json", "{}");
  f.write("node_modules/optional/index.js", "// optional production dependency\n");
  assert.notEqual(f.runtime(), before);
});

test("links and special runtime entries refuse instead of disappearing from the binding", t => {
  const f = runtimeFixture(t);
  const before = f.runtime();
  const lstat = fs.lstatSync;
  for (const [target, kind] of [["components/imported.mjs", "special"],
    ["components/imported.mjs", "link"], ["tools", "link"]]) {
    let reached = 0;
    fs.lstatSync = path => {
      const stat = lstat(path);
      if (path === join(f.root, target)) {
        reached++;
        stat.isSymbolicLink = () => kind === "link";
        stat.isFile = () => false;
        stat.isDirectory = () => false;
      }
      return stat;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(f.runtime, kind === "link" ? /unverified link/ : /non-file entry/);
      assert.ok(reached > 0, "the unsafe entry was inspected");
    } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
    assert.equal(f.runtime(), before, "a regular-file control restores the digest");
  }
});

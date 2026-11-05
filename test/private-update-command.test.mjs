import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { cmdUpdate, dispatchUpdateCli, classifyCliCredentialBoundary, pinUpdateManifest, runCliCommandWithCredentialBoundary } from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { privateOfferTarget, PRIVATE_UPDATE_BINDING_ENV } from "../operations/private-update-offer.mjs";
import { createTestSymlink } from "./helpers/symlink-capability.mjs";

const now = Date.parse("2026-11-02T12:00:00.000Z");
const pair = generateKeyPairSync("ed25519");
const otherPair = generateKeyPairSync("ed25519");
const manifest = { brain: { version: "0.4.22" }, infrastructure: { cloudflare: {
  storage: "d1", account_id: "a".repeat(32), d1_database_id: "11111111-2222-4333-8444-555555555555",
} } };

function archive(version = "0.4.23") {
  const entries = {
    "package.json": JSON.stringify({ name: "brain-installer", version }),
    "brain.mjs": "// synthetic candidate\n",
    "empty.txt": "",
  };
  const blocks = [];
  for (const [path, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`package/${path}`);
    const octal = (offset, length, value) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
    octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0);
    octal(124, 12, raw.length); octal(136, 12, 0);
    header.fill(32, 148, 156); header[156] = 48;
    header.write("ustar\0", 257); header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    const padded = Buffer.alloc(Math.ceil(raw.length / 512) * 512);
    raw.copy(padded); blocks.push(header, padded);
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test("installed parser reaches private discovery before credentials", async () => {
  const boundary = classifyCliCredentialBoundary("update", ["--private-offer"]);
  assert.equal(boundary, "update-private-offer");
  let wrapperCalls = 0;
  let decisionCalls = 0;
  await runCliCommandWithCredentialBoundary(boundary, () => { decisionCalls++; }, {
    withWranglerSession: () => { wrapperCalls++; throw new Error("credential lookup reached"); },
  });
  assert.equal(decisionCalls, 1);
  assert.equal(wrapperCalls, 0);
});

test("real update dispatcher shows then stops, and verified install reaches normal updater", async (t) => {
  const core = await import("../operations/private-update-offer.mjs");
  const root = mkdtempSync(join(tmpdir(), "offer-dispatch-"));
  const manifestPath = join(root, "manifest.json");
  const packagePath = join(root, "candidate.tgz");
  const offerPath = join(root, "offer.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const packageBytes = archive();
  writeFileSync(packagePath, packageBytes);
  const makeOffer = (changes = {}, key = pair.privateKey) => {
    const unsigned = { ...core.createPrivateOffer({ manifest, toVersion: "0.4.23", packageBytes,
      packageUrl: "https://packages.example.invalid/build.tgz", reason: "A focused update for this Brain.",
    }, { now, nonce: "b".repeat(64) }), ...changes };
    return { ...unsigned, signature: sign(null, Buffer.from(core.canonicalPrivateJson(unsigned)), key).toString("base64url") };
  };
  let remote = makeOffer();
  let responseStatus = 200;
  const calls = [];
  const output = [];
  const dependencies = {
    now, publicKey: pair.publicKey,
    fetch: async (url, options) => {
      calls.push({ action: "fetch", url, options });
      return new Response(JSON.stringify(remote), { status: responseStatus });
    },
    installPackage: async (request) => { calls.push({ action: "normal-update", request }); return { status: "updated" }; },
    write: (line) => output.push(line),
  };
  const run = (argv) => dispatchUpdateCli(argv, { privateOfferOptions: dependencies });
  const summary = await run([manifestPath, "--private-offer", "--private-offer-file", offerPath]);
  assert.equal(summary.to_version, "0.4.23");
  assert.equal(calls.filter((c) => c.action === "normal-update").length, 0);
  assert.equal(calls[0].url, `https://financialbrain.ai/update/offers/${remote.target}.json`);
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(output.join("\n").includes(remote.reason));
  for (const text of [remote.from_version, remote.to_version, remote.expires_at]) assert.ok(output.join("\n").includes(text));
  assert.deepEqual(JSON.parse(readFileSync(offerPath, "utf8")), remote);
  const installArgs = [manifestPath, "--private-package", packagePath, "--private-offer-file", offerPath];
  assert.deepEqual(await run(installArgs), { status: "updated" });
  const normal = calls.find((c) => c.action === "normal-update").request;
  assert.equal(normal.manifestPath, realpathSync.native(manifestPath));
  assert.deepEqual(normal.bytes, packageBytes);
  assert.equal(normal.offer.to_version, "0.4.23");

  const refusals = [
    ["missing", () => { responseStatus = 404; }, "PRIVATE_OFFER_MISSING"],
    ["unsigned", () => { delete remote.signature; }, "PRIVATE_OFFER_UNSIGNED"],
    ["wrong key", () => { remote = makeOffer({}, otherPair.privateKey); }, "PRIVATE_OFFER_SIGNATURE"],
    ["wrong Brain", () => { remote = makeOffer({ target: "c".repeat(64) }); }, "PRIVATE_OFFER_TARGET"],
    ["expired", () => { remote = makeOffer({ issued_at: "2026-10-01T12:00:00.000Z", expires_at: "2026-10-15T12:00:00.000Z" }); }, "PRIVATE_OFFER_EXPIRED"],
    ["version mismatch", () => { remote = makeOffer({ from_version: "0.4.21" }); }, "PRIVATE_OFFER_VERSION"],
    ["byte mismatch", () => { writeFileSync(packagePath, Buffer.from("changed package")); }, "PRIVATE_OFFER_PACKAGE"],
    ["digest mismatch", () => { writeFileSync(packagePath, Buffer.alloc(packageBytes.length, 42)); }, "PRIVATE_OFFER_PACKAGE"],
    ["local offer changed", () => { writeFileSync(offerPath, JSON.stringify(makeOffer({ nonce: "c".repeat(64) }))); }, "PRIVATE_OFFER_CHANGED"],
    ["package version", () => {
      const wrong = archive("0.4.24"); writeFileSync(packagePath, wrong);
      remote = makeOffer({ package_bytes: wrong.length, package_sha256: createHash("sha256").update(wrong).digest("hex") });
      writeFileSync(offerPath, JSON.stringify(remote));
    }, "PRIVATE_OFFER_PACKAGE"],
  ];
  for (const [label, prepare, code] of refusals) await t.test(label, async () => {
    calls.length = 0; responseStatus = 200; remote = makeOffer();
    writeFileSync(packagePath, packageBytes); writeFileSync(offerPath, JSON.stringify(remote));
    prepare();
    await assert.rejects(Promise.resolve().then(() => run(installArgs)), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message.split("\n").length, 1);
      return true;
    });
    assert.equal(calls.filter((c) => c.action === "fetch").length, 1, "official lookup decision was reached");
    assert.equal(calls.filter((c) => c.action === "normal-update").length, 0);
    remote = makeOffer(); responseStatus = 200;
    writeFileSync(packagePath, packageBytes); writeFileSync(offerPath, JSON.stringify(remote));
    await run(installArgs);
    assert.equal(calls.filter((c) => c.action === "normal-update").length, 1, "green peer reaches normal update");
  });
  await t.test("offer expiry is rechecked at the package handoff", async () => {
    calls.length = 0;
    let clockReads = 0;
    dependencies.now = () => ++clockReads === 1 ? now : now + 15 * 86_400_000;
    await assert.rejects(run(installArgs), { code: "PRIVATE_OFFER_EXPIRED" });
    assert.ok(clockReads >= 2, "the final clock decision was reached");
    assert.equal(calls.filter((c) => c.action === "normal-update").length, 0);
    dependencies.now = now;
    await run(installArgs);
    assert.equal(calls.filter((c) => c.action === "normal-update").length, 1);
  });
  const help = [];
  dispatchUpdateCli(["--help"], { write: (line) => help.push(line) });
  assert.ok(help.join("\n").includes(renderCliCommands("brain update [manifest] --private-offer")));
});

test("package handoff installs verified bytes and calls the ordinary update entry", async () => {
  const { installPrivateUpdatePackage } = await import("../operations/private-update-package.mjs");
  const root = mkdtempSync(join(tmpdir(), "offer-package-"));
  const runtimeRoot = join(root, "node_modules", "brain-installer");
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ name: "brain-installer", version: "0.4.22" }));
  writeFileSync(join(runtimeRoot, "brain.mjs"), "// old synthetic runtime\n");
  const calls = [];
  const bytes = archive();
  const manifestPath = join(root, "manifest.json");
  const raw = JSON.stringify(manifest);
  writeFileSync(manifestPath, raw);
  const { privateOfferTarget } = await import("../operations/private-update-offer.mjs");
  const binding = { target: privateOfferTarget(manifest),
    fingerprint: createHash("sha256").update(raw).digest("hex") };
  const offer = { to_version: "0.4.23", package_bytes: bytes.length,
    package_sha256: createHash("sha256").update(bytes).digest("hex") };
  const dependencies = {
    runtimeRoot, temporaryRoot: root, npmCli: join(root, "npm-cli.js"),
    environment: { HOME: root, USERPROFILE: root, TMPDIR: root, PATH: "fixture-path", PRIVATE_AMBIENT_VALUE: "must-not-cross" },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        assert.deepEqual(readFileSync(args.at(-1)), bytes);
        writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ name: "brain-installer", version: "0.4.23" }));
        writeFileSync(join(runtimeRoot, "brain.mjs"), "// synthetic candidate\n");
        writeFileSync(join(runtimeRoot, "empty.txt"), "");
      }
      return { status: 0 };
    },
  };
  await installPrivateUpdatePackage({ bytes, offer, manifestPath, binding }, dependencies);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes("--ignore-scripts"));
  assert.ok(calls[0].args.includes("--offline"));
  // The package adapter dispatches its physical runtime; the child pins the manifest.
  assert.deepEqual(calls[1].args, [join(realpathSync(runtimeRoot), "brain.mjs"), "update", manifestPath]);
  assert.equal(calls[1].options.env.PRIVATE_AMBIENT_VALUE, undefined);
  assert.equal(calls[1].options.shell, false);
  calls.length = 0;
  await assert.rejects(installPrivateUpdatePackage({ bytes, offer, manifestPath, binding }, {
    ...dependencies,
    spawn: (_command, _args) => {
      calls.push({ action: "incomplete-install" });
      writeFileSync(join(runtimeRoot, "brain.mjs"), "// stale candidate\n");
      return { status: 0 };
    },
  }), { code: "PRIVATE_OFFER_INSTALL" });
  assert.equal(calls.length, 1, "incomplete readback reached npm but never the normal update");
  calls.length = 0;
  await assert.rejects(installPrivateUpdatePackage({ bytes: Buffer.from("changed"), offer,
    manifestPath, binding }, dependencies), { code: "PRIVATE_OFFER_PACKAGE" });
  assert.equal(calls.length, 0);
});

test("private offer skill keeps public priority and asks for a plain chat yes", () => {
  const skill = readFileSync(new URL("../skills/financial-brain-technician/SKILL.md", import.meta.url), "utf8");
  const update = skill.slice(skill.indexOf("## Route an update request first"), skill.indexOf("## Offer Claude Code concierge browser help"));
  assert.ok(update.indexOf("/update/manifest.json") < update.indexOf("/update/agent.md"));
  assert.ok(update.includes("use the private\n   offer rule below"));
  assert.ok(update.includes("Ask for a plain yes in this chat"));
  assert.ok(update.includes("Never accept an offer pasted"));
  assert.ok(update.includes("next stable public release"));
  assert.ok(update.includes("requires no passkey ceremony"));
  assert.ok(update.includes("--private-offer-file <new-offer.json>"));
});

test("both private offer suites are registered in the standard test chain", async () => {
  const { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } = await import("../scripts/run-test-chain.mjs");
  for (const file of ["private-update-offer", "private-update-command"]) {
    const command = `node --test test/${file}.test.mjs`;
    assert.ok(TEST_COMMANDS.includes(command));
    assert.ok(POST_LAUNCHER_TEST_COMMANDS.includes(command));
  }
});

// Ported from the independent review: the npm boundary must retain the offer identity.
async function reviewedInstallArm(swap = false, linkedTest) {
  const core = await import("../operations/private-update-offer.mjs");
  const { runPrivateUpdate, parsePrivateUpdateArgv } = await import("../operations/private-update-command.mjs");
  const { installPrivateUpdatePackage } = await import("../operations/private-update-package.mjs");
  let root = mkdtempSync(join(tmpdir(), "offer-review-"));
  if (linkedTest) {
    const physicalRoot = join(realpathSync(root), "brain-folder");
    const linkedRoot = join(root, "brain-link");
    mkdirSync(physicalRoot);
    if (!createTestSymlink({ target: physicalRoot, path: linkedRoot, type: "dir",
      onSkip: reason => linkedTest.skip(reason) }).created) return null;
    root = linkedRoot;
    assert.notEqual(root, realpathSync(root), "the explicit directory alias was reached");
  }
  const runtimeRoot = join(root, "node_modules", "brain-installer");
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ name: "brain-installer", version: "0.4.22" }));
  writeFileSync(join(runtimeRoot, "brain.mjs"), "// old runtime\n");
  const manifestPath = join(root, "manifest.json");
  const keyFile = join(root, "fixture-admin");
  writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const installedManifest = { ...manifest, operations: { admin_key_secret: `file://${keyFile}` } };
  const raw = JSON.stringify(installedManifest);
  writeFileSync(manifestPath, raw);
  const bytes = archive();
  const unsigned = core.createPrivateOffer({ manifest, toVersion: "0.4.23", packageBytes: bytes,
    packageUrl: "https://packages.example.invalid/build.tgz", reason: "A focused update." }, { now });
  const offer = { ...unsigned,
    signature: sign(null, Buffer.from(core.canonicalPrivateJson(unsigned)), pair.privateKey).toString("base64url") };
  const packagePath = join(root, "candidate.tgz"), offerPath = join(root, "offer.json");
  writeFileSync(packagePath, bytes);
  writeFileSync(offerPath, JSON.stringify(offer));
  const counts = { fetch: 0, revalidate: 0, npm: 0, normal: 0, wrongTarget: false };
  let requestManifestPath;
  const run = linkedTest
    ? (argv, dependencies) => dispatchUpdateCli(argv, { privateOfferOptions: dependencies })
    : (argv, dependencies) => runPrivateUpdate(parsePrivateUpdateArgv(argv), {
      discoverInstalledManifest: path => ({ path }),
      pinManifest: target => ({ target, raw, manifest: JSON.parse(raw),
        fingerprint: createHash("sha256").update(raw).digest("hex") }),
      revalidateManifest: pin => { counts.revalidate++; assert.equal(readFileSync(pin.target, "utf8"), pin.raw); },
      ...dependencies,
    });
  let childEnvironment;
  let result, failure;
  try {
    result = await run([manifestPath, "--private-package", packagePath,
      "--private-offer-file", offerPath], {
      now, publicKey: pair.publicKey,
      fetch: async (url, options) => {
        counts.fetch++;
        assert.equal(url, `https://financialbrain.ai/update/offers/${offer.target}.json`);
        assert.equal(options.redirect, "error");
        return new Response(JSON.stringify(offer), { status: 200 });
      },
      installPackage: request => {
        requestManifestPath = request.manifestPath;
        if (linkedTest) assert.equal(requestManifestPath, realpathSync.native(manifestPath), "real dispatcher pins the physical manifest");
        return installPrivateUpdatePackage(request, {
          runtimeRoot, temporaryRoot: root, npmCli: join(root, "npm-cli.js"),
          environment: { HOME: root, USERPROFILE: root, TMPDIR: root, BRAIN_NO_WRANGLER_LOGIN: "1" },
          spawn: (_command, args, options) => {
            if (args[1] === "install") {
              counts.npm++;
              assert.deepEqual(readFileSync(args.at(-1)), bytes);
              writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ name: "brain-installer", version: "0.4.23" }));
              writeFileSync(join(runtimeRoot, "brain.mjs"), "// synthetic candidate\n");
              writeFileSync(join(runtimeRoot, "empty.txt"), "");
              if (swap) {
                const changed = JSON.parse(raw);
                if (swap !== "fingerprint") changed.infrastructure.cloudflare.d1_database_id = "66666666-7777-4888-8999-000000000000";
                const changedRaw = JSON.stringify(changed) + (swap === "fingerprint" ? "\n" : "");
                if (linkedTest) {
                  const replacement = join(root, "replacement.json");
                  writeFileSync(replacement, changedRaw);
                  renameSync(replacement, manifestPath);
                } else writeFileSync(manifestPath, changedRaw);
              }
            } else {
              counts.normal++;
              assert.deepEqual(args, [join(realpathSync(runtimeRoot), "brain.mjs"), "update", request.manifestPath]);
              counts.wrongTarget = core.privateOfferTarget(JSON.parse(readFileSync(args[2], "utf8"))) !== offer.target;
              childEnvironment = options.env;
            }
            return { status: 0 };
          },
        });
      },
    });
  } catch (error) { failure = error; }
  return { counts, result, failure, childEnvironment, offer, raw, manifestPath, requestManifestPath };
}

test("explicit Brain folder symlink keeps the real private update path and replacement refusals", async t => {
  const green = await reviewedInstallArm(false, t);
  if (!green) return;
  assert.equal(green.failure, undefined);
  assert.equal(green.result.status, "updated");
  assert.equal(green.counts.fetch, 1);
  assert.equal(green.counts.npm, 1);
  assert.equal(green.counts.normal, 1, "the verified package reached the ordinary updater");
  assert.equal(green.counts.wrongTarget, false);
  assert.notEqual(green.manifestPath, green.requestManifestPath);
  assert.equal(green.requestManifestPath, pinUpdateManifest(green.manifestPath).target);
  assert.deepEqual(JSON.parse(green.childEnvironment[PRIVATE_UPDATE_BINDING_ENV]), {
    target: green.offer.target, fingerprint: createHash("sha256").update(green.raw).digest("hex"),
  });
  for (const mutation of ["target", "fingerprint"]) {
    const refused = await reviewedInstallArm(mutation, t);
    assert.equal(refused.counts.fetch, 1);
    assert.equal(refused.counts.npm, 1, "atomic manifest replacement inside npm was reached");
    assert.notEqual(readFileSync(refused.manifestPath, "utf8"), refused.raw, "replacement bytes are present");
    assert.equal(refused.failure?.code, "PRIVATE_OFFER_BINDING");
    assert.equal(refused.counts.normal, 0);
  }
});

test("review RPL-01 green reaches ordinary updater through the real adapter", async () => {
  const { counts, result, failure } = await reviewedInstallArm();
  assert.equal(failure, undefined);
  assert.equal(result.status, "updated");
  assert.deepEqual(counts, { fetch: 1, revalidate: 2, npm: 1, normal: 1, wrongTarget: false });
});

test("review RPL-01 refuses a manifest replaced during npm", async () => {
  const { counts, failure } = await reviewedInstallArm(true);
  assert.equal(counts.fetch, 1);
  assert.equal(counts.revalidate, 2);
  assert.equal(counts.npm, 1, "the mutation point inside npm was reached");
  assert.ok(failure, "changed manifest target reached the ordinary update child");
  assert.equal(failure.code, "PRIVATE_OFFER_BINDING");
  assert.equal(counts.normal, 0);
  assert.equal((await reviewedInstallArm()).result.status, "updated");
});

test("RPL-01 child checks the carried binding under its lock before any update effect", async () => {
  const green = await reviewedInstallArm();
  assert.equal(green.result.status, "updated");
  const envName = "BRAIN_PRIVATE_UPDATE_BINDING";
  const previous = process.env[envName];
  // The expected bytes must come from the parent that verified the offer.
  const expected = { target: green.offer.target,
    fingerprint: createHash("sha256").update(green.raw).digest("hex") };
  const encoded = green.childEnvironment[envName];
  assert.deepEqual(JSON.parse(encoded), expected, "adapter carries the original binding");
  process.env[envName] = encoded;
  try {
    for (const mutation of ["target", "fingerprint", "unchanged"]) {
      const events = [];
      const boundary = new Error("synthetic normal update effect reached");
      const run = runCliCommandWithCredentialBoundary("update", () => cmdUpdate(green.manifestPath, {
        discoverInstalledManifest: path => { events.push("discover"); return { path, source: "remembered" }; },
        withBrainLifecycleLockWait: async (_request, action) => {
          events.push("lock");
          const changed = JSON.parse(green.raw);
          if (mutation === "target") changed.infrastructure.cloudflare.d1_database_id = "66666666-7777-4888-8999-000000000000";
          writeFileSync(green.manifestPath, JSON.stringify(changed) + (mutation === "fingerprint" ? "\n" : ""));
          return action();
        },
        answerSetupNeedsRecovery: () => { events.push("recovery"); return false; },
        readUpdateBacklog: async () => { events.push("backlog"); return { pending: 0 }; },
        adoptCloudflareAuthProfile: async () => { events.push("effect"); throw boundary; },
      }), { withWranglerSession: () => { events.push("outer credential"); throw new Error("credential wrapper reached"); } });
      if (mutation === "unchanged") {
        await assert.rejects(run, error => error === boundary);
        assert.deepEqual(events, ["lock", "discover", "recovery", "backlog", "effect"]);
      } else {
        await assert.rejects(run, error => {
          assert.equal(error.code, "PRIVATE_OFFER_BINDING");
          assert.equal(error.supportCode, "UPGRADE_FAILED");
          assert.equal(error.constructor.name, "Fatal");
          assert.match(error.message, /manifest changed/i);
          assert.ok(error.message.includes("Support code:"));
          assert.equal(error.message.split("\n").length, 1);
          return true;
        });
        assert.deepEqual(events, ["lock", "discover"], "lock and discovery reached, no credentials or effects");
      }
    }
    assert.deepEqual(JSON.parse(green.childEnvironment[envName]), expected, "adapter carries the original binding");
  } finally {
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
  }
});

// Ported from review RPL-R2-01: both awaits precede the ordinary manifest pin.
async function reviewedChildBindingArm(stage = "unchanged", field = "target") {
  const root = mkdtempSync(join(tmpdir(), "child-binding-"));
  const manifestPath = join(root, "manifest.json");
  const keyFile = join(root, "fixture-admin");
  writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  writeFileSync(manifestPath, JSON.stringify({
    ...manifest, operations: { admin_key_secret: `file://${keyFile}` },
  }));
  const original = pinUpdateManifest(manifestPath);
  const binding = { target: privateOfferTarget(original.manifest), fingerprint: original.fingerprint };
  const previous = process.env[PRIVATE_UPDATE_BINDING_ENV];
  process.env[PRIVATE_UPDATE_BINDING_ENV] = JSON.stringify(binding);
  const events = [];
  let changed = 0, verifiedWrongTarget = false, verifiedWrongVersion = false;
  const boundary = new Error("synthetic verification boundary");
  function mutate() {
    const value = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (field === "target") value.infrastructure.cloudflare.d1_database_id = "66666666-7777-4888-8999-000000000000";
    else value.brain.version = "0.4.21";
    writeFileSync(manifestPath, JSON.stringify(value));
    changed++;
  }
  let failure;
  try {
    await runCliCommandWithCredentialBoundary("update", () => cmdUpdate(manifestPath, {
      discoverInstalledManifest: path => { events.push("discover"); return { path, source: "remembered" }; },
      withBrainLifecycleLockWait: async (_request, action) => { events.push("lock"); return action(); },
      answerSetupNeedsRecovery: () => { events.push("recovery"); return false; },
      readUpdateBacklog: async () => {
        events.push("backlog");
        if (stage === "during-backlog") mutate();
        return { pending: 0 };
      },
      adoptCloudflareAuthProfile: async () => {
        events.push("adoption");
        if (stage === "during-adoption") mutate();
      },
      withCloudflareControl: async action => { events.push("control"); return action(); },
      cmdVerify: async path => {
        events.push("verify");
        const value = JSON.parse(readFileSync(path, "utf8"));
        verifiedWrongTarget = privateOfferTarget(value) !== binding.target;
        verifiedWrongVersion = value.brain.version !== original.manifest.brain.version;
        throw boundary;
      },
      dailyRefreshOptions: { schedulerOptions: { launchctl: () => { throw new Error("synthetic launch boundary"); } } },
    }), { withWranglerSession: () => { throw new Error("unexpected outer credential boundary"); } });
  } catch (error) { failure = error; }
  finally {
    if (previous === undefined) delete process.env[PRIVATE_UPDATE_BINDING_ENV];
    else process.env[PRIVATE_UPDATE_BINDING_ENV] = previous;
  }
  return { stage, field, changed, events, verifiedWrongTarget, verifiedWrongVersion, failure, boundary };
}

test("review RPL-R2-01 unchanged private child reaches ordinary verification through its lock", async () => {
  const result = await reviewedChildBindingArm();
  assert.equal(result.failure, result.boundary);
  assert.equal(result.changed, 0);
  assert.deepEqual(result.events, ["lock", "discover", "recovery", "backlog", "adoption", "control", "verify"]);
  assert.equal(result.verifiedWrongTarget, false);
  assert.equal(result.verifiedWrongVersion, false);
});

for (const stage of ["during-backlog", "during-adoption"]) {
  for (const field of ["target", "from_version"]) {
    test(`review RPL-R2-01 private child preserves ${field} after ${stage}`, async () => {
      const green = await reviewedChildBindingArm();
      assert.equal(green.failure, green.boundary);
      const result = await reviewedChildBindingArm(stage, field);
      assert.equal(result.changed, 1, "the mutation decision was reached");
      assert.ok(result.events.includes(stage === "during-backlog" ? "backlog" : "adoption"));
      assert.equal(result.failure?.code, "PRIVATE_OFFER_BINDING", "the original offer binding must survive asynchronous preflight");
      assert.equal(result.failure.supportCode, "UPGRADE_FAILED");
      assert.equal(result.failure.constructor.name, "Fatal");
      assert.match(result.failure.message, /manifest changed/i);
      assert.ok(result.failure.message.includes("Support code: PRIVATE_OFFER_BINDING"));
      assert.equal(result.failure.message.split("\n").length, 1);
      assert.equal(result.events.includes("control"), false);
      assert.equal(result.events.includes("verify"), false);
    });
  }
}

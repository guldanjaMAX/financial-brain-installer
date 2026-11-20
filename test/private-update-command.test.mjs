import { isolatedLifecycleOptions } from "./fixtures/isolated-update-schedulers.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, realpathSync, renameSync, readdirSync, lstatSync, rmSync, unlinkSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { cmdUpdate, dispatchUpdateCli, classifyCliCredentialBoundary, pinUpdateManifest, runCliCommandWithCredentialBoundary, supportErrorCode } from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { privateOfferTarget, PRIVATE_UPDATE_BINDING_ENV } from "../operations/private-update-offer.mjs";
import { writePrivateUpdateOutcome } from "../operations/private-update-recovery.mjs";
import { clearDailyRefreshUpdateTransaction, writeDailyRefreshUpdateTransaction } from "../operations/daily-refresh-scheduler.mjs";
import { createTestSymlink } from "./helpers/symlink-capability.mjs";
import { injectRenameFaults, isDailyUpdateReceipt, isPrivateSwapJournal, refusedThenReplaced } from "./helpers/rename-faults.mjs";
import { lostByOwnTermination, ownTerminationSource, windowsExitShape } from "./helpers/process-loss.mjs";
import { acquireBrainLifecycleLock, adoptParentBrainLifecycleLock, brainLifecycleCoordinates, BRAIN_LIFECYCLE_PARENT_ENV,
  readBrainRecoveryFence, writeBrainRecoveryFence } from "../operations/brain-lifecycle-lock.mjs";

function finishSyntheticSchedules(home, machineLockRoot, manifestPath, platform) {
  const directory = join(home, ".brain", "daily-update-transactions");
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).filter(name => name.endsWith(".json"))) {
    const receipt = JSON.parse(readFileSync(join(directory, name), "utf8"));
    clearDailyRefreshUpdateTransaction(receipt.identity, { home, machineLockRoot, manifestPath, platform });
  }
}

function privateFixtureEnvironment(root) {
  const environment = { HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root,
    BRAIN_NO_WRANGLER_LOGIN: "1", ProgramData: join(root, "ProgramData"), LOCALAPPDATA: join(root, "AppData", "Local") };
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "ComSpec", "PATHEXT"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

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
    platform: "darwin",
    runtimeRoot, temporaryRoot: root, npmCli: join(root, "npm-cli.js"),
    lifecycleLockOptions: isolatedLifecycleOptions(root, { machineLockRoot: join(root, "machine-locks") }),
    scheduleOptions: { platform: "darwin", home: root, launchctl: () => { throw new Error("host scheduler reached"); }, adapter: { read: () => ({ exists: false }) } },
    environment: { HOME: root, USERPROFILE: root, TMPDIR: root, PATH: "fixture-path", PRIVATE_AMBIENT_VALUE: "must-not-cross" },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        assert.deepEqual(readFileSync(args.at(-1)), bytes);
        const installed = join(args[args.indexOf("--prefix") + 1], "node_modules", "brain-installer");
        mkdirSync(installed, { recursive: true });
        writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "brain-installer", version: "0.4.23" }));
        writeFileSync(join(installed, "brain.mjs"), "// synthetic candidate\n");
        writeFileSync(join(installed, "empty.txt"), "");
      } else {
        finishSyntheticSchedules(root, join(root, "machine-locks"), manifestPath, "darwin");
        writePrivateUpdateOutcome(options.env, "verified");
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
async function reviewedInstallArm(swap = false, linkedTest, adapterOptions = {}) {
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
  const installedManifest = { ...manifest, ...adapterOptions.manifestFields,
    operations: { admin_key_secret: `file://${keyFile}` } };
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
  let childEnvironment, npmEnvironment;
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
        const installEnvironment = { ...privateFixtureEnvironment(root), ...adapterOptions.environment };
        const lifecycleLockOptions = isolatedLifecycleOptions(root, { machineLockRoot: join(root, "machine-locks"),
          now: () => new Date(now), lockRootOptions: { environment: installEnvironment } });
        adapterOptions.beforeInstall?.({ manifestPath: request.manifestPath, ...lifecycleLockOptions });
        return installPrivateUpdatePackage(request, {
          platform: "darwin",
          runtimeRoot, temporaryRoot: root, npmCli: join(root, "npm-cli.js"),
          lifecycleLockOptions,
          scheduleOptions: { platform: "darwin", home: root, launchctl: () => { throw new Error("host scheduler reached"); }, adapter: { read: () => ({ exists: false }) } },
          environment: installEnvironment,
          spawn: (_command, args, options) => {
            adapterOptions.onSpawn?.({ command: _command, args, options,
              manifestPath: request.manifestPath, ...lifecycleLockOptions });
            if (args[1] === "install") {
              counts.npm++;
              npmEnvironment = options.env;
              assert.deepEqual(readFileSync(args.at(-1)), bytes);
              const installed = join(args[args.indexOf("--prefix") + 1], "node_modules", "brain-installer");
              mkdirSync(installed, { recursive: true });
              writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "brain-installer", version: "0.4.23" }));
              writeFileSync(join(installed, "brain.mjs"), "// synthetic candidate\n");
              writeFileSync(join(installed, "empty.txt"), "");
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
              const child = adapterOptions.runChild?.({ args, options, lifecycleLockOptions });
              if (child) return child;
              finishSyntheticSchedules(root, join(root, "machine-locks"), request.manifestPath, "darwin");
              writePrivateUpdateOutcome(options.env, "verified");
            }
            return { status: 0 };
          },
        });
      },
    });
  } catch (error) { failure = error; }
  return { counts, result, failure, childEnvironment, npmEnvironment, offer, raw, manifestPath, requestManifestPath, runtimeRoot };
}

test("M1 Windows private-package dispatch preserves identity and the shared lock root", async () => {
  const { restrictWindowsFileToCurrentUser } = await import("../operations/current-user-file.mjs");
  const root = mkdtempSync(join(tmpdir(), "private-windows-env-"));
  const environment = { USERNAME: "fixture-owner", USERDOMAIN: "FIXTURE", HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\fixture-owner", WINDIR: "C:\\Windows", SystemRoot: "C:\\Windows",
    ProgramData: join(root, "program-data"), SystemDrive: "C:",
    PRIVATE_AMBIENT_VALUE: "must-not-cross" };
  const green = await reviewedInstallArm(false, undefined, { environment });
  assert.equal(green.failure, undefined);
  assert.equal(green.counts.fetch, 1, "the exact private-package offer decision was reached");
  assert.equal(green.counts.npm, 1);
  assert.equal(green.counts.normal, 1, "the installed update child was reached");
  for (const env of [green.npmEnvironment, green.childEnvironment]) {
    for (const name of Object.keys(environment).filter(name => name !== "PRIVATE_AMBIENT_VALUE")) {
      assert.equal(env[name], environment[name], `Windows runtime field ${name} survives the allowlist`);
    }
    assert.equal(env.PRIVATE_AMBIENT_VALUE, undefined);
  }
  let aclCalls = 0;
  const aclOptions = { environment: green.childEnvironment,
    runAcl: (_command, args, options) => {
      aclCalls++;
      assert.ok(args.includes(`${environment.USERNAME}:F`));
      assert.equal(options.env.USERNAME, environment.USERNAME);
      return { status: 0 };
    } };
  assert.equal(restrictWindowsFileToCurrentUser(join(root, "fixture-admin"), aclOptions), true);
  assert.equal(aclCalls, 1, "the production Windows ACL consumer accepted the forwarded identity");
  assert.throws(() => restrictWindowsFileToCurrentUser(join(root, "fixture-admin"), {
    ...aclOptions, environment: { ...green.childEnvironment, USERNAME: undefined, USER: undefined },
  }), /could not identify the current user/);
  assert.equal(aclCalls, 1, "missing identity refuses at the ACL decision before launching anything");
});

test("M2 running daily refresh blocks the exact private-package input before npm", async () => {
  let daily;
  try {
    const refused = await reviewedInstallArm(false, undefined, {
      beforeInstall: options => { daily = acquireBrainLifecycleLock({ ...options, operation: "daily-refresh" }); },
    });
    assert.equal(refused.counts.fetch, 1);
    assert.equal(refused.counts.revalidate, 2, "the verified package reached the install decision");
    assert.equal(daily.assertOwned(), true, "a real daily writer holds the canonical lease");
    assert.equal(refused.failure?.code, "brain_lifecycle_busy");
    assert.equal(refused.counts.npm, 0, "a running daily writer prevents package replacement");
    assert.equal(refused.counts.normal, 0);
  } finally { daily?.release(); }
  const green = await reviewedInstallArm();
  assert.equal(green.failure, undefined);
  assert.equal(green.counts.npm, 1, "the idle control installs the same verified package");
  assert.equal(green.counts.normal, 1);
});

test("M2 private install holds one update lease through npm and the child handoff", async () => {
  const stages = [];
  const green = await reviewedInstallArm(false, undefined, {
    onSpawn: options => {
      let contender;
      try {
        contender = acquireBrainLifecycleLock({ ...options, operation: "daily-refresh" });
        stages.push({ stage: options.args[1], held: false });
      } catch (error) {
        stages.push({ stage: options.args[1], held: error.code === "brain_lifecycle_busy" });
      } finally { contender?.release(); }
    },
  });
  assert.equal(green.failure, undefined);
  assert.equal(green.counts.npm, 1);
  assert.equal(green.counts.normal, 1);
  assert.deepEqual(stages, [{ stage: "install", held: true }, { stage: "update", held: true }],
    "a real competing daily writer reaches both decision points and is excluded");
  const control = acquireBrainLifecycleLock({ manifestPath: green.manifestPath,
    machineLockRoot: join(green.manifestPath, "..", "machine-locks"), operation: "daily-refresh" });
  assert.equal(control.assertOwned(), true, "completion releases the parent lease");
  control.release();
});

async function privateChildArm(mutation = "unchanged", preflight = "sign-in-incomplete") {
  let childResult, observed;
  const result = await reviewedInstallArm(false, undefined, {
    ...(preflight === "key-missing" ? { manifestFields: {
      retrieval: { answer_model: "claude-opus-5-5", gate_model: "claude-sonnet-5-5" },
    } } : {}),
    runChild: ({ args, options, lifecycleLockOptions }) => {
      const environment = { ...options.env };
      if (mutation !== "unchanged") {
        const delegation = JSON.parse(environment[BRAIN_LIFECYCLE_PARENT_ENV]);
        if (mutation === "pid") delegation.pid++;
        if (mutation === "token") delegation.token = "0".repeat(32);
        if (mutation === "instance") delegation.process_instance = "fixture-other-process";
        if (mutation === "shape") delegation.schema_version = 2;
        environment[BRAIN_LIFECYCLE_PARENT_ENV] = mutation === "malformed" ? "{" : JSON.stringify(delegation);
      }
      // Only injected preflight dependencies run. No credential helper, native
      // scheduler, Brain, or control-plane request is permitted in this child.
      const source = `
        import { cmdUpdate } from ${JSON.stringify(new URL("../brain.mjs", import.meta.url).href)};
        import { acquireBrainLifecycleLock, brainLifecycleCoordinates } from ${JSON.stringify(new URL("../operations/brain-lifecycle-lock.mjs", import.meta.url).href)};
        import { readFileSync } from "node:fs";
        import { join } from "node:path";
        const manifestPath = process.argv[1];
        const lockOptions = { machineLockRoot: process.argv[2], home: process.env.HOME,
          lockRootOptions: { environment: process.env } };
        const observation = { adoption: 0, childAcquire: 0, busy: false, ownPid: false, boundary: false };
        const preflight = ${JSON.stringify(preflight)};
        if (preflight !== "sign-in-incomplete") Object.assign(observation, { backlog: 0, keyNames: 0 });
        const boundary = new Error("synthetic update boundary");
        try {
          await cmdUpdate(manifestPath, {
            lifecycleLockOptions: lockOptions,
            discoverInstalledManifest: path => ({ path }),
            withBrainLifecycleLockWait: () => { observation.childAcquire++; throw boundary; },
            answerSetupNeedsRecovery: () => false,
            readUpdateBacklog: async () => {
              if (preflight !== "sign-in-incomplete") observation.backlog++;
              return { pending: preflight === "queue-busy" ? 1 : 0 };
            },
            withCloudflareControl: async action => action(),
            answerKeyOptions: { cf: async () => { observation.keyNames++; return []; } },
            dailyRefreshOptions: { schedulerOptions: { launchctl: () => { throw boundary; } } },
            adoptCloudflareAuthProfile: async () => {
              observation.adoption++;
              const coordinates = brainLifecycleCoordinates({ manifestPath, ...lockOptions });
              const owner = JSON.parse(readFileSync(join(coordinates.root, "brain-lifecycle-" + coordinates.identity + ".lock", "owner.json"), "utf8"));
              observation.ownPid = owner.pid === process.pid;
              let contender;
              try { contender = acquireBrainLifecycleLock({ manifestPath, ...lockOptions, operation: "daily-refresh" }); }
              catch (error) { observation.busy = error.code === "brain_lifecycle_busy"; }
              finally { contender?.release(); }
              if (preflight === "sign-in-incomplete") throw boundary;
            },
          });
        } catch (error) {
          observation.boundary = error === boundary;
          observation.supportCode = error.supportCode;
          if (preflight === "key-missing") observation.missingKey = /Anthropic key.*missing/.test(error.message);
        }
        process.stdout.write(JSON.stringify(observation));
      `;
      // A hung-child bound, not a speed budget: on a loaded host this real
      // CLI child overran the former 5 s limit and masked the tested decision.
      childResult = spawnSync(process.execPath, ["--input-type=module", "-e", source,
        args[2], lifecycleLockOptions.machineLockRoot], { env: environment, shell: false, encoding: "utf8", timeout: 60_000 });
      assert.equal(childResult.error, undefined, `real child launch: ${childResult.error?.code}`);
      assert.equal(childResult.status, 0);
      observed = JSON.parse(childResult.stdout);
      // The injected preflight intentionally threw. The parent must now roll
      // back, rather than treating a reached boundary as update success.
      return { status: 1 };
    },
  });
  return { ...result, observed, childResult };
}

test("M2 installed child takes ownership without reacquisition or a writer gap", async () => {
  const green = await privateChildArm();
  assert.equal(green.counts.npm, 1);
  assert.equal(green.counts.normal, 1, "the exact private-package path launched the real update child");
  assert.equal(green.failure?.code, "PRIVATE_OFFER_UPDATE");
  assert.deepEqual(green.observed, { adoption: 1, childAcquire: 0, busy: true, ownPid: true, boundary: true });
  const control = acquireBrainLifecycleLock({ manifestPath: green.manifestPath,
    machineLockRoot: join(green.manifestPath, "..", "machine-locks"), operation: "daily-refresh" });
  assert.equal(control.assertOwned(), true, "child failure releases only the child's new lease");
  control.release();
});

for (const mutation of ["pid", "token", "instance", "shape", "malformed"]) {
  test(`M2 child refuses ${mutation} parent lease before any update effect`, async () => {
    const refused = await privateChildArm(mutation);
    assert.equal(refused.counts.npm, 1);
    assert.equal(refused.counts.normal, 1, "the child lease-validation decision was reached");
    assert.equal(refused.failure?.code, "PRIVATE_OFFER_UPDATE");
    assert.deepEqual(refused.observed, { adoption: 0, childAcquire: 0, busy: false,
      ownPid: false, boundary: false, supportCode: "UPGRADE_FAILED" });
    const green = await privateChildArm();
    assert.equal(green.failure?.code, "PRIVATE_OFFER_UPDATE");
    assert.equal(green.observed.adoption, 1, "the same child reaches the injected update effect with a valid parent");
    assert.equal(green.observed.busy, true);
  });
}

test("M2 handoff ACL refusal preserves the parent; takeover defeats parent cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "private-handoff-"));
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const options = { manifestPath, platform: "win32",
    // Keep the refusal at handoff staging, after account-root validation.
    ...isolatedLifecycleOptions(root, { machineLockRoot: join(root, "locks"),
      lockRootOptions: { restrictWindowsDirectory() {} } }),
    now: () => new Date(now), restrictWindowsDirectory() {} };
  const parent = acquireBrainLifecycleLock({ ...options, operation: "update" });
  assert.ok(parent.accountPath && parent.legacyPath, "the injected Windows home retains both additional slots");
  let child, aclCalls = 0;
  try {
    const delegation = parent.childDelegation();
    assert.throws(() => adoptParentBrainLifecycleLock({ ...options, delegation, parentPid: process.pid,
      restrictWindowsDirectory() { aclCalls++; throw new Error("synthetic ACL refusal"); },
    }), { code: "brain_lifecycle_unsafe" });
    assert.equal(aclCalls, 1, "the native handoff ACL decision was reached");
    assert.equal(parent.assertOwned(), true);
    child = adoptParentBrainLifecycleLock({ ...options, delegation, parentPid: process.pid,
      restrictWindowsDirectory() { aclCalls++; },
    });
    assert.equal(aclCalls, 1 + new Set([parent.path, parent.accountPath, parent.legacyPath].filter(Boolean)).size,
      "the permitted ACL control reaches takeover of every retained slot");
    assert.equal(parent.release(), false, "parent cleanup cannot release the child's fresh token");
    assert.equal(child.assertOwned(), true);
    let contenders = 0;
    assert.throws(() => acquireBrainLifecycleLock({ ...options, operation: "daily-refresh",
      isOwnerAlive() { contenders++; return true; },
    }), { code: "brain_lifecycle_busy" });
    assert.equal(contenders, 1, "a daily writer reached the transferred lease");
  } finally { child?.release(); parent.release(); }
  const control = acquireBrainLifecycleLock({ ...options, operation: "daily-refresh" });
  assert.equal(control.assertOwned(), true);
  control.release();
});

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

// Audit R1: use the production installer and native pause/restore projection,
// with a Standard-user task adapter. No host scheduler or credential helper runs.
async function auditedPackageArm(arm = "success", enabled = true, audit = {}) {
  const { installPrivateUpdatePackage } = await import("../operations/private-update-package.mjs");
  // Production hands both update processes the canonical manifest path
  // (private-update-command pins it). Resolve the temp root the same way, or a
  // linked temp folder (macOS /var -> /private/var) splits the bridge binding.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "private-audit-r1-")));
  const runtimeRoot = join(root, "node_modules", "brain-installer");
  mkdirSync(runtimeRoot, { recursive: true });
  const oldPackage = JSON.stringify({ name: "brain-installer", version: "0.4.22" });
  writeFileSync(join(runtimeRoot, "package.json"), oldPackage);
  writeFileSync(join(runtimeRoot, "brain.mjs"), "// old runtime\n");
  writeFileSync(join(runtimeRoot, "old-only.txt"), "old runtime companion\n");
  const manifestPath = join(root, "manifest.json"), keyPath = join(root, "fixture-admin");
  writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  const m = { ...manifest, ...audit.manifestFields, operations: { ...audit.manifestFields?.operations, admin_key_secret: `file://${keyPath}` } };
  const raw = JSON.stringify(m);
  writeFileSync(manifestPath, raw);
  const binding = { target: privateOfferTarget(m), fingerprint: createHash("sha256").update(raw).digest("hex") };
  const bytes = archive();
  const offer = { to_version: "0.4.23", package_bytes: bytes.length,
    package_sha256: createHash("sha256").update(bytes).digest("hex") };
  const calls = [];
  const state = { exists: true, owned: true, enabled, definition: null };
  const scheduleOptions = { platform: "win32", principal: "sid:S-1-5-21-100-200-300-1001", home: root,
    launchctl: () => { throw new Error("host scheduler reached"); },
    quickBooksSchedulerOptions: { adapter: { read: () => ({ exists: false }) } },
    adapter: {
      read(identity) {
        calls.push("task-read");
        state.definition ??= { platform: "win32", identity, definition_hash: `sha256:${"a".repeat(64)}`,
          native_definition_hash: `sha256:${"b".repeat(64)}`, native_contract_valid: true };
        return structuredClone(state);
      },
      setEnabled(_identity, value) {
        calls.push(value ? "task-enable" : "task-disable");
        if (arm !== "pause-unproven") state.enabled = value;
      },
      install() { throw new Error("unexpected task replacement"); },
    } };
  Object.assign(scheduleOptions, audit.configure?.({ root, m, manifestPath, calls, state }) || {});
  let failure, result, outcomePath, staging;
  try {
    result = await installPrivateUpdatePackage({ bytes, offer, manifestPath, binding }, {
      runtimeRoot, temporaryRoot: root, npmCli: join(root, "npm-cli.js"), scheduleOptions,
      platform: audit.platform ?? "win32", restrictDirectory: path => { calls.push("restrict-directory"); audit.onRestrict?.(path); },
      // A native Windows host keeps the production backoff: a scanner can
      // really hold a freshly written runtime folder for part of a second.
      renameOptions: process.platform === "win32" ? {} : { sleep: () => {} },
      rename(source, target) {
        calls.push("runtime-rename");
        audit.onRename?.({ source, target, calls });
        if (arm === "replacement-rename-failed" && source.includes(join("candidate", "node_modules"))) {
          throw Object.assign(new Error("synthetic directory busy"), { code: "EPERM" });
        }
        if (arm === "rollback-rename-failed" && source.endsWith("prior-runtime")) {
          throw Object.assign(new Error("synthetic rollback busy"), { code: "EPERM" });
        }
        renameSync(source, target);
      },
      lifecycleLockOptions: isolatedLifecycleOptions(root, { machineLockRoot: join(root, "locks"), now: () => new Date(now),
        lockRootOptions: { environment: { ...isolatedLifecycleOptions(root).lockRootOptions.environment,
          ProgramData: join(root, "program-data") } } }),
      environment: { HOME: root, USERPROFILE: root, USERNAME: "fixture-owner", USERDOMAIN: "FIXTURE",
        ...audit.environment, ProgramData: join(root, "program-data"), SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows",
        TEMP: root, TMP: root, BRAIN_NO_WRANGLER_LOGIN: "1" },
      spawn(_command, args, options) {
        assert.equal(options.shell, false);
        audit.onSpawn?.({ args, options });
        if (args[1] === "install") {
          calls.push("npm");
          staging = options.cwd;
          calls.push(state.enabled ? "npm-task-enabled" : "npm-task-paused");
          const staged = join(args[args.indexOf("--prefix") + 1], "node_modules", "brain-installer");
          mkdirSync(staged, { recursive: true });
          writeFileSync(join(staged, "package.json"), JSON.stringify({ name: "brain-installer", version: "0.4.23" }));
          writeFileSync(join(staged, "brain.mjs"), arm === "hash-mismatch" ? "// quarantined\n" : "// synthetic candidate\n");
          writeFileSync(join(staged, "empty.txt"), "");
          if (arm === "npm-failed") return { status: 1 };
          return { status: 0 };
        }
        calls.push("child");
        const realChild = audit.onChild?.({ options, calls });
        if (realChild) return realChild;
        calls.push(state.enabled ? "child-task-enabled" : "child-task-paused");
        outcomePath = options.env.BRAIN_PRIVATE_UPDATE_OUTCOME;
        if (arm === "killed-child") return { status: null, signal: "SIGKILL" };
        // Windows reports a terminated child as exit code 1 with no signal.
        if (arm === "killed-child-windows") return { status: 1, signal: null };
        if (arm === "unproven-success") return { status: 0 };
        const remote = arm.startsWith("remote-started") ? "unknown" : arm === "success" ? "verified" : "not_started";
        if (outcomePath) writeFileSync(outcomePath, JSON.stringify({ schema_version: 1, binding, remote,
          status: arm === "success" ? "updated" : "failed" }), { mode: 0o600 });
        if (arm === "task-drift") state.definition.native_definition_hash = `sha256:${"c".repeat(64)}`;
        if (arm === "remote-started-enabled") state.enabled = true;
        if (arm === "child-manifest-changed") {
          writeFileSync(manifestPath, JSON.stringify({ ...m, brain: { ...m.brain, version: "0.4.24" } }));
        }
        if (arm === "foreign-transaction") {
          const plan = { identity: state.definition.identity, manifest_path: manifestPath };
          const transactionOptions = { home: root, manifestPath, platform: "win32", machineLockRoot: join(root, "locks") };
          clearDailyRefreshUpdateTransaction(plan, transactionOptions);
          writeDailyRefreshUpdateTransaction({ plan, snapshot: { ...state, identity: plan.identity },
            phase: "recovery_required", remoteMutationMayHaveStarted: true }, transactionOptions);
          calls.push("foreign-transaction-written");
        }
        if (arm === "success") {
          state.enabled = enabled; audit.onSuccess?.();
          finishSyntheticSchedules(root, join(root, "locks"), manifestPath, "win32");
        }
        return { status: arm === "success" ? 0 : 1 };
      },
    });
  } catch (error) { failure = error; }
  return { root, runtimeRoot, manifestPath, raw, oldPackage, state, calls, result, failure, outcomePath, staging, scheduleOptions };
}

test("audit R1 major 1 proves daily pause under the lifecycle lease before npm and child", async () => {
  const green = await auditedPackageArm();
  assert.equal(green.failure, undefined);
  assert.equal(green.calls.filter(call => call === "npm").length, 1, "the replacement decision was reached");
  assert.ok(green.calls.indexOf("task-disable") < green.calls.indexOf("npm"));
  assert.ok(green.calls.includes("npm-task-paused"));
  assert.ok(green.calls.includes("child-task-paused"));
  const refused = await auditedPackageArm("pause-unproven");
  assert.ok(refused.calls.includes("task-disable"), "the pause readback decision was reached");
  assert.ok(refused.failure);
  assert.equal(refused.calls.includes("npm"), false);
  assert.equal(readFileSync(join(refused.runtimeRoot, "package.json"), "utf8"), refused.oldPackage);
});

for (const arm of ["npm-failed", "hash-mismatch", "replacement-rename-failed", "sign-in-incomplete", "queue-busy", "key-missing"]) {
  test(`audit R1 major 2 restores exact package and daily task after ${arm}`, async () => {
    const refused = await auditedPackageArm(arm);
    assert.ok(refused.calls.includes("npm"), "the installer decision was reached");
    if (!["npm-failed", "hash-mismatch", "replacement-rename-failed"].includes(arm)) {
      assert.ok(refused.calls.includes("child"), "the installed child preflight was reached");
    }
    assert.ok(refused.failure);
    assert.equal(readFileSync(join(refused.runtimeRoot, "package.json"), "utf8"), refused.oldPackage);
    assert.equal(readFileSync(join(refused.runtimeRoot, "brain.mjs"), "utf8"), "// old runtime\n");
    assert.equal(readFileSync(join(refused.runtimeRoot, "old-only.txt"), "utf8"), "old runtime companion\n");
    assert.equal(existsSync(join(refused.runtimeRoot, "empty.txt")), false, "candidate-only files are absent after rollback");
    assert.equal(refused.state.enabled, true, "only exact local rollback permits task restore");
    assert.equal(readFileSync(refused.manifestPath, "utf8"), refused.raw);
    const green = await auditedPackageArm();
    assert.equal(green.failure, undefined);
    assert.equal(JSON.parse(readFileSync(join(green.runtimeRoot, "package.json"))).version, "0.4.23");
  });
}

for (const arm of ["remote-started", "remote-started-enabled", "killed-child", "killed-child-windows", "unproven-success", "task-drift", "child-manifest-changed", "foreign-transaction"]) {
  test(`audit R1 major 2 preserves recovery and keeps the task paused after ${arm}`, async () => {
    const refused = await auditedPackageArm(arm);
    assert.ok(refused.calls.includes("child"), "the child outcome decision was reached");
    assert.ok(refused.failure);
    assert.equal(refused.state.enabled, false);
    assert.equal(refused.calls.includes("task-enable"), false);
    if (arm !== "task-drift") {
      assert.equal(JSON.parse(readFileSync(join(refused.runtimeRoot, "package.json"))).version, "0.4.23");
    }
    const green = await auditedPackageArm();
    assert.equal(green.failure, undefined);
    assert.equal(green.state.enabled, true);
  });
}

test("audit R1 rollback preserves an already-paused daily task", async () => {
  const refused = await auditedPackageArm("sign-in-incomplete", false);
  assert.ok(refused.calls.includes("child"));
  assert.ok(refused.failure);
  assert.equal(readFileSync(join(refused.runtimeRoot, "package.json"), "utf8"), refused.oldPackage);
  assert.equal(refused.state.enabled, false);
  assert.equal(refused.calls.includes("task-enable"), false);
  const green = await auditedPackageArm("success", false);
  assert.equal(green.failure, undefined);
  assert.equal(green.state.enabled, false);
});

test("audit R1 rollback rename failure retains the old runtime without enabling the task", async () => {
  const refused = await auditedPackageArm("rollback-rename-failed");
  assert.ok(refused.calls.includes("child"), "preflight failed after replacement");
  assert.ok(refused.calls.filter(call => call === "runtime-rename").length >= 4, "the rollback rename decision was reached");
  assert.equal(refused.failure?.code, "PRIVATE_OFFER_RECOVERY");
  assert.equal(refused.state.enabled, false);
  assert.equal(refused.calls.includes("task-enable"), false);
  assert.equal(readFileSync(join(refused.staging, "prior-runtime", "package.json"), "utf8"), refused.oldPackage);
  const green = await auditedPackageArm("sign-in-incomplete");
  assert.equal(green.failure?.code, "PRIVATE_OFFER_UPDATE");
  assert.equal(green.state.enabled, true);
  assert.equal(readFileSync(join(green.runtimeRoot, "package.json"), "utf8"), green.oldPackage);
});

for (const preflight of ["sign-in-incomplete", "queue-busy", "key-missing"]) {
  test(`audit R1 real update child proves pre-dispatch outcome after ${preflight}`, async () => {
    const run = await privateChildArm("unchanged", preflight);
    assert.equal(run.counts.npm, 1);
    assert.equal(run.counts.normal, 1, "the real cmdUpdate child was reached");
    assert.equal(run.failure?.code, "PRIVATE_OFFER_UPDATE");
    const outcome = JSON.parse(readFileSync(run.childEnvironment.BRAIN_PRIVATE_UPDATE_OUTCOME, "utf8"));
    assert.equal(outcome.remote, "not_started", "production dispatch tracking authorizes local rollback");
    assert.equal(JSON.parse(readFileSync(join(run.runtimeRoot, "package.json"))).version, "0.4.22");
    if (preflight === "queue-busy") {
      assert.equal(run.observed.backlog, 1);
      assert.equal(run.observed.adoption, 0);
      assert.equal(run.observed.supportCode, "UPDATE_WAITING_FOR_INDEXING");
    } else if (preflight === "key-missing") {
      assert.equal(run.observed.keyNames, 1, "the real missing-key decision was reached");
      assert.equal(run.observed.missingKey, true);
    } else assert.equal(run.observed.adoption, 1);
    const green = await auditedPackageArm();
    assert.equal(green.failure, undefined);
    assert.ok(green.calls.includes("child"));
  });
}

// R2: an executable must remain available even if a Windows restore is denied.
test("audit R2 restore failure keeps a runnable configured CLI and stable recovery entry", async () => {
  const failed = await auditedPackageArm("rollback-rename-failed");
  assert.ok(failed.calls.filter(call => call === "runtime-rename").length >= 4);
  assert.equal(failed.failure?.code, "PRIVATE_OFFER_RECOVERY");
  assert.ok(existsSync(join(failed.runtimeRoot, "brain.mjs")), "configured CLI survives denied restore");
  const entry = join(failed.staging, "recover.mjs");
  assert.ok(existsSync(entry), "recovery lives outside the swapped package");
  const recovered = spawnSync(process.execPath, [entry], { encoding: "utf8", env: privateFixtureEnvironment(failed.root) });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(readFileSync(join(failed.runtimeRoot, "package.json"), "utf8"), failed.oldPackage);
  const launch = spawnSync(process.execPath, [join(failed.runtimeRoot, "brain.mjs")], {
    env: privateFixtureEnvironment(failed.root), encoding: "utf8",
  });
  assert.equal(launch.status, 0, "the recovered executable starts in a fresh process");
  const control = await auditedPackageArm("sign-in-incomplete");
  assert.equal(control.failure?.code, "PRIVATE_OFFER_UPDATE");
  assert.equal(readFileSync(join(control.runtimeRoot, "package.json"), "utf8"), control.oldPackage);
});

async function extraTaskAudit({ enabled = true, failRestore = false, bridgeOnly = false, realChild = false } = {}) {
  const qb = await import("../operations/quickbooks-schedule.mjs");
  const sid = "S-1-5-21-100-200-300-1001", domain = "brain.example.invalid";
  const digest = (...fields) => createHash("sha256").update(fields.map(value => `${Buffer.byteLength(value)}:${value},`).join("")).digest("hex");
  const name = `\\Financial Brain\\daily-refresh-${digest("daily-refresh-v1", domain, sid).slice(0, 16)}`;
  let bridge, qbState, plan, options, context, fail = failRestore;
  const audit = {
    manifestFields: { brain: { ...manifest.brain, domain },
      operations: { quickbooks_schedule: { enabled: true, timezone: "UTC" } } },
    configure(ctx) {
      context = ctx;
      bridge = { task_name: name, principal: sid, enabled, definition: "synthetic immutable definition",
        action: `brain load '${ctx.manifestPath}' --only local_folder` };
      options = { platform: "win32", principal: `sid:${sid}`, localTimezone: "UTC", now: new Date(now),
        nodePath: String.raw`C:\Runtime\node.exe`, brainPath: String.raw`C:\Runtime\brain.mjs`,
        runnerPath: String.raw`C:\Runtime\quickbooks-schedule.mjs` };
      plan = qb.planQuickBooksSchedule({ m: ctx.m, manifestPath: ctx.manifestPath, ...options });
      const definition = qb.buildQuickBooksScheduleDefinition(plan, options);
      qbState = { exists: !bridgeOnly, owned: true, enabled, definition };
      const quickBooksSchedulerOptions = { ...options, adapter: {
        read() { return structuredClone(qbState); },
        setEnabled(_identity, value) { ctx.calls.push(`accounting:${value}`); qbState.enabled = value; },
        install(definition) {
          ctx.calls.push("accounting:restore");
          if (fail) throw new Error("synthetic restoration denied");
          qbState = { exists: true, owned: true, enabled, definition };
        },
      } };
      const recoveryOptions = { ...options, quickBooksSchedulerOptions, bridgeOptions: { now: () => new Date(now), adapter: {
        currentSid: () => sid,
        inventory: () => ({ entries: [structuredClone(bridge)], ignored: 0 }),
        read: () => structuredClone(bridge),
        setEnabled(_name, value) {
          ctx.calls.push(`bridge:${value}`);
          if (fail && value) throw new Error("synthetic bridge restore denied");
          bridge.enabled = value;
        },
      } } };
      ctx.recoveryOptions = { ...recoveryOptions, home: ctx.root };
      return recoveryOptions;
    },
    onChild({ options: childOptions, calls }) {
      if (!realChild) return;
      const paths = { daily: join(context.root, "daily.json"), accounting: join(context.root, "accounting.json"), bridge: join(context.root, "bridge.json") };
      for (const [key, value] of [["daily", context.state], ["accounting", qbState], ["bridge", bridge]]) writeFileSync(paths[key], JSON.stringify(value));
      const plan = { identity: context.state.definition.identity, manifest_path: context.manifestPath,
        manifest_path_hash: `sha256:${"1".repeat(64)}`, manifest_content_hash: `sha256:${"2".repeat(64)}`,
        source_plan_hash: `sha256:${"3".repeat(64)}`, ready: true, enabled: true, cron: "0 9 * * *",
        timezone: "UTC", max_runtime_minutes: 30, sources: [] };
      const source = `
        import { cmdUpdate } from ${JSON.stringify(new URL("../brain.mjs", import.meta.url).href)};
        import { readFileSync, writeFileSync } from "node:fs";
        const paths = ${JSON.stringify(paths)}, plan = ${JSON.stringify(plan)}, manifestPath = ${JSON.stringify(context.manifestPath)};
        const read = key => JSON.parse(readFileSync(paths[key], "utf8"));
        const write = (key, value) => writeFileSync(paths[key], JSON.stringify(value));
        const observed = { upgrade: 0, accountingPause: 0, bridgePause: 0, accountingRestore: 0, bridgeRestore: 0 };
        console.log = () => {};
        const adapter = key => ({ read: () => read(key), setEnabled: (_identity, enabled) => { const state = read(key); state.enabled = enabled; write(key, state); if (key === "accounting") observed.accountingPause++; }, install() { observed.accountingRestore++; throw new Error("unexpected early restore"); } });
        const bridgeAdapter = { currentSid: () => ${JSON.stringify(sid)}, inventory: () => ({ entries: [read("bridge")], ignored: 0 }), read: () => read("bridge"), setEnabled: (_name, enabled) => { const state = read("bridge"); state.enabled = enabled; write("bridge", state); observed[enabled ? "bridgeRestore" : "bridgePause"]++; } };
        try { await cmdUpdate(manifestPath, {
          lifecycleLockOptions: ${JSON.stringify(isolatedLifecycleOptions(context.root, { machineLockRoot: join(context.root, "locks"),
            lockRootOptions: { environment: { ...isolatedLifecycleOptions(context.root).lockRootOptions.environment,
              ProgramData: join(context.root, "program-data") } } }))},
          discoverInstalledManifest: path => ({ path }), answerSetupNeedsRecovery: () => false,
          readUpdateBacklog: async () => ({ pending: 0 }), withCloudflareControl: async action => action(),
          answerKeyOptions: { cf: async () => [{ name: "ANTHROPIC_API_KEY", type: "secret_text" }] },
          adoptCloudflareAuthProfile: async () => {}, cmdVerify: async () => {},
          cmdUpgrade: async () => { observed.upgrade++; throw new Error("synthetic upgrade preflight"); },
          dailyRefreshOptions: { platform: "win32", principal: ${JSON.stringify(options.principal)}, localTimezone: "UTC", now: new Date(${now}),
            existingSchedulerOwners: [], planDailyRefresh: async () => plan,
            schedulerAdapter: adapter("daily"), schedulerOptions: { home: ${JSON.stringify(context.root)}, machineLockRoot: ${JSON.stringify(join(context.root, "locks"))}, ...${JSON.stringify(options)} },
            bridgeOptions: { adapter: bridgeAdapter, now: () => new Date(${now}) },
            quickBooksSchedulerOptions: { ...${JSON.stringify(options)}, adapter: adapter("accounting") } },
        }); } catch (error) {
          process.exitCode = 1;
          observed.stopped = { code: error?.code ?? null, supportCode: error?.supportCode ?? null, message: String(error?.message || "").slice(0, 240) };
        }
        process.stdout.write(JSON.stringify(observed));`;
      // The adapters model a synthetic Windows owner, but on a native Windows
      // host this real child also applies real ACLs (lease handoff and lock
      // folders), and icacls can grant only an account that exists here. The
      // bound is for a hung child, not a speed budget: this child took 3.6-4.1 s
      // on a Mac against the former 5 s limit.
      const env = process.platform === "win32"
        ? { ...childOptions.env, USERNAME: process.env.USERNAME, USERDOMAIN: process.env.USERDOMAIN }
        : childOptions.env;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
        env, encoding: "utf8", shell: false, timeout: 60_000,
      });
      assert.equal(child.error, undefined, `real child launch: ${child.error?.code}`);
      assert.equal(child.status, 1, child.stderr);
      const observed = JSON.parse(child.stdout);
      assert.equal(observed.upgrade, 1, `real parent-to-child lease handoff reached upgrade preflight: ${JSON.stringify(observed.stopped)}`);
      assert.equal(observed.accountingRestore, 0, "child never restores before parent rollback");
      assert.equal(observed.bridgeRestore, 0);
      if (!bridgeOnly) assert.ok(observed.accountingPause > 0);
      calls.push("real-child-preflight");
      Object.assign(context.state, JSON.parse(readFileSync(paths.daily, "utf8")));
      qbState = JSON.parse(readFileSync(paths.accounting, "utf8"));
      bridge = JSON.parse(readFileSync(paths.bridge, "utf8"));
      return { status: 1 };
    },
    onRename({ calls }) {
      calls.push("all-task-boundary");
      assert.equal(bridge.enabled, false, "bridge paused before each forward and rollback rename");
      if (!bridgeOnly) assert.equal(qbState.enabled, false, "accounting task paused before each rename");
    },
  };
  const run = await auditedPackageArm("sign-in-incomplete", enabled, audit);
  return { ...run, bridge: () => bridge, accounting: () => qbState, context, audit,
    healthy: () => { fail = false; } };
}
for (const bridgeOnly of [false, true]) {
  test(`audit R2 all Windows tasks paused across forward and rollback bridgeOnly=${bridgeOnly}`, async () => {
    const failed = await extraTaskAudit({ bridgeOnly });
    assert.ok(failed.calls.includes("all-task-boundary"), "real rename boundary reached");
    assert.equal(failed.failure?.code, "PRIVATE_OFFER_UPDATE");
    assert.equal(failed.calls.filter(call => call === "all-task-boundary").length, 4);
    assert.equal(failed.bridge().enabled, true);
    if (!bridgeOnly) assert.equal(failed.accounting().enabled, true);
    const control = await extraTaskAudit({ enabled: false, bridgeOnly });
    assert.equal(control.failure?.code, "PRIVATE_OFFER_UPDATE");
    assert.equal(control.bridge().enabled, false);
    assert.equal(control.calls.includes("bridge:true"), false, "original disabled intent preserved");
  });
}
for (const bridgeOnly of [false, true]) {
  test(`audit R2 scheduler restore failure retains full intent and healthy retry bridgeOnly=${bridgeOnly}`, async () => {
    const failed = await extraTaskAudit({ bridgeOnly, failRestore: true, realChild: true });
    assert.ok(failed.calls.includes("real-child-preflight"), "real child dispatch decision reached");
    const { readDailyRefreshUpdateTransaction } = await import("../operations/daily-refresh-scheduler.mjs");
    const txOptions = { home: failed.root, manifestPath: failed.manifestPath, platform: "win32", machineLockRoot: join(failed.root, "locks") };
    const receipt = readDailyRefreshUpdateTransaction(failed.state.definition.identity, txOptions);
    assert.ok(receipt, "failed restoration cannot erase the transaction or fence");
    assert.ok(failed.calls.some(call => call === (bridgeOnly ? "bridge:true" : "accounting:restore")), "native restore decision reached");
    assert.equal(receipt.bridge_snapshots[0].prior_enabled, true);
    if (!bridgeOnly) assert.equal(receipt.legacy_snapshots[0].snapshot.wasLoaded, true);
    assert.equal(readFileSync(join(failed.runtimeRoot, "package.json"), "utf8"), failed.oldPackage);
    failed.healthy();
    const { recoverPrivateUpdateSchedule } = await import("../operations/private-update-recovery.mjs");
    await recoverPrivateUpdateSchedule(failed.context.m, failed.manifestPath, { HOME: failed.root }, {
      ...failed.scheduleOptions,
    }, { machineLockRoot: join(failed.root, "locks"), now: () => new Date(now) });
    assert.equal(failed.bridge().enabled, true);
    if (!bridgeOnly) assert.equal(failed.accounting().enabled, true);
    assert.equal(readDailyRefreshUpdateTransaction(failed.state.definition.identity, txOptions), null);
    const control = await extraTaskAudit({ bridgeOnly });
    assert.equal(control.failure?.code, "PRIVATE_OFFER_UPDATE");
  });
}

// A simulated Windows case presents the host's real self-kill in the exit
// shape Windows reports (code 1, no signal); a Windows host runs it natively.
const interruptionCases = [1, 2, 3, 4, 5, 0].map(interrupted => [interrupted, process.platform]);
if (process.platform !== "win32") interruptionCases.push([1, "win32"], [5, "win32"]);
for (const [interruptedRename, exitPlatform] of interruptionCases) {
  const simulatedWindows = exitPlatform !== process.platform;
  test(`audit R2 fresh recovery after rename interruption ${interruptedRename}${simulatedWindows ? " (simulated Windows exit)" : ""}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "private-swap-r2-"));
    const runtimeRoot = join(root, "node_modules", "brain-installer"), staging = join(root, "node_modules", ".swap");
    const candidate = join(staging, "candidate", "node_modules", "brain-installer");
    mkdirSync(runtimeRoot, { recursive: true }); mkdirSync(candidate, { recursive: true });
    for (const [path, version] of [[runtimeRoot, "old"], [candidate, "new"]]) {
      writeFileSync(join(path, "package.json"), JSON.stringify({ name: "brain-installer", version }));
      writeFileSync(join(path, "brain.mjs"), `console.log(${JSON.stringify(version)});\n`);
    }
    const manifestPath = join(root, "manifest.json"), raw = JSON.stringify(manifest);
    writeFileSync(manifestPath, raw);
    const binding = { target: privateOfferTarget(manifest), fingerprint: createHash("sha256").update(raw).digest("hex") };
    const code = `import { preparePrivateRuntimeSwap } from ${JSON.stringify(new URL("../operations/private-update-swap.mjs", import.meta.url).href)};
      import { renameSync, writeFileSync } from "node:fs";
      import { withBrainLifecycleLock } from ${JSON.stringify(new URL("../operations/brain-lifecycle-lock.mjs", import.meta.url).href)};
      ${ownTerminationSource(join(root, "terminated.json"))}
      await withBrainLifecycleLock(${JSON.stringify({ ...isolatedLifecycleOptions(root, { machineLockRoot: join(root, "locks") }), manifestPath, operation: "update" })}, () => {
      const swap = preparePrivateRuntimeSwap(${JSON.stringify({ staging, runtimeRoot, candidate, manifestPath, binding, lifecycleLockOptions: isolatedLifecycleOptions(root, { machineLockRoot: join(root, "locks") }) })});
      let calls = 0;
      const rename = (source, target) => { renameSync(source, target); writeFileSync(${JSON.stringify(join(root, "reached.json"))}, JSON.stringify(++calls)); if (calls === ${interruptedRename}) loseProcess(calls); };
      swap.forward(rename);
      if (${interruptedRename} === 5) {
        swap.phase("child_started");
        writeFileSync(${JSON.stringify(join(staging, "outcome.json"))}, JSON.stringify({ schema_version: 1, binding: ${JSON.stringify(binding)}, remote: "not_started" }));
        writeFileSync(${JSON.stringify(join(root, "reached.json"))}, "5");
        loseProcess(5);
      }
      swap.rollback(rename); });`;
    const env = privateFixtureEnvironment(root);
    const observedLoss = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });
    const lost = simulatedWindows ? windowsExitShape(observedLoss) : observedLoss;
    const recordPath = join(root, "terminated.json");
    const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null;
    if (interruptedRename) {
      assert.ok(lostByOwnTermination(lost, { platform: exitPlatform, record }),
        `the child ended by its own recorded termination: ${JSON.stringify({ status: lost.status, signal: lost.signal, record, stderr: lost.stderr })}`);
      assert.equal(record.reached, interruptedRename, "termination happened at the recorded rename boundary");
    } else {
      assert.equal(lost.status, 0, lost.stderr);
      assert.equal(lost.signal, null);
      assert.equal(record, null, "the control never terminates itself");
    }
    assert.equal(JSON.parse(readFileSync(join(root, "reached.json"))), interruptedRename || 4, "rename decision reached before process loss");
    const entry = join(staging, "recover.mjs");
    if ([1, 3].includes(interruptedRename)) assert.equal(existsSync(runtimeRoot), false, "crash occurs at the absent-path boundary");
    else assert.equal(JSON.parse(readFileSync(join(runtimeRoot, "package.json"))).version, [2, 5].includes(interruptedRename) ? "new" : "old");
    if (interruptedRename) {
      const immediate = spawnSync(process.execPath, [entry], { env, encoding: "utf8" });
      assert.equal(immediate.status, 1, "the saved entry cannot bypass a fresh dead-parent lease");
      const coordinates = brainLifecycleCoordinates({ manifestPath, machineLockRoot: join(root, "locks") });
      const ownerPath = join(coordinates.root, `brain-lifecycle-${coordinates.identity}.lock`, "owner.json");
      const afterStaleWindow = lstatSync(ownerPath).mtimeMs + 31 * 60 * 1000;
      const retrySource = `import { recoverPrivateRuntime } from ${JSON.stringify(pathToFileURL(join(staging, "recovery-code", "operations", "private-update-swap.mjs")).href)};
        await recoverPrivateRuntime(${JSON.stringify(join(staging, "swap.json"))}, { lifecycleLockOptions: { now: () => new Date(${afterStaleWindow}) } });`;
      const afterWindow = spawnSync(process.execPath, ["--input-type=module", "-e", retrySource], { env, encoding: "utf8" });
      assert.equal(afterWindow.status, 0, afterWindow.stderr);
    }
    const fresh = spawnSync(process.execPath, [entry], { env, encoding: "utf8" });
    assert.equal(fresh.status, 0, fresh.stderr);
    const launch = spawnSync(process.execPath, [join(runtimeRoot, "brain.mjs")], { env, encoding: "utf8" });
    assert.equal(launch.status, 0, launch.stderr);
    assert.equal(launch.stdout.trim(), interruptedRename === 5 ? "new" : "old", "executable-only recovery never downgrades a dispatched child");
    const retry = spawnSync(process.execPath, [entry], { env, encoding: "utf8" });
    assert.equal(retry.status, 0, "saved entry is idempotent after exact restoration");
  });
}


test("R4 Windows staging ACL is injected exactly once before npm", async () => {
  const restricted = [];
  const green = await auditedPackageArm("success", true, { onRestrict: path => restricted.push(path) });
  assert.equal(green.failure, undefined);
  assert.deepEqual(restricted, [green.staging]);
  assert.ok(green.calls.indexOf("restrict-directory") < green.calls.indexOf("npm"));
  const refused = await auditedPackageArm("success", true, { onRestrict: () => { throw new Error("fixture ACL denied"); } });
  assert.equal(refused.calls.filter(call => call === "restrict-directory").length, 1);
  assert.equal(refused.calls.includes("npm"), false); assert.equal(refused.failure?.code, "PRIVATE_OFFER_INSTALL");
});

test("R4 child retains declared update environment while npm and injected loaders stay isolated", async () => {
  const token = ["fixture", "control", "value"].join("-");
  const environment = { NODE_EXTRA_CA_CERTS: "C:\\certs\\fixture.pem", HTTPS_PROXY: "https://proxy.example.invalid",
    CLOUDFLARE_API_TOKEN: token, XDG_CONFIG_HOME: "fixture-config", ProgramFiles: "fixture-programs",
    PSModulePath: "fixture-modules", COMPUTERNAME: "FIXTURE", NODE_OPTIONS: "--require fixture.cjs",
    NODE_PATH: "fixture-loader", npm_config_registry: "https://registry.example.invalid", NPM_CONFIG_USERCONFIG: "fixture-npmrc",
    UNRELATED_PRIVATE_VALUE: "must-not-cross" };
  const spawns = [];
  const green = await auditedPackageArm("success", true, { environment, onSpawn: spawn => spawns.push(spawn) });
  assert.equal(green.failure, undefined); assert.equal(spawns.length, 2);
  const [npm, child] = spawns.map(spawn => spawn.options.env);
  for (const key of ["NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "CLOUDFLARE_API_TOKEN", "XDG_CONFIG_HOME", "ProgramFiles", "PSModulePath", "COMPUTERNAME"])
    assert.equal(child[key], environment[key], `declared ${key} survives the update handoff`);
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "npm_config_registry", "UNRELATED_PRIVATE_VALUE"])
    assert.equal(child[key], undefined);
  assert.equal(child.NPM_CONFIG_USERCONFIG, undefined);
  for (const key of ["NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "CLOUDFLARE_API_TOKEN", "NODE_OPTIONS"]) assert.equal(npm[key], undefined);
});

test("R4 transient Windows rollback lock retries and restores the original task", async () => {
  let attempts = 0;
  const result = await auditedPackageArm("sign-in-incomplete", true, { onRename: ({ source }) => {
    if (source.endsWith("prior-runtime") && ++attempts === 1) throw Object.assign(new Error("fixture sharing lock"), { code: "EPERM" });
  } });
  assert.equal(attempts, 2); assert.equal(result.failure?.code, "PRIVATE_OFFER_UPDATE");
  assert.ok(result.calls.includes("task-enable")); assert.equal(result.state.enabled, true);
  assert.equal(readFileSync(join(result.runtimeRoot, "package.json"), "utf8"), result.oldPackage);
  const green = await auditedPackageArm(); assert.equal(green.failure, undefined); assert.ok(green.calls.includes("child"));
});

test("R4 rename retries are bounded, Windows-only, and stop after ambiguous mutation", async () => {
  const { renameWithRetry } = await import("../operations/private-update-swap.mjs");
  for (const platform of ["win32", "darwin"]) {
    const root = mkdtempSync(join(tmpdir(), "offer-rename-")), from = join(root, "from"), to = join(root, "to");
    mkdirSync(from); let attempts = 0, sleeps = 0;
    assert.throws(() => renameWithRetry(() => { attempts++; throw Object.assign(new Error("fixture locked"), { code: "EPERM" }); },
      from, to, { platform, sleep: () => { sleeps++; } }), { code: "EPERM" });
    // A Windows host's own sharing locks are retried whatever platform is modelled.
    assert.equal(attempts, platform === "win32" || process.platform === "win32" ? 8 : 1); assert.equal(sleeps, attempts - 1);
    assert.equal(existsSync(from), true); assert.equal(existsSync(to), false);
    renameWithRetry(renameSync, from, to, { platform, sleep: () => {} }); assert.equal(existsSync(to), true);
  }
  const root = mkdtempSync(join(tmpdir(), "offer-rename-state-")), from = join(root, "from"), to = join(root, "to");
  mkdirSync(from); let attempts = 0;
  assert.throws(() => renameWithRetry((source, target) => { attempts++; renameSync(source, target);
    throw Object.assign(new Error("fixture unknown outcome"), { code: "EPERM" }); }, from, to,
    { platform: "win32", sleep: () => assert.fail("ambiguous rename must not retry") }), { code: "EPERM" });
  assert.equal(attempts, 1); assert.equal(existsSync(to), true);
});


test("R4 exhausted Windows rollback keeps backup and fence after exactly eight attempts", async () => {
  let attempts = 0;
  const refused = await auditedPackageArm("rollback-rename-failed", true, { onRename: ({ source }) => {
    if (source.endsWith("prior-runtime")) attempts++;
  } });
  assert.equal(attempts, 8); assert.equal(refused.failure?.code, "PRIVATE_OFFER_RECOVERY");
  assert.equal(refused.state.enabled, false); assert.equal(refused.calls.includes("task-enable"), false);
  assert.equal(existsSync(join(refused.staging, "prior-runtime")), true);
  const green = await auditedPackageArm(); assert.equal(green.failure, undefined); assert.ok(green.calls.includes("child"));
});

test("R4 Windows forward sharing locks and saved recovery retry without widening authority", async () => {
  const { recoverPrivateRuntime } = await import("../operations/private-update-swap.mjs");
  let forwards = 0;
  const green = await auditedPackageArm("success", true, { onRename: ({ source }) => {
    if (source.includes(join("candidate", "node_modules")) && ++forwards === 1)
      throw Object.assign(new Error("fixture forward sharing lock"), { code: "EBUSY" });
  } });
  assert.equal(green.failure, undefined); assert.equal(forwards, 2); assert.ok(green.calls.includes("child"));
  const failed = await auditedPackageArm("rollback-rename-failed");
  assert.equal(failed.failure?.code, "PRIVATE_OFFER_RECOVERY"); let restores = 0;
  await recoverPrivateRuntime(join(failed.staging, "swap.json"), { platform: "win32", renameOptions: { sleep: () => {} },
    lifecycleLockOptions: isolatedLifecycleOptions(failed.root, { machineLockRoot: join(failed.root, "locks") }),
    rename: (source, target) => {
      if (source.endsWith("prior-runtime") && ++restores === 1) throw Object.assign(new Error("fixture saved recovery lock"), { code: "EACCES" });
      renameSync(source, target);
    } });
  assert.equal(restores, 2); assert.equal(readFileSync(join(failed.runtimeRoot, "package.json"), "utf8"), failed.oldPackage);
  assert.equal(failed.state.enabled, false, "executable repair alone cannot enable the task");
});


test("R4 a destination created during rename backoff is never replaced", async () => {
  const { renameWithRetry } = await import("../operations/private-update-swap.mjs");
  const root = mkdtempSync(join(tmpdir(), "offer-rename-foreign-")), from = join(root, "from"), to = join(root, "to");
  mkdirSync(from); let attempts = 0, sleeps = 0;
  assert.throws(() => renameWithRetry(() => { attempts++; throw Object.assign(new Error("fixture denied"), { code: "EPERM" }); },
    from, to, { platform: "win32", sleep: () => { sleeps++; mkdirSync(to); } }), { code: "EPERM" });
  assert.equal(attempts, 1); assert.equal(sleeps, 1); assert.equal(existsSync(from), true); assert.equal(existsSync(to), true);
  const target = join(root, "green"); renameWithRetry(renameSync, from, target, { platform: "win32" }); assert.equal(existsSync(target), true);
});

test("R6 a Windows exit code 1 counts as our termination only with our own record", () => {
  const record = { pid: 4242, reached: 1 };
  const posix = { pid: 4242, status: null, signal: "SIGKILL" }, windows = { pid: 4242, status: 1, signal: null };
  assert.equal(lostByOwnTermination(posix, { platform: "darwin", record }), true);
  assert.equal(lostByOwnTermination(windows, { platform: "win32", record }), true);
  assert.equal(lostByOwnTermination(windows, { platform: "win32", record: null }), false, "code 1 alone is also an uncaught exception");
  assert.equal(lostByOwnTermination(windows, { platform: "win32", record: { ...record, pid: 4243 } }), false, "another process's record proves nothing");
  assert.equal(lostByOwnTermination({ ...windows, status: 3221225786 }, { platform: "win32", record }), false, "a console close is not our termination");
  assert.equal(lostByOwnTermination({ ...windows, status: 97 }, { platform: "win32", record }), false, "a kill that could not start is not a termination");
  assert.equal(lostByOwnTermination(windows, { platform: "darwin", record }), false, "exit code 1 on POSIX is an ordinary failure");
  assert.equal(lostByOwnTermination(posix, { platform: "win32", record }), false);
  assert.equal(lostByOwnTermination({ ...posix, error: new Error("fixture spawn failure") }, { platform: "darwin", record }), false);
  assert.deepEqual(windowsExitShape({ pid: 1, status: 0, signal: null }), { pid: 1, status: 0, signal: null }, "only a real self-kill is reshaped");
  if (process.platform !== "win32") assert.deepEqual(windowsExitShape(posix), windows);
});

// R6: Windows can briefly hold a receipt or state file that an update replaces.
test("R6 file replacement retry is bounded, Windows-only, support-coded and stops when the staged file vanishes", async () => {
  const { replaceFileWithRetrySync, FILE_REPLACE_DELAYS_MS, LOCAL_FILE_LOCKED } = await import("../operations/rename-retry.mjs");
  const root = mkdtempSync(join(tmpdir(), "receipt-replace-"));
  const from = join(root, "receipt.json.tmp"), to = join(root, "receipt.json");
  const reset = () => { writeFileSync(from, "new\n"); writeFileSync(to, "old\n"); };
  const locked = code => Object.assign(new Error("fixture sharing lock"), { code });
  reset();
  let attempts = 0, checks = 0;
  const sleeps = [];
  replaceFileWithRetrySync(from, to, { platform: "win32", sleep: ms => sleeps.push(ms), revalidate: () => { checks++; },
    rename: (source, target) => { if (++attempts <= 2) throw locked("EPERM"); renameSync(source, target); } });
  assert.equal(attempts, 3, "a transient lock is retried until the replacement succeeds");
  assert.equal(checks, 3, "the caller's proof is renewed before every attempt");
  assert.deepEqual(sleeps, [50, 100]);
  assert.equal(readFileSync(to, "utf8"), "new\n"); assert.equal(existsSync(from), false);
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    reset(); attempts = 0; sleeps.length = 0;
    assert.throws(() => replaceFileWithRetrySync(from, to, { platform: "win32", sleep: ms => sleeps.push(ms),
      rename: () => { attempts++; throw locked(code); } }), error => {
      assert.equal(error.supportCode, LOCAL_FILE_LOCKED); assert.equal(error.code, code);
      assert.equal(error.cause?.code, code); assert.equal(error.renameAttempts, 6);
      assert.match(error.message, /Windows kept a Brain file in use/);
      assert.equal(error.message.includes(root), false, "the owner message carries no path");
      return true;
    });
    assert.equal(attempts, FILE_REPLACE_DELAYS_MS.length + 1);
    assert.deepEqual(sleeps, [...FILE_REPLACE_DELAYS_MS]);
    assert.ok(FILE_REPLACE_DELAYS_MS.reduce((total, ms) => total + ms, 0) <= 2_000, "bounded to about two seconds");
    assert.equal(readFileSync(to, "utf8"), "old\n", "an exhausted replacement leaves the destination unchanged");
    assert.equal(existsSync(from), true);
  }
  reset(); attempts = 0;
  assert.throws(() => replaceFileWithRetrySync(from, to, { platform: "darwin", sleep: () => {},
    rename: () => { attempts++; throw locked("EPERM"); } }), { code: "EPERM" });
  assert.equal(attempts, process.platform === "win32" ? 6 : 1, "a POSIX host keeps its permanent permission error; a Windows host always retries");
  reset(); attempts = 0;
  assert.throws(() => replaceFileWithRetrySync(from, to, { platform: "win32", sleep: () => assert.fail("not a sharing lock"),
    rename: () => { attempts++; throw locked("ENOSPC"); } }), { code: "ENOSPC" });
  assert.equal(attempts, 1);
  reset(); attempts = 0;
  assert.throws(() => replaceFileWithRetrySync(from, to, { platform: "win32", sleep: () => assert.fail("an ambiguous replacement must not retry"),
    rename: (source, target) => { attempts++; renameSync(source, target); throw locked("EPERM"); } }),
  error => error.code === "EPERM" && error.supportCode === undefined);
  assert.equal(attempts, 1); assert.equal(readFileSync(to, "utf8"), "new\n");
  reset(); attempts = 0; checks = 0;
  assert.throws(() => replaceFileWithRetrySync(from, to, { platform: "win32", sleep: () => {},
    revalidate: () => { if (++checks === 2) throw new Error("fixture owner changed during backoff"); },
    rename: () => { attempts++; throw locked("EPERM"); } }), /fixture owner changed during backoff/);
  assert.equal(attempts, 1, "a failed proof stops before another attempt");
});

for (const target of ["daily receipt", "swap journal"]) {
  test(`R6 transient Windows locks on the ${target} leave the green private update green`, async t => {
    const locks = to => target === "daily receipt" ? isDailyUpdateReceipt(to) : isPrivateSwapJournal(to);
    const { calls, restore } = injectRenameFaults(t, (from, to, attempt) => locks(to) && attempt <= 2 ? "EPERM" : null);
    let green;
    try { green = await auditedPackageArm(); } finally { restore(); }
    assert.ok(calls.some(call => call.code && locks(call.to)), `the ${target} replacement decision was reached`);
    assert.equal(green.failure, undefined, `green control stopped with ${green.failure?.code}`);
    assert.ok(refusedThenReplaced(calls), "every refused replacement later succeeded from the same staged file");
    assert.ok(green.calls.includes("child"));
    assert.equal(JSON.parse(readFileSync(join(green.runtimeRoot, "package.json"))).version, "0.4.23");
    assert.equal(green.state.enabled, true);
  });
}

// The real `brain update --private-package` dispatcher, with only its final
// package step replaced by the exact error that step reported.
async function dispatchPrivatePackageFailure(failure) {
  const core = await import("../operations/private-update-offer.mjs");
  const root = mkdtempSync(join(tmpdir(), "offer-dispatch-r6-"));
  const manifestPath = join(root, "manifest.json"), packagePath = join(root, "candidate.tgz"), offerPath = join(root, "offer.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const packageBytes = archive();
  writeFileSync(packagePath, packageBytes);
  const unsigned = core.createPrivateOffer({ manifest, toVersion: "0.4.23", packageBytes,
    packageUrl: "https://packages.example.invalid/build.tgz", reason: "A focused update for this Brain." }, { now, nonce: "b".repeat(64) });
  const offer = { ...unsigned, signature: sign(null, Buffer.from(core.canonicalPrivateJson(unsigned)), pair.privateKey).toString("base64url") };
  writeFileSync(offerPath, JSON.stringify(offer));
  let installs = 0;
  try {
    await dispatchUpdateCli([manifestPath, "--private-package", packagePath, "--private-offer-file", offerPath], {
      privateOfferOptions: { now, publicKey: pair.publicKey, write: () => {},
        fetch: async () => new Response(JSON.stringify(offer), { status: 200 }),
        installPackage: async () => { installs++; throw failure; } },
    });
  } catch (error) { return { error, installs }; }
  return { error: undefined, installs };
}

const supportCodesIn = message => String(message).match(/Support code: [A-Z0-9_]+/gu) || [];

test("R6 an exhausted Windows receipt lock stops before npm with LOCAL_FILE_LOCKED, kept through the real dispatcher", async t => {
  const { calls, restore } = injectRenameFaults(t, (from, to) => isDailyUpdateReceipt(to) ? "EBUSY" : null);
  let refused;
  try { refused = await auditedPackageArm(); } finally { restore(); }
  assert.equal(calls.filter(call => call.code).length, 6, "the bounded retry decision was reached");
  assert.equal(refused.failure?.code, "PRIVATE_OFFER_INSTALL");
  assert.equal(refused.failure?.supportCode, "LOCAL_FILE_LOCKED");
  assert.deepEqual(supportCodesIn(refused.failure.message), ["Support code: LOCAL_FILE_LOCKED"], "one support code, naming the lock");
  assert.equal(refused.calls.includes("npm"), false);
  assert.equal(readFileSync(join(refused.runtimeRoot, "package.json"), "utf8"), refused.oldPackage);
  assert.equal(refused.state.enabled, true, "an unsaved receipt never pauses the task");
  assert.equal(readBrainRecoveryFence({ manifestPath: refused.manifestPath, platform: "win32", machineLockRoot: join(refused.root, "locks") }),
    null, "the clean state the message states is real");
  // The CLI wraps every private refusal; the journal, the assistant and the
  // suggested `brain support --explain` code all read this classification.
  const dispatched = await dispatchPrivatePackageFailure(refused.failure);
  assert.equal(dispatched.installs, 1, "the package step was reached through the real dispatcher");
  assert.equal(dispatched.error?.code, "PRIVATE_OFFER_INSTALL");
  assert.equal(dispatched.error.supportCode, "LOCAL_FILE_LOCKED");
  assert.equal(supportErrorCode(dispatched.error, { command: "update" }), "LOCAL_FILE_LOCKED");
  assert.deepEqual(supportCodesIn(dispatched.error.message), ["Support code: LOCAL_FILE_LOCKED"]);
  assert.equal(dispatched.error.message.split("\n").length, 1);
  const { PrivateOfferError } = await import("../operations/private-update-offer.mjs");
  const plain = await dispatchPrivatePackageFailure(new PrivateOfferError("PRIVATE_OFFER_RECOVERY"));
  assert.equal(plain.error?.supportCode, "UPGRADE_FAILED", "an ordinary private refusal stays an update failure");
  const foreign = new PrivateOfferError("PRIVATE_OFFER_INSTALL");
  foreign.supportCode = "NOT_A_SUPPORT_CODE";
  assert.equal((await dispatchPrivatePackageFailure(foreign)).error?.supportCode, "UPGRADE_FAILED", "an unknown code never passes through");
  const green = await auditedPackageArm();
  assert.equal(green.failure, undefined);
});

// R6 review: a lock that begins after preparation has already paused tasks
// leaves saved recovery behind. The owner must be told that, not that
// nothing changed, and the saved recovery must still finish once it clears.
test("R6 a receipt lock after the bridge pause intent reports saved recovery, never an unchanged state", async t => {
  const { recoverPrivateUpdateSchedule } = await import("../operations/private-update-recovery.mjs");
  const live = to => /daily-update-transactions[\\/]v1-[a-f0-9]+\.json$/u.test(to);
  let saved = 0;
  const { calls, restore } = injectRenameFaults(t, (from, to) => {
    if (!live(to)) return null;
    if (saved < 2) { saved++; return null; }
    return "EPERM";
  });
  let run;
  try { run = await extraTaskAudit({}); } finally { restore(); }
  const locks = { manifestPath: run.manifestPath, platform: "win32", machineLockRoot: join(run.root, "locks") };
  const lease = () => acquireBrainLifecycleLock({ ...locks, operation: "ingest", now: () => new Date(now), restrictWindowsDirectory() {} });
  assert.equal(saved, 2, "the preparing receipt and the bridge pause intent were saved");
  assert.ok(calls.filter(call => call.code).length >= 6, "an exhausted receipt lock after the pause intent was reached");
  assert.ok(run.calls.includes("bridge:false"), "the bridge pause decision was reached");
  assert.equal(run.calls.includes("npm"), false, "the update stopped before the package step");
  assert.equal(run.failure?.code, "PRIVATE_OFFER_RECOVERY");
  assert.equal(run.failure?.supportCode, undefined);
  assert.doesNotMatch(run.failure.message, /nothing changed|as they were before this run/u);
  assert.deepEqual(supportCodesIn(run.failure.message), ["Support code: PRIVATE_OFFER_RECOVERY"]);
  assert.equal(readFileSync(join(run.runtimeRoot, "package.json"), "utf8"), run.oldPackage);
  assert.ok(readBrainRecoveryFence(locks), "the recovery the message names is saved");
  assert.throws(() => lease().release(), { code: "brain_lifecycle_recovery_required" });
  // Once the lock clears, the saved recovery restores every task and lifts the fence.
  await recoverPrivateUpdateSchedule(run.context.m, run.manifestPath, { HOME: run.root }, { ...run.scheduleOptions },
    { machineLockRoot: join(run.root, "locks"), now: () => new Date(now) });
  assert.equal(run.bridge().enabled, true);
  assert.equal(run.accounting().enabled, true);
  assert.equal(readBrainRecoveryFence(locks), null);
  lease().release();
  // A fence an earlier run left is also saved recovery, not a package refusal.
  const earlier = await auditedPackageArm("success", true, { configure: ({ root, manifestPath }) => {
    writeBrainRecoveryFence({ manifestPath, transactionId: "e".repeat(32), platform: "win32", machineLockRoot: join(root, "locks") });
  } });
  assert.equal(earlier.failure?.code, "PRIVATE_OFFER_RECOVERY");
  assert.equal(earlier.calls.includes("npm"), false);
  assert.equal(readFileSync(join(earlier.runtimeRoot, "package.json"), "utf8"), earlier.oldPackage);
});

test("R6 a read-only Windows destination is named at once, never retried or reported as a held file", async () => {
  const { replaceFileWithRetrySync, LOCAL_FILE_LOCKED } = await import("../operations/rename-retry.mjs");
  const root = mkdtempSync(join(tmpdir(), "replace-readonly-"));
  const from = join(root, "manifest.json.tmp"), to = join(root, "manifest.json");
  writeFileSync(from, "new\n"); writeFileSync(to, "old\n"); chmodSync(to, 0o444);
  let attempts = 0;
  const sleeps = [];
  try {
    assert.throws(() => replaceFileWithRetrySync(from, to, { platform: "win32", sleep: ms => sleeps.push(ms),
      rename: () => { attempts++; throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); } }), error => {
      assert.equal(error.supportCode, LOCAL_FILE_LOCKED);
      assert.equal(error.readOnlyDestination, true);
      assert.equal(error.code, "EPERM");
      assert.match(error.message, /marked read-only/u);
      assert.doesNotMatch(error.message, /in use/u);
      assert.equal(error.message.includes(root), false, "the owner message carries no path");
      return true;
    });
    assert.equal(attempts, 1, "the read-only decision was reached on the first refusal");
    assert.deepEqual(sleeps, [], "a refusal that never clears is not waited for");
    assert.equal(readFileSync(to, "utf8"), "old\n");
    assert.equal(existsSync(from), true);
    if (process.platform === "win32") {
      // Native readback: whatever this Windows host does with a read-only
      // destination, it is never a 1.9 s wait reported as a held file.
      attempts = 0;
      try {
        replaceFileWithRetrySync(from, to, { sleep: () => assert.fail("a read-only refusal is not retried"),
          rename: (source, target) => { attempts++; return renameSync(source, target); } });
        assert.equal(readFileSync(to, "utf8"), "new\n");
      } catch (error) {
        assert.equal(error.readOnlyDestination, true, `native refusal: ${error.code}`);
        writeFileSync(from, "new\n");
      }
      assert.equal(attempts, 1);
    }
  } finally { chmodSync(to, 0o644); }
  if (!existsSync(from)) writeFileSync(from, "new\n");
  replaceFileWithRetrySync(from, to, { platform: "win32", sleep: () => assert.fail("a writable destination needs no wait") });
  assert.equal(readFileSync(to, "utf8"), "new\n");
});

test("R6 receipt removal retries a transient Windows hold on the same file only", async () => {
  const { removeFileWithRetrySync, FILE_REPLACE_DELAYS_MS, LOCAL_FILE_LOCKED } = await import("../operations/rename-retry.mjs");
  const root = mkdtempSync(join(tmpdir(), "receipt-remove-"));
  const path = join(root, "v1-receipt.json");
  const held = code => Object.assign(new Error("fixture sharing lock"), { code });
  let attempts = 0;
  const sleeps = [];
  writeFileSync(path, "done\n");
  removeFileWithRetrySync(path, { platform: "win32", sleep: ms => sleeps.push(ms),
    unlink: target => { if (++attempts <= 2) throw held("EBUSY"); unlinkSync(target); } });
  assert.equal(attempts, 3, "a transient hold is retried until the removal succeeds");
  assert.deepEqual(sleeps, [50, 100]);
  assert.equal(existsSync(path), false);
  writeFileSync(path, "done\n"); attempts = 0; sleeps.length = 0;
  assert.throws(() => removeFileWithRetrySync(path, { platform: "win32", sleep: ms => sleeps.push(ms),
    unlink: () => { attempts++; throw held("EPERM"); } }), error => {
    assert.equal(error.supportCode, LOCAL_FILE_LOCKED); assert.equal(error.cause?.code, "EPERM");
    assert.match(error.message, /6 removal attempts/u);
    assert.equal(error.message.includes(root), false);
    return true;
  });
  assert.equal(attempts, FILE_REPLACE_DELAYS_MS.length + 1);
  assert.deepEqual(sleeps, [...FILE_REPLACE_DELAYS_MS]);
  assert.equal(existsSync(path), true, "an exhausted removal leaves the file in place");
  attempts = 0;
  assert.throws(() => removeFileWithRetrySync(path, { platform: "darwin", sleep: () => {},
    unlink: () => { attempts++; throw held("EPERM"); } }), { code: "EPERM" });
  assert.equal(attempts, process.platform === "win32" ? 6 : 1, "a POSIX host keeps its permission error");
  attempts = 0;
  removeFileWithRetrySync(path, { platform: "win32", sleep: () => assert.fail("a removed file needs no wait"),
    unlink: target => { attempts++; unlinkSync(target); throw held("EPERM"); } });
  assert.equal(attempts, 1, "a file that is already gone is the intended result");
  assert.equal(existsSync(path), false);
  writeFileSync(path, "done\n"); attempts = 0;
  assert.throws(() => removeFileWithRetrySync(path, { platform: "win32", sleep: () => assert.fail("a replaced file is never retried"),
    unlink: target => {
      attempts++;
      writeFileSync(`${target}.next`, "successor\n"); renameSync(`${target}.next`, target);
      throw held("EPERM");
    } }), error => error.code === "EPERM" && error.supportCode === undefined);
  assert.equal(attempts, 1);
  assert.equal(readFileSync(path, "utf8"), "successor\n", "a successor under the same name is never removed");
  attempts = 0;
  assert.throws(() => removeFileWithRetrySync(path, { platform: "win32", sleep: () => assert.fail("not a sharing lock"),
    unlink: () => { attempts++; throw held("ENOSPC"); } }), { code: "ENOSPC" });
  assert.equal(attempts, 1);
});

test("R6 the Windows task-change lock retries a transient hold on its new folder, and a taken name stays busy", async t => {
  const { withWindowsTaskMutationLock } = await import("../operations/windows-task-contract.mjs");
  const home = mkdtempSync(join(tmpdir(), "task-lock-r6-"));
  const identity = { id: "fixture-daily-task" };
  const mutations = join(home, ".brain", "schedule-mutations");
  const lockPath = join(mutations, `${identity.id}.lock`);
  const publish = to => to.endsWith(`${sep}${identity.id}.lock`);
  let ran = 0;
  const change = platform => withWindowsTaskMutationLock(home, identity, () => ++ran, { platform });
  let faults = injectRenameFaults(t, (from, to, attempt) => publish(to) && attempt <= 2 ? "EPERM" : null);
  try { assert.equal(change("win32"), 1); } finally { faults.restore(); }
  assert.deepEqual(faults.calls.filter(call => publish(call.to)).map(call => call.code), ["EPERM", "EPERM", null]);
  assert.equal(existsSync(lockPath), false, "the lock is released after the change");
  faults = injectRenameFaults(t, (from, to) => publish(to) ? "EBUSY" : null);
  try {
    assert.throws(() => change("win32"), error => error.supportCode === "LOCAL_FILE_LOCKED" &&
      /6 publish attempts/u.test(error.message) && !/already being changed/u.test(error.message));
  } finally { faults.restore(); }
  assert.equal(faults.calls.filter(call => publish(call.to)).length, 6);
  assert.equal(ran, 1, "an unpublished lock never runs the change");
  assert.deepEqual(readdirSync(mutations), [], "no lock or staged lock folder remains");
  faults = injectRenameFaults(t, (from, to) => {
    if (!publish(to)) return null;
    mkdirSync(to);
    return "EPERM";
  });
  try { assert.throws(() => change("win32"), /already being changed/u); } finally { faults.restore(); }
  assert.equal(faults.calls.filter(call => publish(call.to)).length, 1, "a name another writer took is never waited for");
  assert.equal(ran, 1);
  rmSync(lockPath, { recursive: true, force: true });
  if (process.platform !== "win32") {
    faults = injectRenameFaults(t, (from, to) => publish(to) ? "EPERM" : null);
    try { assert.throws(() => change("darwin"), /already being changed/u); } finally { faults.restore(); }
    assert.equal(faults.calls.filter(call => publish(call.to)).length, 1, "a POSIX host keeps its first refusal");
  }
  assert.equal(change("win32"), 2, "the same change succeeds once nothing holds the folder");
});

test("R6 remembering the manifest location retries a transient Windows hold", async t => {
  const { rememberInstalledManifest, readInstalledManifest } = await import("../operations/installed-manifest.mjs");
  const root = mkdtempSync(join(tmpdir(), "pointer-r6-"));
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const options = { stateDirectory: join(root, "state"), platform: "win32" };
  rememberInstalledManifest(manifestPath, options);
  const pointer = to => basename(to) === "installed-manifest.json";
  const faults = injectRenameFaults(t, (from, to, attempt) => pointer(to) && attempt <= 2 ? "EPERM" : null);
  let saved;
  try { saved = rememberInstalledManifest(manifestPath, options); } finally { faults.restore(); }
  assert.deepEqual(faults.calls.filter(call => pointer(call.to)).map(call => call.code), ["EPERM", "EPERM", null]);
  assert.equal(saved.replaced, true);
  assert.equal(readInstalledManifest(options), saved.manifestPath);
  assert.equal(readdirSync(options.stateDirectory).some(name => name.endsWith(".tmp")), false, "no staged pointer remains");
});

test("R6 a transient Windows lock on the lease handoff retries under fresh parent proof", async t => {
  const root = mkdtempSync(join(tmpdir(), "private-handoff-r6-"));
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const options = { manifestPath, platform: "win32", ...isolatedLifecycleOptions(root, { machineLockRoot: join(root, "locks") }),
    now: () => new Date(now), restrictWindowsDirectory() {} };
  const parent = acquireBrainLifecycleLock({ ...options, operation: "update" });
  let handoffPath = join(parent.path, "owner.json");
  const handoff = (to, attempt) => to === handoffPath && attempt <= 2 ? "EPERM" : null;
  let child, proofs = 0;
  try {
    const { calls, restore } = injectRenameFaults(t, (from, to, attempt) => handoff(to, attempt));
    try {
      child = adoptParentBrainLifecycleLock({ ...options, delegation: parent.childDelegation(), parentPid: process.pid,
        isOwnerAlive: () => { proofs++; return true; } });
    } finally { restore(); }
    assert.deepEqual(calls.filter(call => call.to === handoffPath).map(call => call.code), ["EPERM", "EPERM", null]);
    const otherSlots = [...new Set([parent.accountPath, parent.legacyPath].filter(path => path && path !== parent.path))];
    assert.equal(otherSlots.length, 2, "the retry fixture retains distinct account and legacy transfers");
    for (const path of otherSlots) assert.deepEqual(calls.filter(call => call.to === join(path, "owner.json")).map(call => call.code), [null],
      "each other retained slot transfers without an injected fault");
    assert.equal(proofs, 4 + 2 * otherSlots.length,
      "the parent is proved before every selected-slot retry and every other slot transfer");
    assert.equal(parent.release(), false, "parent cleanup cannot release the child's fresh token");
    assert.equal(child.assertOwned(), true);
  } finally { child?.release(); parent.release(); }
  const later = acquireBrainLifecycleLock({ ...options, operation: "update" });
  handoffPath = join(later.path, "owner.json");
  let lostChild;
  try {
    proofs = 0;
    const { restore } = injectRenameFaults(t, (from, to, attempt) => handoff(to, attempt));
    try {
      assert.throws(() => { lostChild = adoptParentBrainLifecycleLock({ ...options, delegation: later.childDelegation(),
        parentPid: process.pid, isOwnerAlive: () => ++proofs < 3 }); }, { code: "brain_lifecycle_lost" });
    } finally { restore(); }
    assert.equal(proofs, 3, "a parent that ends during backoff stops the handoff");
    assert.equal(later.assertOwned(), true, "the refused handoff leaves the parent lease in place");
  } finally { lostChild?.release(); later.release(); }
});

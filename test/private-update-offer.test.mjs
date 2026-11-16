import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign, createHash, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, statSync, lstatSync, chmodSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const now = Date.parse("2026-11-02T12:00:00.000Z");
const manifest = {
  brain: { version: "0.4.22" },
  infrastructure: { cloudflare: {
    account_id: "a".repeat(32), storage: "d1",
    d1_database_id: "11111111-2222-4333-8444-555555555555",
  } },
};
const pair = generateKeyPairSync("ed25519");
const otherPair = generateKeyPairSync("ed25519");
const bytes = Buffer.from("synthetic package bytes");
const hash = (value) => createHash("sha256").update(value).digest("hex");

test("offer contract, decision refusals, and signature mutation", async (t) => {
  const core = await import("../operations/private-update-offer.mjs");
  const input = {
    manifest, toVersion: "0.4.23", packageBytes: bytes,
    packageUrl: "https://packages.example.invalid/build.tgz", reason: "A focused update for this Brain.",
  };
  const unsigned = core.createPrivateOffer(input, { now, nonce: "b".repeat(64) });
  const signed = (changes = {}, key = pair.privateKey) => {
    const value = { ...unsigned, ...changes };
    return { ...value, signature: sign(null, Buffer.from(core.canonicalPrivateJson(value)), key).toString("base64url") };
  };
  const verify = (offer, options = {}) => core.verifyPrivateOffer(offer, {
    manifest, now, publicKey: pair.publicKey, ...options,
  });
  assert.equal(unsigned.target, hash("fb-private-offer/1" + core.canonicalPrivateJson({
    account_id: manifest.infrastructure.cloudflare.account_id,
    d1_database_id: manifest.infrastructure.cloudflare.d1_database_id,
  })));
  assert.equal(Date.parse(unsigned.expires_at) - now, 14 * 86_400_000);
  assert.equal(verify(signed()).to_version, "0.4.23");
  assert.equal(verify(JSON.parse(JSON.stringify(signed()))).reason, input.reason);
  assert.equal(core.verifyPrivatePackage(bytes, signed()), bytes);

  const cases = [
    ["missing", null, "PRIVATE_OFFER_MISSING", "offer"],
    ["unsigned", unsigned, "PRIVATE_OFFER_UNSIGNED", "signature"],
    ["wrong key", signed({}, otherPair.privateKey), "PRIVATE_OFFER_SIGNATURE", "signature"],
    ["tampered reason", { ...signed(), reason: "Changed words." }, "PRIVATE_OFFER_SIGNATURE", "signature"],
    ["wrong Brain", signed({ target: "c".repeat(64) }), "PRIVATE_OFFER_TARGET", "target"],
    ["expired", signed({ issued_at: "2026-10-01T12:00:00.000Z", expires_at: "2026-10-15T12:00:00.000Z" }), "PRIVATE_OFFER_EXPIRED", "time"],
    ["future", signed({ issued_at: "2026-11-03T12:00:00.000Z" }), "PRIVATE_OFFER_EXPIRED", "time"],
    ["too long", signed({ expires_at: "2026-12-03T12:00:00.000Z" }), "PRIVATE_OFFER_EXPIRED", "time"],
    ["from version", signed({ from_version: "0.4.21" }), "PRIVATE_OFFER_VERSION", "from_version"],
    ["same version", signed({ to_version: "0.4.22" }), "PRIVATE_OFFER_VERSION", "to_version"],
    ["downgrade", signed({ to_version: "0.4.9" }), "PRIVATE_OFFER_VERSION", "to_version"],
    ["unknown field", signed({ extra: true }), "PRIVATE_OFFER_INVALID", "shape"],
    ["control words", signed({ reason: "Update\ncommand" }), "PRIVATE_OFFER_INVALID", "shape"],
    ["long reason", signed({ reason: "x".repeat(301) }), "PRIVATE_OFFER_INVALID", "shape"],
    ["unsafe count", signed({ package_bytes: 1.5 }), "PRIVATE_OFFER_INVALID", "shape"],
    ["bad URL", signed({ package_url: "http://packages.example.invalid/build.tgz" }), "PRIVATE_OFFER_INVALID", "shape"],
  ];
  for (const [label, offer, code, decision] of cases) await t.test(label, () => {
    const reached = [];
    assert.throws(() => verify(offer, { onCheck: (stage) => reached.push(stage) }), (error) => {
      assert.equal(error.code, code);
      assert.ok(error.message.includes(code));
      assert.equal(error.message.split("\n").length, 1);
      return true;
    });
    assert.ok(reached.includes(decision), `missing decision: ${decision}`);
    assert.equal(verify(signed()).to_version, "0.4.23", "green peer reaches eligibility");
  });
  for (const [label, candidate] of [["byte count", Buffer.concat([bytes, Buffer.from("x")])],
    ["digest", Buffer.alloc(bytes.length, 42)]]) await t.test(label, () => {
    const reached = [];
    assert.throws(() => core.verifyPrivatePackage(candidate, signed(), {
      onCheck: (stage) => reached.push(stage),
    }), { code: "PRIVATE_OFFER_PACKAGE" });
    assert.ok(reached.includes(label === "digest" ? "package_sha256" : "package_bytes"));
    assert.equal(core.verifyPrivatePackage(bytes, signed()), bytes);
  });
  assert.throws(() => verify(signed(), { publicKey: null }), { code: "PRIVATE_OFFER_KEY" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 512 });
  assert.throws(() => verify(signed({}, rsa.privateKey), { publicKey: rsa.publicKey }), {
    code: "PRIVATE_OFFER_SIGNATURE",
  }, "the pinned key must use ed25519");
  const incomplete = structuredClone(manifest);
  delete incomplete.infrastructure.cloudflare.account_id;
  assert.throws(() => core.privateOfferTarget(incomplete), { code: "PRIVATE_OFFER_IDENTITY" });
  assert.notEqual(core.privateOfferTarget(manifest), core.privateOfferTarget({
    ...manifest, infrastructure: { cloudflare: {
      ...manifest.infrastructure.cloudflare, account_id: "A".repeat(32),
    } },
  }), "identity is byte exact on both sides");

  // The same invalid-signature probe must fail when the real verifier is mutated.
  const source = readFileSync(new URL("../operations/private-update-offer.mjs", import.meta.url), "utf8");
  const marker = "verifySignature(null, payload, publicKey, signature)";
  assert.ok(source.includes(marker));
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(marker, "true")).toString("base64")}`);
  assert.throws(() => verify(signed({}, otherPair.privateKey)), { code: "PRIVATE_OFFER_SIGNATURE" });
  assert.equal(mutant.verifyPrivateOffer(signed({}, otherPair.privateKey), {
    manifest, now, publicKey: pair.publicKey,
  }).to_version, "0.4.23", "skipping the signature makes the refusal probe fail");
  const signatureProbe = (verifier) => assert.throws(() => verifier(signed({}, otherPair.privateKey), {
    manifest, now, publicKey: pair.publicKey,
  }), { code: "PRIVATE_OFFER_SIGNATURE" });
  signatureProbe(core.verifyPrivateOffer);
  assert.throws(() => signatureProbe(mutant.verifyPrivateOffer), { code: "ERR_ASSERTION" },
    "the exact negative probe kills the signature mutant");
});

test("unsigned authoring has no legacy key transport and round trips through the only signer", async () => {
  assert.equal(existsSync(new URL("../tools/sign-private-offer.mjs", import.meta.url)), false,
    "the legacy key-file and key-generation entry must be retired");
  const { runCreateUnsignedPrivateOffer } = await import("../scripts/create-unsigned-private-offer.mjs");
  const { runPrivateOfferStdinSigner } = await import("../scripts/sign-private-offer.mjs");
  const core = await import("../operations/private-update-offer.mjs");
  const root = mkdtempSync(join(tmpdir(), "offer-author-"));
  const manifestPath = join(root, "manifest.json"), packagePath = join(root, "candidate.tgz");
  writeFileSync(manifestPath, JSON.stringify(manifest)); writeFileSync(packagePath, bytes);
  const args = ["--manifest", manifestPath, "--package", packagePath, "--package-url",
    "https://packages.example.invalid/build.tgz", "--to-version", "0.4.23", "--reason", "A focused update."];
  let sequence = 0;
  const green = () => {
    const output = join(root, `unsigned-${sequence++}.json`), signed = output + ".signed";
    const reached = [];
    runCreateUnsignedPrivateOffer([...args, "--out", output], { now, onCheck: stage => reached.push(stage) });
    const offer = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(Object.hasOwn(offer, "signature"), false);
    assert.ok(reached.includes("write"));
    runPrivateOfferStdinSigner([output, signed], { publicKey: pair.publicKey,
      readStdin: () => Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")) });
    assert.equal(core.verifyPrivateOffer(JSON.parse(readFileSync(signed, "utf8")), {
      manifest, now, publicKey: pair.publicKey }).to_version, "0.4.23");
    return output;
  };
  const occupied = green(), before = readFileSync(occupied);
  for (const flags of [["--key-file", "unused"], ["--key-stdin"], ["--generate-key", "unused"], ["--unknown", "unused"]]) {
    const output = join(root, `refused-${sequence++}.json`), reached = [];
    assert.throws(() => runCreateUnsignedPrivateOffer([...args, "--out", output, ...flags], {
      now, onCheck: stage => reached.push(stage) }), { code: "PRIVATE_OFFER_SIGN" });
    assert.ok(reached.includes("arguments"));
    assert.equal(existsSync(output), false); green();
  }
  const reached = [];
  assert.throws(() => runCreateUnsignedPrivateOffer([...args, "--out", occupied], {
    now, onCheck: stage => reached.push(stage) }), { code: "PRIVATE_OFFER_SIGN" });
  assert.ok(reached.includes("write")); assert.deepEqual(readFileSync(occupied), before); green();
  assert.doesNotMatch(readFileSync(new URL("../scripts/create-unsigned-private-offer.mjs", import.meta.url), "utf8"),
    /createPrivateKey|generateKeyPair|\bsign\(/u);
});

test("audit R1 major 3 release gate rejects missing trust and precedes release writes", async () => {
  const core = await import("../operations/private-update-offer.mjs");
  let decisions = 0;
  assert.throws(() => core.assertPrivateOfferReleaseKey(null, { onCheck: () => { decisions++; } }), { code: "PRIVATE_OFFER_KEY" });
  assert.equal(decisions, 1, "the missing trust decision was reached");
  const publicPem = pair.publicKey.export({ format: "pem", type: "spki" });
  assert.equal(core.assertPrivateOfferReleaseKey(publicPem, { onCheck: () => { decisions++; } }).asymmetricKeyType, "ed25519");
  assert.equal(decisions, 2, "the reviewed algorithm control passes the same gate");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 512 });
  assert.throws(() => core.assertPrivateOfferReleaseKey(rsa.publicKey), { code: "PRIVATE_OFFER_KEY" });
  assert.throws(() => core.assertPrivateOfferReleaseKey(pair.privateKey), { code: "PRIVATE_OFFER_KEY" });
  if (core.PRIVATE_OFFER_PUBLIC_KEY === null) assert.throws(() => core.assertPrivateOfferReleaseKey(), { code: "PRIVATE_OFFER_KEY" });
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const check = workflow.indexOf("node scripts/check-private-offer-release-key.mjs");
  assert.ok(check > 0 && check < workflow.indexOf("gh release create"), "release cannot create a draft with missing trust");
});

const approvedUnsignedUrl = new URL("./fixtures/private-offer/approved-unsigned.json", import.meta.url);
const approvedSignedUrl = new URL("./fixtures/private-offer/approved-signed.json", import.meta.url);
const approvedNow = Date.parse("2026-11-12T12:00:00.000Z");
const approvedManifest = { ...manifest, brain: { version: "77.0.1" } };

test("approved default trust anchor has the reviewed SPKI digest and rejects another signer", async () => {
  const core = await import("../operations/private-update-offer.mjs");
  assert.equal(hash(createPublicKey(core.PRIVATE_OFFER_PUBLIC_KEY).export({ type: "spki", format: "der" })),
    "2ad6025adc75a8181cef7bcdd29cccf3722d0995f2dc11de8be74c3cbf4d537d");
  const unsigned = JSON.parse(readFileSync(approvedUnsignedUrl, "utf8"));
  const offer = { ...unsigned, signature: sign(null, Buffer.from(core.canonicalPrivateJson(unsigned)),
    otherPair.privateKey).toString("base64url") };
  const reached = [];
  assert.throws(() => core.verifyPrivateOffer(offer, { manifest: approvedManifest, now: approvedNow,
    onCheck: stage => reached.push(stage) }), { code: "PRIVATE_OFFER_SIGNATURE" });
  assert.ok(reached.includes("shape"), "default verification reached the signature decision");
  assert.equal(core.verifyPrivateOffer(offer, { manifest: approvedManifest, now: approvedNow,
    publicKey: otherPair.publicKey }).to_version, "77.0.2", "the same offer passes its actual signer control");
});

test("approved signed fixture passes default trust and rejects tampering and expiry", async () => {
  const core = await import("../operations/private-update-offer.mjs");
  const unsigned = JSON.parse(readFileSync(approvedUnsignedUrl, "utf8"));
  const offer = JSON.parse(readFileSync(approvedSignedUrl, "utf8"));
  const { signature, ...payload } = offer;
  assert.deepEqual(payload, unsigned, "the approved fixture must bind the exact reviewed unsigned bytes");
  assert.equal(typeof signature, "string");
  const green = () => core.verifyPrivateOffer(offer, { manifest: approvedManifest, now: approvedNow });
  assert.equal(green().to_version, "77.0.2");
  for (const [candidate, at, code, stage] of [
    [{ ...offer, package_sha256: "c".repeat(64) }, approvedNow, "PRIVATE_OFFER_SIGNATURE", "shape"],
    [offer, Date.parse(offer.expires_at), "PRIVATE_OFFER_EXPIRED", "time"],
  ]) {
    const reached = [];
    assert.throws(() => core.verifyPrivateOffer(candidate, { manifest: approvedManifest, now: at,
      onCheck: decision => reached.push(decision) }), { code });
    assert.ok(reached.includes(stage), `approved-key rejection reached ${stage}`);
    assert.equal(green().to_version, "77.0.2", "unchanged in-date approved control remains eligible");
  }
});

test("stdin-only signer binds the trust anchor and refuses alternate key transports", async t => {
  const { runPrivateOfferStdinSigner } = await import("../scripts/sign-private-offer.mjs");
  const core = await import("../operations/private-update-offer.mjs");
  const root = mkdtempSync(join(tmpdir(), "offer-stdin-"));
  const inputPath = fileURLToPath(approvedUnsignedUrl);
  const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
  const encoded = Buffer.from(privateDer.toString("base64") + "\n");
  let next = 0;
  const green = () => {
    const output = join(root, `green-${next++}.json`);
    const reached = [];
    const result = runPrivateOfferStdinSigner([inputPath, output], {
      publicKey: pair.publicKey, readStdin: () => Buffer.from(encoded), onCheck: stage => reached.push(stage),
    });
    assert.equal(result.to_version, "77.0.2");
    assert.ok(reached.includes("public_key"));
    assert.ok(reached.includes("write"));
    const offer = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(core.verifyPrivateOffer(offer, { manifest: approvedManifest, now: approvedNow,
      publicKey: pair.publicKey }).to_version, "77.0.2");
    if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.ok(!readFileSync(output, "utf8").includes(privateDer.toString("base64")));
    return output;
  };
  const occupied = green();
  const before = readFileSync(occupied);
  const badInput = join(root, "invalid.json");
  writeFileSync(badInput, JSON.stringify({ schema: "invalid" }));
  const missingKey = Buffer.alloc(0);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 512 });
  const rsaInput = Buffer.from(rsa.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
  const cases = [
    ["default anchor mismatch", [inputPath, join(root, "wrong-key.json")], encoded, {}, "public_key"],
    ["extra key argument", [inputPath, join(root, "argv.json"), "--key-stdin"], encoded, {}, "arguments"],
    ["key file option", ["--key-file", inputPath], encoded, {}, "arguments"],
    ["environment key option", ["--key-env", "SIGNING_KEY"], encoded, {}, "arguments"],
    ["empty stdin", [inputPath, join(root, "empty.json")], missingKey, {}, "stdin"],
    ["invalid base64", [inputPath, join(root, "base64.json")], Buffer.from("not base64!"), {}, "stdin"],
    ["oversized stdin", [inputPath, join(root, "large.json")], Buffer.alloc(4097, 65), {}, "stdin"],
    ["PEM transport", [inputPath, join(root, "pem.json")], Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })), {}, "stdin"],
    ["non Ed25519", [inputPath, join(root, "rsa.json")], rsaInput, {}, "private_key"],
    ["invalid offer", [badInput, join(root, "invalid-offer.json")], encoded, { publicKey: pair.publicKey }, "offer"],
    ["occupied output", [inputPath, occupied], encoded, { publicKey: pair.publicKey }, "write"],
  ];
  for (const [label, args, input, options, stage] of cases) await t.test(label, () => {
    const reached = [];
    assert.throws(() => runPrivateOfferStdinSigner(args, { ...options, readStdin: () => Buffer.from(input),
      onCheck: decision => reached.push(decision) }), { code: "PRIVATE_OFFER_SIGN" });
    assert.ok(reached.includes(stage), `the signer reached ${stage}`);
    if (args[0] === inputPath && args[1] !== occupied) assert.equal(existsSync(args[1]), false);
    assert.deepEqual(readFileSync(occupied), before, "an existing output is preserved");
    green();
  });
});

test("stdin signer CLI reads only a pipe, stays quiet, and has no environment fallback", async () => {
  const scriptUrl = new URL("../scripts/sign-private-offer.mjs", import.meta.url);
  const script = fileURLToPath(scriptUrl);
  const root = mkdtempSync(join(tmpdir(), "offer-stdin-cli-"));
  const encoded = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const output = join(root, "signed.json");
  const args = [fileURLToPath(approvedUnsignedUrl), output];
  const env = { HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root, BRAIN_NO_WRANGLER_LOGIN: "1" };
  const piped = spawnSync(process.execPath, [script, ...args], { input: encoded, encoding: "utf8", env });
  assert.equal(piped.status, 1);
  assert.equal(piped.stdout, "");
  assert.match(piped.stderr, /Support code: PRIVATE_OFFER_SIGN/);
  assert.ok(!piped.stderr.includes(encoded));
  assert.equal(existsSync(output), false);
  // A generated key is supplied only to the synthetic child, never to its argv or a file.
  const fromEnv = spawnSync(process.execPath, [script, ...args], { input: "", encoding: "utf8",
    env: { ...env, PRIVATE_OFFER_SIGNING_KEY: encoded } });
  assert.equal(fromEnv.status, 1);
  assert.equal(fromEnv.stderr, piped.stderr);
  const source = readFileSync(script, "utf8");
  assert.doesNotMatch(source, /process\.env|readPrivateKeyFile|key-file/);
  assert.match(source, /isFIFO\(\)/, "the real stdin reader checks the pipe decision");
  assert.equal(existsSync(output), false);
  // This control uses the real pipe reader and argv parser with an explicit
  // disposable public trust dependency. Production exposes no trust override.
  const control = `import { runPrivateOfferStdinSigner } from ${JSON.stringify(scriptUrl.href)};
    runPrivateOfferStdinSigner(process.argv.slice(1), {
      publicKey: process.env.FIXTURE_PUBLIC_KEY,
    });`;
  const green = spawnSync(process.execPath, ["--input-type=module", "--eval", control, ...args], {
    input: encoded, encoding: "utf8", env: { ...env,
      FIXTURE_PUBLIC_KEY: pair.publicKey.export({ type: "spki", format: "pem" }) },
  });
  assert.equal(green.status, 0, "real piped stdin control signs with its explicit disposable trust anchor");
  assert.equal(green.stdout + green.stderr, "", "a successful signer prints no key or offer contents");
  const core = await import("../operations/private-update-offer.mjs");
  assert.equal(core.verifyPrivateOffer(JSON.parse(readFileSync(output, "utf8")), {
    manifest: approvedManifest, now: approvedNow, publicKey: pair.publicKey,
  }).to_version, "77.0.2");
});

test("official offer origin refuses a redirect before use with a same-origin green control", async () => {
  const core = await import("../operations/private-update-offer.mjs");
  const { runPrivateUpdate } = await import("../operations/private-update-command.mjs");
  const unsigned = JSON.parse(readFileSync(approvedUnsignedUrl, "utf8"));
  const offer = { ...unsigned, signature: sign(null, Buffer.from(core.canonicalPrivateJson(unsigned)),
    pair.privateKey).toString("base64url") };
  const calls = [];
  const wrongOrigin = "https://offers.example.invalid/owner.json";
  const redirectAttempts = [];
  let redirect = true;
  let output = 0;
  const dependencies = {
    now: approvedNow, publicKey: pair.publicKey,
    discoverInstalledManifest: () => ({ path: "synthetic-manifest.json" }),
    pinManifest: () => ({ manifest: approvedManifest }), revalidateManifest: () => {},
    write: () => { output++; },
    fetch: async (url, options) => {
      calls.push({ url, options });
      // Model fetch's redirect:error boundary without contacting either origin.
      if (redirect) {
        redirectAttempts.push(wrongOrigin);
        if (options.redirect === "error") throw new TypeError("fixture redirect refused");
      }
      return new Response(JSON.stringify(offer), { status: 200 });
    },
  };
  const parsed = { check: true };
  await assert.rejects(runPrivateUpdate(parsed, dependencies), { code: "PRIVATE_OFFER_UNAVAILABLE" });
  assert.equal(calls.length, 1, "official fetch decision was reached");
  assert.equal(calls[0].url, `${core.PRIVATE_OFFER_ORIGIN}${offer.target}.json`);
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(redirectAttempts, [wrongOrigin], "a wrong-origin redirect was encountered");
  assert.equal(output, 0);
  redirect = false;
  assert.equal((await runPrivateUpdate(parsed, dependencies)).to_version, "77.0.2");
  assert.equal(calls.length, 2);
  assert.equal(output, 1, "same-origin signed control reaches offer display");
});


test("simulated win32 stdin reaches the signer pipe decision", async t => {
  const { Socket } = await import("node:net");
  const { readPrivateOfferPipedKey, runPrivateOfferStdinSigner } = await import("../scripts/sign-private-offer.mjs");
  const core = await import("../operations/private-update-offer.mjs");
  assert.equal(typeof readPrivateOfferPipedKey, "function", "the reader export is an instrumentation prerequisite");
  const root = mkdtempSync(join(tmpdir(), "offer-win32-pipe-"));
  const stream = new Socket();
  const encoded = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
  t.after(() => { stream.destroy(); encoded.fill(0); });
  const untyped = { isFIFO: () => false, isSocket: () => false, isFile: () => false, isDirectory: () => false };
  let next = 0;
  const run = (platform, info, { terminal = false, input = stream } = {}) => {
    const calls = { stat: 0, pipe: 0, fifo: 0, socket: 0, stdin: 0, reads: 0 };
    const stages = [];
    const output = join(root, `signed-${next++}.json`);
    let code = null;
    try {
      runPrivateOfferStdinSigner([fileURLToPath(approvedUnsignedUrl), output], {
        publicKey: pair.publicKey, onCheck: stage => stages.push(stage),
        readStdin: () => readPrivateOfferPipedKey({
          platform, stat: () => { calls.stat++; return { ...info,
            isFIFO: () => { calls.fifo++; return info.isFIFO(); },
            isSocket: () => { calls.socket++; return info.isSocket(); },
          }; },
          stdin: () => { calls.stdin++; return input; }, isTerminal: () => terminal,
          onCheck: stage => { assert.equal(stage, "pipe"); calls.pipe++; },
          read: (fd, buffer, offset, length, position) => {
            calls.reads++;
            assert.equal(fd, 0); assert.equal(position, null);
            assert.ok(length >= encoded.length);
            return calls.reads === 1 ? encoded.copy(buffer, offset) : 0;
          },
        }),
      });
    } catch (error) { code = error.code || error.name; }
    return { calls, stages, output, code };
  };
  const reachedPipe = arm => {
    assert.equal(arm.calls.stat, 1, "the real reader reached descriptor inspection");
    assert.equal(arm.calls.pipe, 1, "the real reader reached the pipe decision exactly once");
    assert.deepEqual(arm.stages.slice(0, 2), ["arguments", "stdin"]);
  };
  const green = (platform, info, fallback = false) => {
    const arm = run(platform, info);
    reachedPipe(arm);
    // A pre-fix red must show the descriptor predicates were called. Missing
    // exports, an earlier signer refusal, or a stubbed reader cannot satisfy it.
    assert.deepEqual({ code: arm.code, ...arm.calls }, {
      code: null, stat: 1, pipe: 1, fifo: 1, socket: info.isFIFO() ? 0 : 1,
      stdin: fallback ? 1 : 0, reads: 2,
    });
    assert.deepEqual(arm.stages, ["arguments", "stdin", "private_key", "public_key", "offer", "write"]);
    assert.equal(core.verifyPrivateOffer(JSON.parse(readFileSync(arm.output, "utf8")), {
      manifest: approvedManifest, now: approvedNow, publicKey: pair.publicKey,
    }).to_version, "77.0.2", "the pipe reader feeds a verifiable signed offer");
  };
  const fifo = { ...untyped, isFIFO: () => true };
  await t.test("POSIX FIFO control signs through the real reader", () => green("darwin", fifo));
  await t.test("POSIX socket control signs through the real reader", () =>
    green("darwin", { ...untyped, isSocket: () => true }));
  for (const [label, platform, info, options, lookups] of [
    ["POSIX untyped descriptor", "darwin", untyped, {}, 0],
    ["Windows redirected file", "win32", { ...untyped, isFile: () => true }, {}, 0],
    ["Windows directory", "win32", { ...untyped, isDirectory: () => true }, {}, 0],
    ["Windows terminal", "win32", untyped, { terminal: true }, 0],
    ["Windows non-Socket stream", "win32", untyped, { input: { readable: true } }, 1],
  ]) await t.test(`${label} refuses before reads with a signing green peer`, () => {
    const arm = run(platform, info, options);
    reachedPipe(arm);
    assert.equal(arm.code, "PRIVATE_OFFER_SIGN");
    assert.equal(arm.calls.stdin, lookups);
    assert.equal(arm.calls.reads, 0);
    assert.deepEqual(arm.stages, ["arguments", "stdin"]);
    assert.equal(existsSync(arm.output), false);
    green("darwin", fifo);
  });
  await t.test("Windows untyped readable Socket reaches fallback, reads and signs", () =>
    green("win32", untyped, true));
});

test("Windows pipe classification preserves POSIX stdin restrictions", async () => {
  const { Socket } = await import("node:net");
  const { readPrivateOfferPipedKey } = await import("../scripts/sign-private-offer.mjs");
  const stream = new Socket();
  const pipeStat = { isFIFO: () => false, isSocket: () => false, isFile: () => false, isDirectory: () => false };
  const run = (platform, info, terminal = false) => {
    let reads = 0, checks = 0;
    const invoke = () => readPrivateOfferPipedKey({ platform, stat: () => info, stdin: () => stream,
      isTerminal: () => terminal, onCheck: () => { checks++; },
      read: (_fd, buffer) => { reads++; if (reads > 1) return 0; buffer[0] = 65; return 1; } });
    return { invoke, reads: () => reads, checks: () => checks };
  };
  for (const [platform, info, terminal] of [["darwin", pipeStat, false],
    ["win32", { ...pipeStat, isFile: () => true }, false], ["win32", pipeStat, true]]) {
    const refused = run(platform, info, terminal);
    assert.throws(refused.invoke, { code: "PRIVATE_OFFER_SIGN" });
    assert.equal(refused.checks(), 1); assert.equal(refused.reads(), 0);
    const green = run("win32", pipeStat); assert.equal(green.invoke().toString(), "A"); assert.equal(green.reads(), 2);
  }
  const posix = run("darwin", { ...pipeStat, isFIFO: () => true });
  assert.equal(posix.invoke().toString(), "A"); stream.destroy();
});

test("release trust gate requires the approved signed fixture through its real CLI", async () => {
  const { copyFileSync, mkdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "offer-release-gate-"));
  for (const directory of ["scripts", "operations", "test/fixtures/private-offer"]) mkdirSync(join(root, directory), { recursive: true });
  for (const path of ["scripts/check-private-offer-release-key.mjs", "operations/private-update-offer.mjs"])
    copyFileSync(new URL("../" + path, import.meta.url), join(root, path));
  const fixture = join(root, "test/fixtures/private-offer/approved-signed.json");
  const env = { HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root, BRAIN_NO_WRANGLER_LOGIN: "1" };
  const run = () => spawnSync(process.execPath, [join(root, "scripts/check-private-offer-release-key.mjs")], { env, encoding: "utf8" });
  const green = () => { copyFileSync(approvedSignedUrl, fixture); const result = run(); assert.equal(result.status, 0, result.stderr); };
  const missing = run(); assert.equal(missing.status, 1, "missing signed proof must hold the real release entry");
  assert.match(missing.stderr, /approved private offer signature fixture is missing or does not verify/); green();
  const offer = JSON.parse(readFileSync(fixture, "utf8")); offer.reason += " Changed.";
  writeFileSync(fixture, JSON.stringify(offer));
  const changed = run(); assert.equal(changed.status, 1); assert.equal(changed.stderr, missing.stderr); green();
});

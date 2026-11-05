import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, statSync, chmodSync, symlinkSync, existsSync } from "node:fs";
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

test("signer file/stdin round trip and private output boundaries", async t => {
  const core = await import("../operations/private-update-offer.mjs");
  const { runPrivateOfferSigner } = await import("../tools/sign-private-offer.mjs");
  const root = mkdtempSync(join(tmpdir(), "offer-signer-"));
  const paths = { manifest: join(root, "manifest.json"), package: join(root, "build.tgz"), offer: join(root, "offer.json") };
  writeFileSync(paths.manifest, JSON.stringify(manifest));
  writeFileSync(paths.package, bytes);
  const publicOutput = [];
  runPrivateOfferSigner(["--generate-key", join(root, "keys")], { write: (line) => publicOutput.push(line) });
  const keyPath = join(root, "keys", "private.pem");
  const privatePem = readFileSync(keyPath, "utf8");
  if (process.platform !== "win32") assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  else t.diagnostic("Windows: POSIX generated-key mode assertion skipped.");
  const publicPem = readFileSync(join(root, "keys", "public.pem"), "utf8");
  assert.equal(publicOutput.join(""), publicPem);
  const args = ["--manifest", paths.manifest, "--package", paths.package,
    "--package-url", "https://packages.example.invalid/build.tgz", "--to-version", "0.4.23",
    "--reason", "A focused update.", "--out", paths.offer];
  const output = [];
  runPrivateOfferSigner([...args, "--key-file", keyPath], { now, write: (line) => output.push(line) });
  const offer = JSON.parse(readFileSync(paths.offer, "utf8"));
  assert.equal(core.verifyPrivateOffer(offer, { manifest, now, publicKey: publicPem }).to_version, "0.4.23");
  const stdout = [];
  runPrivateOfferSigner([...args.slice(0, -1), join(root, "stdin-offer.json"), "--key-stdin"], {
    now, readStdin: () => privatePem, write: (line) => stdout.push(line),
  });
  assert.equal(core.verifyPrivateOffer(JSON.parse(readFileSync(join(root, "stdin-offer.json"), "utf8")), {
    manifest, now, publicKey: publicPem,
  }).to_version, "0.4.23");
  const cli = new URL("../tools/sign-private-offer.mjs", import.meta.url);
  const child = spawnSync(process.execPath, [fileURLToPath(cli), ...args.slice(0, -1), join(root, "child-offer.json"), "--key-stdin"], {
    input: privatePem, encoding: "utf8", env: {
      PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      TMPDIR: process.env.TMPDIR, BRAIN_NO_WRANGLER_LOGIN: "1",
    },
  });
  assert.equal(child.status, 0, child.stderr);
  const failed = spawnSync(process.execPath, [fileURLToPath(cli), ...args, "--key-stdin"], {
    input: privatePem, encoding: "utf8", env: { HOME: root, USERPROFILE: root, TMPDIR: root, BRAIN_NO_WRANGLER_LOGIN: "1" },
  });
  assert.notEqual(failed.status, 0, "occupied offer output refuses");
  const visible = output.join("") + stdout.join("") + child.stdout + child.stderr + failed.stdout + failed.stderr + JSON.stringify(offer);
  assert.ok(!visible.includes(privatePem));
  assert.ok(!visible.includes(privatePem.split("\n")[1]));
  assert.match(visible, new RegExp(offer.target));
});

// Ported from the independent review, with explicit link and owner controls.
test("review RPL-02 refuses unsafe signing key files and accepts mode 0600", async t => {
  const { runPrivateOfferSigner } = await import("../tools/sign-private-offer.mjs");
  const root = mkdtempSync(join(tmpdir(), "offer-key-review-"));
  const keyDirectory = join(root, "keys");
  runPrivateOfferSigner(["--generate-key", keyDirectory], { write: () => {} });
  const keyFile = join(keyDirectory, "private.pem");
  const manifestPath = join(root, "manifest.json"), packagePath = join(root, "candidate.tgz");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(packagePath, bytes);
  for (const arm of ["0644", "symlink", "directory", "other-owner", "0600", "windows-mode"]) {
    await t.test(arm, { skip: process.platform === "win32" && arm !== "0600" && arm !== "windows-mode"
      ? "POSIX mode, ownership and link fixtures require a POSIX host" : false }, () => {
      chmodSync(keyFile, arm === "0644" || arm === "windows-mode" ? 0o644 : 0o600);
      const outputPath = join(root, `${arm}-offer.json`);
      let inputPath = keyFile;
      if (arm === "symlink") {
        inputPath = join(root, "linked.pem");
        symlinkSync(keyFile, inputPath);
      }
      if (arm === "directory") inputPath = keyDirectory;
      let decisions = 0, writes = 0;
      const notes = [];
      const args = ["--manifest", manifestPath, "--package", packagePath, "--package-url",
        "https://packages.example.invalid/build.tgz", "--to-version", "0.4.23", "--reason", "A focused update.",
        "--key-file", inputPath, "--out", outputPath];
      const options = { now, write: () => { writes++; },
        keyFileOptions: { onCheck: () => { decisions++; }, note: line => notes.push(line),
          ...(arm === "other-owner" ? { currentUid: () => statSync(keyFile).uid + 1 } : {}),
          ...(arm === "windows-mode" ? { platform: "win32" } : {}) } };
      try {
        if (arm === "0600" || arm === "windows-mode") {
          assert.match(runPrivateOfferSigner(args, options), /^[a-f0-9]{64}$/u);
          assert.equal(writes, 1);
          assert.ok(existsSync(outputPath));
          if (arm === "windows-mode") assert.match(notes.join("\n"), /Windows.*mode.*skip/i);
        } else {
          assert.throws(() => runPrivateOfferSigner(args, options), { code: "PRIVATE_OFFER_SIGN" },
            "unsafe key file must not produce a signed offer");
          assert.equal(writes, 0);
          assert.equal(existsSync(outputPath), false);
        }
        assert.equal(decisions, 1, "the real key-file validation decision was reached");
      } finally { chmodSync(keyFile, 0o600); }
    });
  }
});

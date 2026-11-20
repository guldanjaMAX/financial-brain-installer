// Settled D1-D4: add-only retention, mailbox-local time, counted skips, and work accounts only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { cmdConnectProvider } from "../brain.mjs";
import { exchangeProviderAuthorizationCode } from "../connectors/provider-oauth.mjs";
import { SUPPORT_ERROR_CODES } from "../support-journal.mjs";
import { supportRecovery } from "../support-recovery.mjs";
globalThis.fetch = async () => { throw new Error("UNSCRIPTED_NETWORK_BLOCKED"); };
const CODE = "MICROSOFT_ACCOUNT_NOT_SUPPORTED";
for (const domain of ["outlook.com", "hotmail.com", "live.com", "msn.com"]) {
  for (const location of ["flags", "manifest"]) {
    test(`A17: ${domain} in ${location} stops before browser and stored-credential lookup`, async t => {
      const home = mkdtempSync(join(homedir(), "account-")); t.after(() => rmSync(home, { recursive: true, force: true }));
      const path = join(home, "brain.manifest.json");
      const account = `owner@${domain}`;
      writeFileSync(path, JSON.stringify({ corpora: { microsoft: { enabled: true, ...(location === "manifest" ? { account } : {}) } } }));
      let locks = 0; let lookups = 0; let browsers = 0;
      await assert.rejects(cmdConnectProvider("microsoft", path, location === "flags" ? { account } : {}, {
        quiet: true, environment: {}, withSourceIngestLock: async (_options, run) => { locks++; return run({ assertOwned() {} }); },
        oauth: { providerOAuthConfig: () => ({ label: "Microsoft 365" }), PROVIDER_DEFAULT_PORT: 47812,
          providerRedirectUri: () => "http://127.0.0.1:47812", loadProviderCredentials: () => { lookups++; return null; },
          authorizeProvider: () => { browsers++; assert.fail("consumer preflight must stop authorization"); } },
      }), error => error.supportCode === CODE && /Outlook.com personal accounts are not supported yet/.test(error.message) && error.message.includes(`/help/${CODE}`));
      assert.equal(locks, 1, "the real connect dispatch reached its owner lease");
      assert.equal(lookups, 0); assert.equal(browsers, 0);
    });
  }
}

test("A17: work-account green control reaches authorization", async t => {
  const home = mkdtempSync(join(homedir(), "account-control-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "brain.manifest.json");
  writeFileSync(path, JSON.stringify({ corpora: { microsoft: { enabled: true, account: "owner@business.invalid" } } }));
  let browsers = 0;
  const marker = new Error("SYNTHETIC_AUTHORIZATION_REACHED");
  await assert.rejects(cmdConnectProvider("microsoft", path, {}, { quiet: true, environment: {}, credentials: { clientId: "synthetic-client" },
    withSourceIngestLock: async (_options, run) => run({ assertOwned() {} }), oauth: {
      providerOAuthConfig: () => ({ label: "Microsoft 365" }), PROVIDER_DEFAULT_PORT: 47812,
      providerRedirectUri: () => "http://127.0.0.1:47812", loadProviderCredentials: () => null,
      authorizeProvider: () => { browsers++; throw marker; },
    } }), error => error === marker);
  assert.equal(browsers, 1);
});

test("A17: consumer tenant returned after sign-in is rejected before access can be used", async () => {
  let calls = 0;
  const tid = "9188040d-6c67-4c5b-b112-36a304b66dad";
  const idToken = ["synthetic-header", Buffer.from(JSON.stringify({ tid })).toString("base64url"), "synthetic-signature"].join(".");
  await assert.rejects(exchangeProviderAuthorizationCode("microsoft", { clientId: "synthetic-client", code: "synthetic-code", verifier: "synthetic-verifier",
    now: Date.parse("2026-11-17T12:00:00Z"), fetchImpl: async () => { calls++; return Response.json({
      access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, id_token: idToken }); } }),
    error => error.supportCode === CODE);
  assert.equal(calls, 1, "the returned tenant decision point was reached");
  assert.ok(SUPPORT_ERROR_CODES.includes(CODE)); assert.equal(supportRecovery(CODE).code, CODE);
});

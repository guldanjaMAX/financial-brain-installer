import { test } from "node:test";
import assert from "node:assert/strict";
import { persistWorkersDevDomain } from "../brain.mjs";

/**
 * A field install lost most of an evening to this message.
 *
 * persistWorkersDevDomain read the account subdomain with `.catch(() => null)`.
 * That call authenticates with an API token while the deploy around it can be
 * running on a browser session, so on the path the runbook recommends the read
 * threw "no Cloudflare credential is available" and the catch discarded it. The
 * code then reported the only other explanation it had: that Cloudflare returned
 * no usable subdomain. The subdomain was set the whole time. The owner went to
 * the dashboard and correctly changed nothing, then pasted a raw API token at a
 * prompt to get past it, which is the exact thing the swallowed message warns
 * against.
 *
 * Three causes, three messages. A credential failure must survive.
 */
const ACCT = { id: "acct-fixture" };
const MANIFEST = "/tmp/does-not-exist/brain.manifest.json";

test("a credential failure is re-raised, not relabelled as a missing subdomain", async () => {
  class Fatal extends Error {}
  const credentialError = new Fatal(
    "no Cloudflare credential is available.\n      Easiest: sign in through the browser",
  );
  await assert.rejects(
    () => persistWorkersDevDomain(MANIFEST, {}, ACCT, "brain", {
      readSubdomain: async () => { throw credentialError; },
    }),
    (error) => {
      assert.match(String(error.message), /no Cloudflare credential is available/);
      assert.doesNotMatch(
        String(error.message),
        /did not return a usable account subdomain/,
        "a credential failure was relabelled as a missing subdomain",
      );
      return true;
    },
  );
});

test("a read that fails for another reason says the read failed, not that the subdomain is unset", async () => {
  await assert.rejects(
    () => persistWorkersDevDomain(MANIFEST, {}, ACCT, "brain", {
      readSubdomain: async () => { throw new Error("HTTP 403 Forbidden"); },
    }),
    (error) => {
      assert.match(String(error.message), /reading the account subdomain failed/);
      assert.match(String(error.message), /403/, "the real cause must reach the operator");
      assert.match(String(error.message), /failure to ASK, not a missing subdomain/);
      return true;
    },
  );
});

test("a successful read with no usable name still says the subdomain is unset", async () => {
  await assert.rejects(
    () => persistWorkersDevDomain(MANIFEST, {}, ACCT, "brain", {
      readSubdomain: async () => ({ subdomain: "" }),
    }),
    (error) => {
      assert.match(String(error.message), /did not return a usable account subdomain/);
      assert.match(String(error.message), /read succeeded/);
      return true;
    },
  );
});

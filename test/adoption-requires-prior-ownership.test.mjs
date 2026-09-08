import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAdoptable } from "../brain.mjs";

/**
 * Two installs into one account must never resolve to the same brain.
 *
 * Observed end to end on 2026-09-08 against the shipped package: two
 * independent manifests, each in its own directory, sharing nothing but the
 * provider account, both resolved to one brain. The second reported adopting it
 * and reusing its durable admin key, and from that second manifest the first
 * install's corpus was listable.
 *
 * assertAdoptable existed for exactly this and compared the recorded client
 * slug against the incoming one. Both runs took the same silent default, so the
 * two matched and the guard passed. A slug is a label either party can hold by
 * accident; the database id the manifest records at provision time is not.
 */
const ACCT = "acct-fixture";
const DB = { uuid: "db-uuid-fixture" };

const brainDb = (owner) => async (_acct, _uuid, sql) =>
  /sqlite_master/.test(sql)
    ? { results: [{ name: "install_state" }, { name: "chunks" }, { name: "documents" }] }
    : { results: [{ client_slug: owner }] };

test("a second install with the same default slug is refused, not adopted", async () => {
  await assert.rejects(
    () => assertAdoptable(ACCT, DB, "shared-name", "my-brain", brainDb("my-brain"), null),
    (error) => {
      assert.match(String(error.message), /this manifest has never owned it/);
      assert.match(String(error.message), /two installs\s+that accept the same default would match each other/);
      return true;
    },
    "a matching default slug must not be treated as proof of ownership",
  );
});

test("the manifest that provisioned it may still re-run", async () => {
  await assert.doesNotReject(
    () => assertAdoptable(ACCT, DB, "shared-name", "my-brain", brainDb("my-brain"), DB.uuid),
    "a genuine re-run carries the database id and must still adopt",
  );
});

test("a recorded id for a different database does not authorise adoption", async () => {
  await assert.rejects(
    () => assertAdoptable(ACCT, DB, "shared-name", "my-brain", brainDb("my-brain"), "some-other-uuid"),
    /this manifest has never owned it/,
  );
});

test("a different owner is still refused by name, as before", async () => {
  await assert.rejects(
    () => assertAdoptable(ACCT, DB, "shared-name", "mine", brainDb("theirs"), DB.uuid),
    /is already the brain for "theirs"/,
  );
});

test("an empty database is still a safe provision re-run", async () => {
  const empty = async () => ({ results: [] });
  await assert.doesNotReject(() => assertAdoptable(ACCT, DB, "fresh", "anything", empty, null));
});

test("a database that is not a brain is still refused", async () => {
  const notABrain = async (_a, _u, sql) =>
    /sqlite_master/.test(sql) ? { results: [{ name: "orders" }, { name: "customers" }] } : { results: [] };
  await assert.rejects(
    () => assertAdoptable(ACCT, DB, "theirs", "mine", notABrain, null),
    /is NOT a brain/,
  );
});

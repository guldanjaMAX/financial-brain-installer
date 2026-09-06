/**
 * An upgrade pause must hold against the MCP connector, not only the HTTP door.
 *
 * The pause exists so the corpus is frozen while it is being rebuilt. The
 * router enforces that with a path set, but /mcp returns before that guard and
 * reaches the corpus through callbacks, so an authorized connector could write
 * and stage deletions straight through a pause that /health was simultaneously
 * telling the owner was in force. A pause a writer can walk through is not a
 * pause.
 *
 * Reads stay available on purpose: a paused brain should still answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import worker from "../src/index.js";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";

const ORIGIN = "https://brain.invalid";
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

const rpc = (body, token) => new Request(`${ORIGIN}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

/** A real connector token for a named profile. */
function seedConnectorToken(fixture, token, scope) {
  fixture.raw(
    `INSERT INTO oauth_tokens
       (token_hash, client_id, scope, session_generation, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?, 'fixture-connector', ?, 1, ?, ?, NULL, NULL)`,
    sha256Hex(token), scope, Date.now(), Date.now() + 3_600_000,
  );
}

const call = async (fixture, token, name, args) => {
  const response = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, token),
    fixture.env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  return { status: response.status, body: await response.json() };
};

test("an upgrade pause holds against the MCP connector, not just the HTTP door", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  seedOwnedEntity(fixture, "mesa-coffee", "Mesa Coffee");
  // Two profiles, because the two mutating tools are gated differently:
  // remember needs curated:write, delete_preview needs break-glass.
  const token = "fixture-connector-token-aaaaaaaaaaaaaaaaaaaa";
  const breakGlass = "fixture-breakglass-token-bbbbbbbbbbbbbbbbbbbb";
  seedConnectorToken(fixture, token, "structured-contributor");
  seedConnectorToken(fixture, breakGlass, "break-glass");

  // The same profile can write while the brain is active. Without this the
  // paused assertions below would pass even if the tool were simply missing.
  fixture.env.VECTOR_DRAIN_MODE = "active";
  const activeWrite = await call(fixture, token, "remember", {
    title: "Active write",
    body: "Written while the brain was active, long enough to satisfy the tool's own minimum body length.",
    confidence: "inferred",
  });
  assert.equal(activeWrite.status, 200);
  const activeText = JSON.stringify(activeWrite.body);
  assert.doesNotMatch(activeText, /paused/i, `the active write must not be refused: ${activeText.slice(0, 300)}`);

  fixture.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";

  const pausedWrite = await call(fixture, token, "remember", {
    title: "Paused write",
    body: "This must never reach the corpus, and it is long enough that only the pause can refuse it.",
    confidence: "inferred",
  });
  assert.match(JSON.stringify(pausedWrite.body), /paused/i,
    "an authorized connector wrote through an upgrade pause");

  const pausedDelete = await call(fixture, breakGlass, "delete_preview", {
    entity_slug: "mesa-coffee", ids: ["drive:anything"],
  });
  assert.match(JSON.stringify(pausedDelete.body), /paused/i,
    "an authorized connector staged a deletion through an upgrade pause");

  // A paused brain still answers questions; the pause is about writes.
  const read = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 8, method: "tools/list" }, token),
    fixture.env, { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(read.status, 200, "reads must survive an upgrade pause");

  // And the HTTP door still refuses, so neither door regressed.
  const httpIngest = await worker.fetch(new Request(`${ORIGIN}/api/admin/brain/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": fixture.env.ADMIN_KEY || "" },
    body: JSON.stringify({ docs: [] }),
  }), fixture.env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(httpIngest.status, 503, "the HTTP ingest door must still refuse while paused");
});

/**
 * Remote connector end-to-end: discovery -> dynamic registration -> passkey-
 * session-gated approval -> PKCE token exchange -> MCP initialize/tools ->
 * revocation via the owner's sign-out-everywhere generation. Driven through
 * the worker's real fetch handler with real PKCE crypto; only D1 is faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import worker from "../src/index.js";
import { mintSessionCookie } from "../src/lib/sessions.js";
import { OWNER_NOTES_KIND, OWNER_NOTES_SOURCE } from "../src/lib/owner-note-contract.js";

const ORIGIN = "https://brain.example.com";

function connectorDb() {
  const tables = {
    clients: new Map(), codes: new Map(), tokens: new Map(),
    documents: new Map(), chunks: [], passkeys: new Map(),
    state: { session_generation: 1 },
  };
  return {
    tables,
    prepare(sql) {
      let bound = [];
      const statement = {
        bind(...args) { bound = args; return statement; },
        async first() {
          // The public request guard now covers the connector ceremony routes,
          // and its quota statement lands here. A stub that answers null reads
          // as "denied", so an unmodelled table would refuse the first call.
          if (/INSERT INTO public_request_quotas/.test(sql)) return { request_count: 1 };
          if (/FROM oauth_clients/.test(sql)) return tables.clients.get(bound[0]) || null;
          if (/FROM oauth_codes/.test(sql)) return tables.codes.get(bound[0]) || null;
          if (/FROM oauth_tokens/.test(sql)) return tables.tokens.get(bound[0]) || null;
          if (/FROM documents WHERE doc_uid/.test(sql)) return tables.documents.get(bound[0]) || null;
          if (/session_generation FROM install_state/.test(sql)) return { session_generation: tables.state.session_generation };
          return null;
        },
        async all() {
          if (/FROM chunks WHERE doc_uid/.test(sql)) {
            return { results: tables.chunks.filter((c) => c.doc_uid === bound[0]) };
          }
          // A session now names the passkey device behind it, so resolving one
          // reads the device list. Without this branch every owner cookie
          // resolves to nobody and the approval step silently 401s.
          if (/FROM owner_passkeys ORDER BY/.test(sql)) {
            return { results: [...tables.passkeys.values()] };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO oauth_clients/.test(sql)) {
            tables.clients.set(bound[0], { client_id: bound[0], client_name: bound[1], redirect_uris: bound[2] });
          } else if (/INSERT INTO oauth_codes/.test(sql)) {
            tables.codes.set(bound[0], {
              client_id: bound[1], redirect_uri: bound[2], code_challenge: bound[3],
              scope: bound[4], expires_at: bound[5], used_at: null,
            });
          } else if (/DELETE FROM oauth_codes/.test(sql)) tables.codes.delete(bound[0]);
          else if (/INSERT INTO oauth_tokens/.test(sql)) {
            tables.tokens.set(bound[0], {
              token_hash: bound[0], client_id: bound[1], scope: bound[2],
              session_generation: bound[3], created_at: bound[4], expires_at: bound[5], revoked_at: null,
            });
          } else if (/UPDATE oauth_tokens SET last_used_at/.test(sql)) {
            const row = tables.tokens.get(bound[1]);
            if (row) row.last_used_at = bound[0];
          }
          return {};
        },
      };
      return statement;
    },
    async batch() {},
  };
}

function env(db) {
  return {
    STORAGE: "d1", DB: db, ADMIN_KEY: "admin-key-fixture-value-000",
    SESSION_SIGNING_KEY: "b".repeat(64), BRAIN_NAME: "fixture", BRAIN_VERSION: "0.1.19",
  };
}

const jsonPost = (path, payload, headers = {}) => new Request(ORIGIN + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(payload || {}),
});

const b64u = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("the full connector journey, register through revocation", async () => {
  const db = connectorDb();
  const testEnv = env(db);

  // Discovery documents exist without any credential.
  const metadata = await (await worker.fetch(new Request(ORIGIN + "/.well-known/oauth-authorization-server"), testEnv)).json();
  assert.equal(metadata.token_endpoint, ORIGIN + "/oauth/token");
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(metadata.scopes_supported.includes("owner-assistant"), false,
    "the local owner assistant must never be grantable as a remote bearer-token scope");
  const resource = await (await worker.fetch(new Request(ORIGIN + "/.well-known/oauth-protected-resource"), testEnv)).json();
  assert.equal(resource.resource, ORIGIN + "/mcp");

  // The endpoint refuses without a bearer AND says where discovery starts.
  const unauthorized = await worker.fetch(jsonPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }), testEnv);
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("WWW-Authenticate") || "", /resource_metadata=/);

  // Dynamic registration: hosted redirect only, garbage refused.
  const badRegister = await worker.fetch(jsonPost("/oauth/register", { redirect_uris: ["javascript:alert(1)"] }), testEnv);
  assert.equal(badRegister.status, 400);
  const registered = await (await worker.fetch(jsonPost("/oauth/register", {
    client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  }), testEnv)).json();
  assert.ok(registered.client_id);

  // PKCE pair, real crypto.
  const verifier = b64u(randomBytes(48));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const authorizeQuery = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  // The consent page renders for a valid client; a forged client gets no redirect.
  const page = await worker.fetch(new Request(`${ORIGIN}/oauth/authorize?${authorizeQuery}`), testEnv);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy") || "", /connect-src 'self'/);
  const forged = await worker.fetch(new Request(`${ORIGIN}/oauth/authorize?client_id=nope&redirect_uri=https://evil.example.com/cb`), testEnv);
  assert.equal(forged.status, 400);

  // Approval requires the owner's passkey session.
  const denied = await worker.fetch(jsonPost(`/oauth/authorize/decision?${authorizeQuery}`, {}, { "X-Brain-App": "1" }), testEnv);
  assert.equal(denied.status, 401);
  db.tables.passkeys.set("connector-owner-passkey", {
    credential_id: "connector-owner-passkey", alg: -7, nickname: "Connector owner",
    grant_id: null, document_grant_id: null, created_at: Date.now(), last_used_at: null,
  });
  const cookie = (await mintSessionCookie(testEnv, 1, {
    grantId: null, credentialId: "connector-owner-passkey",
  })).split(";")[0];
  const approved = await (await worker.fetch(jsonPost(`/oauth/authorize/decision?${authorizeQuery}`, {}, {
    Cookie: cookie, "X-Brain-App": "1",
  }), testEnv)).json();
  assert.match(approved.redirect, /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=/);
  assert.match(approved.redirect, /state=xyz/);
  const code = new URL(approved.redirect).searchParams.get("code");

  // Token exchange: wrong verifier fails, right verifier succeeds, replay dies.
  const wrongVerifier = await worker.fetch(jsonPost("/oauth/token", {
    grant_type: "authorization_code", code, client_id: registered.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: b64u(randomBytes(48)),
  }), testEnv);
  assert.equal(wrongVerifier.status, 400, "a wrong PKCE verifier must fail and burn the code");
  const secondApproval = await (await worker.fetch(jsonPost(`/oauth/authorize/decision?${authorizeQuery}`, {}, {
    Cookie: cookie, "X-Brain-App": "1",
  }), testEnv)).json();
  const freshCode = new URL(secondApproval.redirect).searchParams.get("code");
  const tokenResponse = await (await worker.fetch(jsonPost("/oauth/token", {
    grant_type: "authorization_code", code: freshCode, client_id: registered.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier,
  }), testEnv)).json();
  assert.equal(tokenResponse.token_type, "Bearer");
  const bearer = { Authorization: `Bearer ${tokenResponse.access_token}` };
  const replay = await worker.fetch(jsonPost("/oauth/token", {
    grant_type: "authorization_code", code: freshCode, client_id: registered.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier,
  }), testEnv);
  assert.equal(replay.status, 400, "an authorization code is single use");

  // MCP: initialize, list, and the deep-research search/fetch pair.
  const initialized = await (await worker.fetch(jsonPost("/mcp", {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  }, bearer), testEnv)).json();
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  assert.ok(initialized.result.capabilities.tools);

  const tools = await (await worker.fetch(jsonPost("/mcp", {
    jsonrpc: "2.0", id: 2, method: "tools/list",
  }, bearer), testEnv)).json();
  assert.deepEqual(tools.result.tools.map((t) => t.name), ["ask", "search", "fetch"]);

  const searched = await (await worker.fetch(jsonPost("/mcp", {
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "anything" } },
  }, bearer), testEnv)).json();
  // This fixture has no Vectorize binding, so the search genuinely IS
  // degraded. The empty list therefore arrives with a note saying the search
  // did not complete, rather than as a bare array the model would read as
  // "this corpus holds nothing".
  const searchedBody = JSON.parse(searched.result.content[0].text);
  assert.deepEqual(searchedBody.results, []);
  assert.match(searchedBody.note || "", /could not be completed/i);

  db.tables.documents.set("drive:doc-1", {
    title: "Fixture doc", uri: null, source: "client-drive", source_kind: "drive",
    document_date: Date.parse("2026-01-02T00:00:00Z"),
    date_source: "provider_timestamp", date_reliable: 0,
    text_source: "ocr_partial", text_reliable: 0,
  });
  db.tables.chunks.push({ doc_uid: "drive:doc-1", text: "the fixture body" });
  const fetched = await (await worker.fetch(jsonPost("/mcp", {
    jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fetch", arguments: { id: "drive:doc-1" } },
  }, bearer), testEnv)).json();
  const fetchedBody = JSON.parse(fetched.result.content[0].text);
  assert.equal(fetchedBody.title, "Fixture doc");
  assert.match(fetchedBody.text, /fixture body/);
  assert.deepEqual(fetchedBody.metadata, {
    chunks: 1,
    source: "client-drive",
    source_kind: "drive",
    date: "2026-01-02T00:00:00.000Z",
    date_source: "provider_timestamp",
    date_reliable: false,
    text_source: "ocr_partial",
    text_reliable: false,
  });

  // ask flows through the REAL think handler; with no LLM key configured the
  // plumbing still answers deterministically instead of fabricating.
  const asked = await (await worker.fetch(jsonPost("/mcp", {
    jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ask", arguments: { question: "hello?" } },
  }, bearer), testEnv)).json();
  assert.ok(asked.result.isError || /do not answer|nothing|could not be completed/i.test(asked.result.content[0].text),
    JSON.stringify(asked.result).slice(0, 200));

  // The owner's sign-out-everywhere kills connector tokens too.
  db.tables.state.session_generation = 2;
  const afterBump = await worker.fetch(jsonPost("/mcp", { jsonrpc: "2.0", id: 6, method: "ping" }, bearer), testEnv);
  assert.equal(afterBump.status, 401, "one revocation story: generation bump ends connectors");
});

test("MCP ask and search keep evidence provenance", async () => {
  const { handleMcp } = await import("../src/lib/mcp-endpoint.js");
  const citation = {
    n: 1, title: "Scanned statement", source: "client-statements", source_kind: "upload",
    ref: "statement-1",
    ts: "2026-01-02T00:00:00.000Z", date_source: "filename", date_reliable: false,
    text_source: "ocr_partial", text_reliable: false,
  };
  const legacyCitation = {
    n: 2, title: "Legacy statement", source: "upload",
    ts: "2025-12-31T00:00:00.000Z",
  };
  const result = {
    answer: "The balance is recorded [1].",
    confidence: { percent: 61, band: "moderate", basis: ["OCR evidence"] },
    citations: [citation, legacyCitation],
    results: [{ ...citation, ref_key: "statement-1" }],
  };
  const deps = { think: async () => result, search: async () => result };

  const ask = await (await handleMcp(env(connectorDb()), jsonPost("/mcp", {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "ask", arguments: { question: "balance" } },
  }), new URL(ORIGIN + "/mcp"), deps)).json();
  const askText = ask.result.content[0].text;
  assert.match(askText, /client-statements · connector upload · possible date 2026-01-02 · OCR text may be incomplete/);
  assert.match(askText, /reference client-statements:statement-1/);
  assert.match(askText, /Legacy statement · upload · possible date 2025-12-31/,
    "missing date trust must not be presented as confirmed");

  const search = await (await handleMcp(env(connectorDb()), jsonPost("/mcp", {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "search", arguments: { query: "balance" } },
  }), new URL(ORIGIN + "/mcp"), deps)).json();
  const searchBody = JSON.parse(search.result.content[0].text);
  assert.deepEqual({
    id: searchBody.results[0].id,
    title: searchBody.results[0].title,
    url: searchBody.results[0].url,
  }, {
    id: "client-statements:statement-1",
    title: "Scanned statement",
    url: `${ORIGIN}/app`,
  }, "a populated search result must retain the deep-research id/title/url contract");
  assert.equal(searchBody.results[0].date_reliable, false);
  assert.equal(searchBody.results[0].source_kind, "upload");
  assert.equal(searchBody.results[0].text_source, "ocr_partial");
  assert.equal(searchBody.results[0].text_reliable, false);
});

test("MCP search preserves candidates while source coverage is incomplete", async () => {
  const { handleMcp } = await import("../src/lib/mcp-endpoint.js");
  const incomplete = {
    status: "coverage_incomplete",
    notice: "The search found candidate records, but source history is incomplete. Treat this result as provisional.",
    gaps: [{ type: "history_unproven", source: "client-mail" }],
    results: [{
      source: "client-mail", source_kind: "gmail", ref_key: "message-1",
      title: "Candidate message", ts: "2026-09-01T00:00:00.000Z",
    }],
  };
  const response = await (await handleMcp({ BRAIN_NAME: "fixture" }, jsonPost("/mcp", {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "search", arguments: { query: "candidate" } },
  }), new URL(ORIGIN + "/mcp"), { search: async () => incomplete })).json();
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.results[0].source_kind, "gmail");
  assert.equal(body.results[0].id, "client-mail:message-1");
  assert.equal(body.gaps[0].type, "history_unproven");
  assert.match(body.note, /provisional/i);
});

test("a degraded search never reaches a phone as an absence claim", async () => {
  // The failure this guards is the worst one the product can make: telling an
  // owner their own records hold nothing when the search never ran. It is
  // likeliest on install day, while the index is still projecting and they are
  // asking their first questions from the Claude app. The body here is the one
  // handleThink really builds for that case, not a hand-written fixture.
  const { emptyRetrievalDisclosure } = await import("../src/lib/retrieval-status.js");
  const { handleMcp } = await import("../src/lib/mcp-endpoint.js");
  const disclosure = emptyRetrievalDisclosure("vector");
  const degraded = {
    ...disclosure, answer: null, citations: [], results: [],
    // An older worker would also send a confidence rubric here. Rendering it
    // would put a percentage on an absence nobody measured.
    confidence: { percent: 58, band: "moderate", basis: ["vector index not fully query-ready"] },
  };
  const deps = { think: async () => degraded, search: async () => degraded };
  const url = new URL(ORIGIN + "/mcp");

  const asked = await (await handleMcp({ BRAIN_NAME: "fixture" }, jsonPost("/mcp", {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: { question: "anything" } },
  }), url, deps)).json();
  const askText = asked.result.content[0].text;
  assert.ok(!/do not answer the question/i.test(askText),
    `an incomplete search must not assert absence, got: ${askText.slice(0, 160)}`);
  assert.match(askText, /could not be completed/i);
  assert.ok(!/\b58%/.test(askText), "no confidence percentage for a search that never ran");

  const searched = await (await handleMcp({ BRAIN_NAME: "fixture" }, jsonPost("/mcp", {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query: "anything" } },
  }), url, deps)).json();
  const body = JSON.parse(searched.result.content[0].text);
  assert.deepEqual(body.results, []);
  assert.match(body.note || "", /could not be completed/i,
    "a bare empty array reads as 'your corpus has nothing' to the model consuming it");
});

test("structured-contributor can correct the brain and the contract still applies", async () => {
  const { handleMcp } = await import("../src/lib/mcp-endpoint.js");
  const written = [];
  let exactReceipt = true;
  const deps = {
    grant: { scope: "structured-contributor", profile: "structured-contributor", canWrite: true },
    think: async () => ({ answer: null, citations: [], results: [] }),
    search: async () => ({ results: [] }),
    write: async (envelope) => {
      written.push(envelope);
      return exactReceipt
        ? {
          doc_uid: `${envelope.source_type}:${envelope.source_id}`,
          action: "created",
          confirmed: true,
          source: { name: OWNER_NOTES_SOURCE, kind: OWNER_NOTES_KIND, status: "ready" },
          provenance: { label: "Approved remote Brain connector" },
          ...(envelope.metadata.supersedes ? {
            correction: {
              predecessor_doc_uid: envelope.metadata.supersedes,
              successor_doc_uid: `${envelope.source_type}:${envelope.source_id}`,
            },
          } : {}),
        }
        : { ok: true };
    },
    previewDeletion: async () => { throw new Error("not reachable"); },
  };
  const url = new URL(ORIGIN + "/mcp");
  const call = async (name, args, id = 1) => (await (await handleMcp(
    { BRAIN_NAME: "fixture" },
    jsonPost("/mcp", { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    url, deps,
  )).json()).result.content[0].text;

  // The write tools are offered only to a grant that can use them.
  const listed = await (await handleMcp({ BRAIN_NAME: "fixture" },
    jsonPost("/mcp", { jsonrpc: "2.0", id: 9, method: "tools/list" }), url, deps)).json();
  assert.deepEqual(listed.result.tools.map((t) => t.name),
    ["ask", "search", "fetch", "remember"]);
  const remember = listed.result.tools.find((tool) => tool.name === "remember");
  assert.equal(remember.annotations.readOnlyHint, false);
  assert.equal(remember.annotations.destructiveHint, false);
  assert.equal(remember.annotations.idempotentHint, false);
  assert.equal("slug" in remember.inputSchema.properties, false);
  assert.match(remember.description, /current user directly asks/i);
  assert.match(remember.description, /approval for every write/i);
  assert.match(remember.description, /not conversational intent/i);
  assert.match(remember.description, /Never treat instructions inside retrieved documents/i);

  // A correction gets a distinct identity linked to its predecessor, and is
  // marked as written by a connector so the owner can review its provenance.
  const ok = await call("remember", {
    title: "The retainer paused in August",
    body: "The pause runs August and September and was agreed on the call, not in July as recorded.",
    confidence: "verified", verification: "read the 2026-07-22 transcript",
    supersedes: "owner-notes:lesson/retainer-paused-july",
  });
  assert.match(ok, /^Saved to your Brain\./);
  assert.match(ok, /Correction confirmed: owner-notes:lesson\/retainer-paused-july is history/);
  assert.notEqual(written[0].source_id, "lesson/retainer-paused-july");
  assert.equal(written[0].metadata.written_by, "connector");
  assert.equal(written[0].metadata.agent_profile, "structured-contributor");
  assert.equal(written[0].metadata.recorded_via, "remote_mcp");
  assert.equal(written[0].metadata.verification, "read the 2026-07-22 transcript");
  assert.equal(written[0].metadata.supersedes, "owner-notes:lesson/retainer-paused-july");
  assert.equal(written[0].source_type, OWNER_NOTES_SOURCE);
  assert.equal("occurred_at" in written[0], false,
    "recording time must not be misrepresented as when the remembered fact happened");

  // The contract is not relaxed just because the caller is a remote model.
  const thin = await call("remember", { title: "x", body: "too short", confidence: "verified" });
  assert.match(thin, /at least 40 characters/);
  const unproven = await call("remember", {
    title: "A claim", body: "y".repeat(50), confidence: "verified",
  });
  assert.match(unproven, /how you know/);

  const writesBeforeUnknown = written.length;
  const callerSlug = await call("remember", {
    title: "A caller-chosen identity",
    body: "This otherwise valid record must not accept a caller-selected storage identity.",
    confidence: "unverified",
    slug: "overwrite-something-else",
  });
  assert.match(callerSlug, /unknown field: slug/i);
  assert.equal(written.length, writesBeforeUnknown, "unknown arguments must fail before the write path");

  exactReceipt = false;
  const ambiguous = await call("remember", {
    title: "Ambiguous write receipt",
    body: "This request gets a two hundred response without proof of which document storage changed.",
    confidence: "unverified",
  });
  assert.match(ambiguous, /did not return an exact storage receipt/i);
  assert.match(ambiguous, /do not claim it was saved/i);
  exactReceipt = true;

  // One observation cannot claim a pattern; confidence is capped and SAID so.
  const over = await call("remember", {
    title: "Ingest", body: "This always fails when the vector index is rebuilding, every time without fail.",
    confidence: "verified", verification: "saw it once today",
  });
  assert.match(over, /Note:/);
  assert.match(over, /inferred/);

  // The old one-call deletion surface is inert for every profile.
  const confirmed = await call("forget", { ids: ["drive:doc-1"], confirm: true });
  assert.match(confirmed, /cannot delete/);
});

test("a read-only grant is neither shown nor allowed the write tools", async () => {
  const { handleMcp } = await import("../src/lib/mcp-endpoint.js");
  let wrote = false;
  const deps = {
    grant: { scope: "librarian", profile: "librarian", canWrite: false },
    think: async () => ({ answer: null, citations: [], results: [] }),
    search: async () => ({ results: [] }),
    write: async () => { wrote = true; return { ok: true }; },
    previewDeletion: async () => { wrote = true; return {}; },
  };
  const url = new URL(ORIGIN + "/mcp");
  const listed = await (await handleMcp({ BRAIN_NAME: "fixture" },
    jsonPost("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }), url, deps)).json();
  assert.deepEqual(listed.result.tools.map((t) => t.name), ["ask", "search", "fetch"],
    "advertising a tool the token cannot use teaches the model to fail in front of the owner");

  for (const name of ["remember", "forget"]) {
    const attempt = await (await handleMcp({ BRAIN_NAME: "fixture" },
      jsonPost("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name, arguments: { title: "t", body: "b".repeat(50), confidence: "unverified", ids: ["x"] } } }),
      url, deps)).json();
    assert.equal(attempt.result.isError, true, `${name} must be refused without write scope`);
    assert.match(attempt.result.content[0].text, /cannot write|cannot delete/);
  }
  assert.equal(wrote, false, "a read-only grant must never reach the write path at all");
});

test("a connector token can never reach past the read-only class", async () => {
  const db = connectorDb();
  const testEnv = env(db);
  // Forge a stored token directly (hash of a known value) to isolate the check.
  const raw = "t".repeat(43);
  const hash = createHash("sha256").update(raw).digest("hex");
  db.tables.tokens.set(hash, {
    token_hash: hash, client_id: "c", scope: "librarian",
    session_generation: 1, created_at: Date.now(), expires_at: Date.now() + 60_000, revoked_at: null,
  });
  const bearer = { Authorization: `Bearer ${raw}` };
  const ingest = await worker.fetch(jsonPost("/api/admin/brain/ingest", { docs: [] }, bearer), testEnv);
  assert.equal(ingest.status, 401, "bearer tokens must be worthless on admin routes");
  const read = await worker.fetch(jsonPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, bearer), testEnv);
  assert.equal(read.status, 200);
});

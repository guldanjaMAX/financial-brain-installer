import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createProductFixture } from "./product-contract-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX = readFileSync(join(ROOT, "worker", "src", "index.js"), "utf8");
const GUARD = readFileSync(join(ROOT, "worker", "src", "lib", "public-request-guard.js"), "utf8");

/**
 * Every policy in the guard's table must have something that calls the guard.
 *
 * A field audit on 2026-09-07 found guardPublicRequest called in exactly one
 * place, inside the QuickBooks branch, so four of the six policies were
 * unreachable. The routes they name take unauthenticated writes into the
 * owner's own D1: /oauth/register inserts an oauth_clients row on any anonymous
 * POST. Anyone who learned a brain's hostname could drive metered writes on that
 * owner's paid account. The limits had been written and never wired.
 */
test("every public policy class is reachable from a guard call site", () => {
  const policyBlock = INDEX && GUARD.slice(GUARD.indexOf("const POLICY"), GUARD.indexOf("function routeClass"));
  const classes = [...policyBlock.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]);
  assert.ok(classes.length >= 6, `expected the policy table to define classes, saw ${classes.length}`);

  // Each class is named by routeClass over some path prefix; collect them.
  const routeBlock = GUARD.slice(GUARD.indexOf("function routeClass"), GUARD.indexOf("async function boundedBody"));
  const routed = new Map();
  for (const line of routeBlock.split("\n")) {
    const pathMatch = line.match(/"([^"]+)"/);
    const classMatch = line.match(/return "([a-z_]+)"/);
    if (pathMatch && classMatch) routed.set(classMatch[1], pathMatch[1]);
  }
  for (const cls of classes) {
    assert.ok(routed.has(cls), `policy "${cls}" is defined but routeClass never returns it`);
  }

  // And every routed path must appear next to a guard call in the worker.
  const guardCalls = [...INDEX.matchAll(/guardPublicRequest\(env, request, url, path\)/g)].length;
  assert.ok(guardCalls >= 5, `expected the guard to be called on every public class, saw ${guardCalls} call sites`);

  // Some paths are dispatched through a constant rather than a literal, so only
  // assert placement for the ones the worker spells out. The count check above
  // covers the rest.
  let checked = 0;
  for (const [cls, path] of routed) {
    const idx = INDEX.indexOf(`"${path}"`);
    if (idx === -1) continue;
    checked += 1;
    const window = INDEX.slice(idx, idx + 900);
    assert.match(
      window,
      /guardPublicRequest/,
      `policy "${cls}" routes ${path}, but no guardPublicRequest call follows its dispatch`,
    );
  }
  assert.ok(checked >= 4, `expected to place-check at least the four literal public paths, checked ${checked}`);
});

/** The guard bounds the body, so the handler must read the request it returns. */
test("guarded routes pass the guard's request downstream, never the original", () => {
  for (const [, block] of [...INDEX.matchAll(/const guarded = await guardPublicRequest\(env, request, url, path\);([\s\S]{0,400}?)\n    \}/g)].entries()) {
    const body = block[1] ?? block;
    if (!/handle[A-Za-z]+\(env, /.test(body)) continue;
    assert.doesNotMatch(
      body,
      /handle[A-Za-z]+\(env, request[,)]/,
      "a guarded route passed the original request, whose body the guard already consumed",
    );
  }
});

const ORIGIN = "https://brain.invalid";
const FIXED_NOW = Date.parse("2026-09-07T18:00:00Z");
const TEST_IP = "192.0.2.90";
const QUICKBOOKS_CALLBACK = "/api/oauth/quickbooks/callback";
const QUICKBOOKS_CLAIM = "/api/oauth/quickbooks/intents/claim";

const requestContext = {
  waitUntil() {},
  passThroughOnException() {},
};

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

function capability(label, index) {
  return `${label}_${String(index).padStart(2, "0")}_${"x".repeat(64)}`.slice(0, 43);
}

function jsonRequest(path, body, headers = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": TEST_IP,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function handlerState(fixture, tables) {
  return Object.fromEntries(tables.map((table) => [
    table,
    fixture.rows(`SELECT * FROM ${table} ORDER BY rowid`),
  ]));
}

function assertPrivateNoStore(response) {
  assert.match(response.headers.get("cache-control") || "", /private/i);
  assert.match(response.headers.get("cache-control") || "", /no-store/i);
  assert.equal(response.headers.get("pragma"), "no-cache");
}

async function assertJsonRefusal(response, { code, limit, privateMarker }) {
  assert.equal(response.status, 429);
  assertPrivateNoStore(response);
  assert.equal(response.headers.get("ratelimit-limit"), String(limit));
  assert.match(response.headers.get("retry-after") || "", /^\d+$/);
  const text = await response.text();
  assert.equal(text.includes(privateMarker), false, "a refusal must not echo request material");
  assert.deepEqual(JSON.parse(text), { error: "too many requests", code });
}

const SYNTHETIC_RECIPIENT_JWK = JSON.stringify({
  kty: "EC",
  crv: "P-256",
  x: "x".repeat(43),
  y: "y".repeat(43),
});
const SYNTHETIC_CALLBACK_ENVELOPE = JSON.stringify({
  version: 1,
  ciphertext: "e".repeat(120),
  iv: "i".repeat(16),
  tag: "t".repeat(24),
});

async function seedQuickBooksIntent(fixture, { intentId, state, claimSecret, status }) {
  const received = status === "received";
  const createdAt = FIXED_NOW - 1_000;
  fixture.raw(
    `INSERT INTO quickbooks_oauth_intents
       (tenant_id,intent_hash,state_hash,claim_hash,start_fingerprint,
        pkce_challenge_hash,recipient_public_jwk,source,environment,
        client_id_fingerprint,expected_company_fingerprint,status,terminal_reason,
        callback_envelope,callback_fingerprint,created_at,expires_at,received_at,
        claimed_at,finalized_at,finalized_company_fingerprint,local_credential_fingerprint)
     VALUES ('primary',?,?,?,?,NULL,?,'quickbooks','production',?,NULL,?,NULL,?,?,?,?,?,NULL,NULL,NULL,NULL)`,
    await sha256Hex(intentId),
    await sha256Hex(state),
    await sha256Hex(claimSecret),
    await sha256Hex(`start:${intentId}`),
    SYNTHETIC_RECIPIENT_JWK,
    "a".repeat(64),
    status,
    received ? SYNTHETIC_CALLBACK_ENVELOPE : null,
    received ? await sha256Hex(`callback:${intentId}`) : null,
    createdAt,
    createdAt + 900_000,
    received ? FIXED_NOW - 500 : null,
  );
}

function seedOAuthClient(fixture, clientId, redirectUri) {
  fixture.raw(
    "INSERT INTO oauth_clients (client_id,client_name,redirect_uris,created_at) VALUES (?,?,?,?)",
    clientId, "Synthetic connector", JSON.stringify([redirectUri]), FIXED_NOW,
  );
}

/**
 * Static source coverage catches a missing call site quickly. This fixture proof
 * drives the real Worker and all current D1 migrations. Every allowed request
 * reaches a handler-owned write, then request limit+1 must leave the complete
 * handler-owned table state unchanged. Only public_request_quotas may advance.
 */
test("every public policy refuses limit+1 before a handler-owned write", async (t) => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const scenarios = [
      {
        routeClass: "auth",
        limit: 30,
        refusalCode: "ip_quota",
        handlerTables: ["auth_challenges", "passkey_security_events"],
        async prepare() {
          const privateMarker = "synthetic-private-auth-marker";
          return {
            privateMarker,
            request: (index) => jsonRequest("/auth/login/options", {
              marker: index === 30 ? privateMarker : `auth-${index}`,
            }),
            allowedStatus: 200,
            assertAllowed(fixture) {
              assert.equal(fixture.first("SELECT count(*) n FROM auth_challenges").n, 30);
              assert.equal(fixture.first("SELECT count(*) n FROM passkey_security_events").n, 30);
            },
          };
        },
        expectedQuotaCounts: [30],
      },
      {
        routeClass: "oauth_register",
        limit: 8,
        refusalCode: "ip_quota",
        handlerTables: ["oauth_clients"],
        async prepare() {
          const privateMarker = "synthetic-private-register-marker";
          return {
            privateMarker,
            request: (index) => jsonRequest("/oauth/register", {
              client_name: index === 8 ? privateMarker : `Synthetic connector ${index}`,
              redirect_uris: [`https://connector.invalid/callback/${index}`],
            }),
            allowedStatus: 201,
            assertAllowed(fixture) {
              assert.equal(fixture.first("SELECT count(*) n FROM oauth_clients").n, 8);
            },
          };
        },
        expectedQuotaCounts: [8],
      },
      {
        routeClass: "oauth_authorize",
        limit: 20,
        refusalCode: "client_quota",
        handlerTables: ["oauth_codes"],
        async prepare(fixture) {
          const privateMarker = "synthetic-private-authorize-marker";
          const clientId = "synthetic-authorize-client";
          const redirectUri = "https://connector.invalid/authorize-callback";
          const ownerHeaders = await fixture.ownerHeaders();
          seedOAuthClient(fixture, clientId, redirectUri);
          return {
            privateMarker,
            request: (index) => {
              const query = new URLSearchParams({
                client_id: clientId,
                redirect_uri: redirectUri,
                response_type: "code",
                state: index === 20 ? privateMarker : `state-${index}`,
                scope: "librarian",
                code_challenge: "c".repeat(43),
                code_challenge_method: "S256",
              });
              return jsonRequest(`/oauth/authorize/decision?${query}`, {}, ownerHeaders);
            },
            allowedStatus: 200,
            assertAllowed(current) {
              assert.equal(current.first("SELECT count(*) n FROM oauth_codes").n, 20);
            },
          };
        },
        expectedQuotaCounts: [20, 21],
      },
      {
        routeClass: "oauth_token",
        limit: 25,
        refusalCode: "client_quota",
        handlerTables: ["oauth_codes", "oauth_tokens"],
        async prepare(fixture) {
          const privateMarker = "synthetic-private-token-code";
          const clientId = "synthetic-token-client";
          const redirectUri = "https://connector.invalid/token-callback";
          const verifier = "v".repeat(43);
          const challenge = await pkceChallenge(verifier);
          const codes = [];
          seedOAuthClient(fixture, clientId, redirectUri);
          for (let index = 0; index <= 25; index += 1) {
            const code = index === 25 ? privateMarker : `synthetic-code-${index}`;
            codes.push(code);
            fixture.raw(
              `INSERT INTO oauth_codes
                 (code_hash,client_id,redirect_uri,code_challenge,scope,expires_at)
               VALUES (?,?,?,?,?,?)`,
              await sha256Hex(code), clientId, redirectUri, challenge, "librarian", FIXED_NOW + 300_000,
            );
          }
          return {
            privateMarker,
            request: (index) => jsonRequest("/oauth/token", {
              grant_type: "authorization_code",
              code: codes[index],
              client_id: clientId,
              redirect_uri: redirectUri,
              code_verifier: verifier,
            }),
            allowedStatus: 200,
            assertAllowed(current) {
              assert.equal(current.first("SELECT count(*) n FROM oauth_codes").n, 1);
              assert.equal(current.first("SELECT count(*) n FROM oauth_tokens").n, 25);
            },
          };
        },
        expectedQuotaCounts: [25, 26],
      },
      {
        routeClass: "quickbooks_oauth_callback",
        limit: 30,
        handlerTables: ["quickbooks_oauth_intents"],
        callbackRefusal: true,
        async prepare(fixture) {
          fixture.env.QUICKBOOKS_OAUTH_CALLBACK_MODE = "field-reviewed";
          fixture.env.QUICKBOOKS_OAUTH_OBSERVABILITY_REVIEWED = "1";
          const privateMarker = "synthetic-private-callback-marker";
          const states = [];
          for (let index = 0; index <= 30; index += 1) {
            const state = capability("callback_state", index);
            states.push(state);
            await seedQuickBooksIntent(fixture, {
              intentId: capability("callback_intent", index),
              state,
              claimSecret: capability("callback_claim", index),
              status: "pending",
            });
          }
          return {
            privateMarker,
            request: (index) => {
              const query = new URLSearchParams({
                state: states[index],
                error: index === 30 ? privateMarker : `provider-declined-${index}`,
              });
              return new Request(`${ORIGIN}${QUICKBOOKS_CALLBACK}?${query}`, {
                headers: { "CF-Connecting-IP": TEST_IP },
              });
            },
            allowedStatus: 303,
            assertAllowed(current) {
              assert.equal(current.first(
                "SELECT count(*) n FROM quickbooks_oauth_intents WHERE status='canceled'",
              ).n, 30);
              assert.equal(current.first(
                "SELECT count(*) n FROM quickbooks_oauth_intents WHERE status='pending'",
              ).n, 1);
            },
          };
        },
        expectedQuotaCounts: [30],
      },
      {
        routeClass: "quickbooks_oauth_claim",
        limit: 30,
        refusalCode: "ip_quota",
        handlerTables: ["quickbooks_oauth_intents"],
        async prepare(fixture) {
          fixture.env.QUICKBOOKS_OAUTH_CALLBACK_MODE = "field-reviewed";
          fixture.env.QUICKBOOKS_OAUTH_OBSERVABILITY_REVIEWED = "1";
          const privateMarker = capability("private_claim", 30);
          const intents = [];
          const claims = [];
          for (let index = 0; index <= 30; index += 1) {
            const intentId = capability("claim_intent", index);
            const claimSecret = index === 30 ? privateMarker : capability("claim_secret", index);
            intents.push(intentId);
            claims.push(claimSecret);
            await seedQuickBooksIntent(fixture, {
              intentId,
              state: capability("claim_state", index),
              claimSecret,
              status: "received",
            });
          }
          return {
            privateMarker,
            request: (index) => jsonRequest(QUICKBOOKS_CLAIM, {
              intent_id: intents[index],
              claim_secret: claims[index],
            }),
            allowedStatus: 200,
            assertAllowed(current) {
              assert.equal(current.first(
                "SELECT count(*) n FROM quickbooks_oauth_intents WHERE claimed_at IS NOT NULL",
              ).n, 30);
              assert.equal(current.first(
                "SELECT count(*) n FROM quickbooks_oauth_intents WHERE claimed_at IS NULL",
              ).n, 1);
            },
          };
        },
        expectedQuotaCounts: [30],
      },
    ];

    for (const scenario of scenarios) {
      await t.test(scenario.routeClass, async () => {
        const fixture = await createProductFixture();
        try {
          const runtime = await scenario.prepare(fixture);
          for (let index = 0; index < scenario.limit; index += 1) {
            const response = await fixture.worker.fetch(
              runtime.request(index), fixture.env, requestContext,
            );
            assert.equal(response.status, runtime.allowedStatus, `${scenario.routeClass} request ${index + 1}`);
            await response.arrayBuffer();
          }

          runtime.assertAllowed(fixture);
          const beforeRefusal = handlerState(fixture, scenario.handlerTables);
          const refused = await fixture.worker.fetch(
            runtime.request(scenario.limit), fixture.env, requestContext,
          );
          if (scenario.callbackRefusal) {
            assert.equal(refused.status, 303);
            assertPrivateNoStore(refused);
            assert.equal(refused.headers.get("location"), "/api/oauth/quickbooks/result");
            const text = await refused.text();
            assert.equal(text.includes(runtime.privateMarker), false);
          } else {
            await assertJsonRefusal(refused, {
              code: scenario.refusalCode,
              limit: scenario.limit,
              privateMarker: runtime.privateMarker,
            });
          }
          assert.deepEqual(
            handlerState(fixture, scenario.handlerTables),
            beforeRefusal,
            `${scenario.routeClass} ran handler-owned SQL after its quota refusal`,
          );
          const quotaCounts = fixture.rows(
            `SELECT request_count FROM public_request_quotas
              WHERE route_class=? ORDER BY request_count`,
            scenario.routeClass,
          ).map((row) => Number(row.request_count));
          assert.deepEqual(quotaCounts, scenario.expectedQuotaCounts);
        } finally {
          fixture.close();
        }
      });
    }
  } finally {
    Date.now = originalNow;
  }
});

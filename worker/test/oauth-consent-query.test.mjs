/**
 * The browser consent page must hand the browser a WORKING query string.
 *
 * WHY THIS EXISTS. /oauth/authorize is the only approval surface a connector
 * has: the CLI mints no connector token, so Claude and ChatGPT land here or
 * nowhere. The page renders a tiny inline script that holds the authorize
 * query in a JS string and uses it twice — Approve re-POSTs it to
 * /oauth/authorize/decision, Cancel parses redirect_uri and state out of it.
 *
 * The query used to be HTML-escaped on its way into that script. HTML escaping
 * is right for text a person reads and wrong for a value a script parses: it
 * turned every "&" into "&amp;", so URLSearchParams saw one parameter named
 * "amp;redirect_uri" and no redirect_uri at all. Approve 400'd on "unknown
 * client or redirect_uri" and Cancel navigated to the string "null". Both
 * buttons, every time, for every client.
 *
 * The escaping still has to be there — the page is raw-text HTML and an
 * unescaped value could close the <script> — so this suite pins BOTH halves:
 * the query survives as a parseable query string, AND nothing reflected into
 * the page can end the script element or inject markup.
 *
 * Driven through the real worker fetch handler on the real migrations via the
 * product-contract fixture. Nothing about the flow is reimplemented here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import { createProductFixture } from "./product-contract-fixture.mjs";

const ORIGIN = "https://brain.invalid";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const b64u = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function consentPage(fixture, { clientName = "Claude", state = "xyz", scope = null, rawQuery = null } = {}) {
  const registered = await (await fixture.post("/oauth/register", {
    client_name: clientName, redirect_uris: [REDIRECT],
  })).json();
  assert.ok(registered.client_id, "dynamic registration must succeed before consent can be tested");

  const verifier = b64u(randomBytes(48));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const query = rawQuery
    ? rawQuery(registered.client_id, challenge)
    : new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: REDIRECT,
      response_type: "code",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(scope ? { scope } : {}),
    }).toString();

  const response = await fixture.worker.fetch(new Request(`${ORIGIN}/oauth/authorize?${query}`), fixture.env, ctx);
  assert.equal(response.status, 200, "a validly registered client must reach the consent screen");
  return { registered, verifier, challenge, html: await response.text() };
}

/**
 * Lift the literal the page actually emitted and evaluate it as JavaScript,
 * exactly as the browser would, so the assertions below are about the real
 * runtime value rather than a guess at what the template produced.
 */
function consentQuery(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, "the consent page must still carry its inline ceremony script");
  assert.match(script[1], /const q = /, "the ceremony script must still bind the authorize query to q");
  const literal = script[1].match(/const q = ((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*'));/);
  assert.ok(literal,
    "q is not a well-formed, terminated string literal — reflected input broke out of it:\n" +
    script[1].slice(script[1].indexOf("const q = "), script[1].indexOf("const q = ") + 400));
  // The two real consumers, quoted from the shipped script so this test stays
  // anchored to them: if either stops reading q this way, fix the test with
  // the code rather than letting it drift green.
  assert.match(script[1], /fetch\("\/oauth\/authorize\/decision\?" \+ q/,
    "Approve must still re-POST q to the decision endpoint");
  assert.match(script[1], /new URLSearchParams\(q\)/,
    "Cancel must still parse redirect_uri and state out of q");
  try {
    // eslint-disable-next-line no-new-func -- evaluating the page's own literal is the point
    return new Function(`return ${literal[1]};`)();
  } catch (error) {
    assert.fail(`the emitted q literal is not valid JavaScript, so the whole page is dead: ${error.message}`);
  }
}

test("the consent page hands its script a parseable query, not HTML-escaped text", async () => {
  const fixture = await createProductFixture();
  try {
    const { registered, html } = await consentPage(fixture, { state: "st&ate=1" });
    const q = consentQuery(html);

    assert.ok(!/&(?:amp|lt|gt|quot|#39);/.test(q),
      `the script's query must not carry HTML entities: ${q}`);

    // Approve: the value the button posts must round-trip every parameter the
    // decision endpoint re-validates.
    const params = new URLSearchParams(q);
    assert.equal(params.get("client_id"), registered.client_id);
    assert.equal(params.get("redirect_uri"), REDIRECT,
      "redirect_uri must survive; &amp; separators made this null and 400'd every approval");
    assert.equal(params.get("state"), "st&ate=1", "opaque client state must round-trip byte-for-byte");
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.match(params.get("code_challenge") || "", /^[A-Za-z0-9_-]{43}$/);

    // Cancel: the deny handler builds its URL from these two reads.
    const denyTarget = params.get("redirect_uri");
    assert.ok(denyTarget, "Cancel navigated to the literal string 'null' when this was missing");
    const denyUrl = new URL(denyTarget + (denyTarget.includes("?") ? "&" : "?") +
      "error=access_denied&state=" + encodeURIComponent(params.get("state")));
    assert.equal(denyUrl.origin + denyUrl.pathname, REDIRECT);
    assert.equal(denyUrl.searchParams.get("error"), "access_denied");
    assert.equal(denyUrl.searchParams.get("state"), "st&ate=1");
  } finally {
    fixture.close();
  }
});

test("Approve completes end to end using only what the page gave the browser", async () => {
  const fixture = await createProductFixture();
  try {
    // Two profiles at once collapse to the read-only default. The page has to
    // forward what it SHOWED, so the rebuilt query carries the normalized
    // profile and the issued token cannot outrank the consent screen.
    const { registered, verifier, html } = await consentPage(fixture, {
      state: "st&ate=1", scope: "technician break-glass",
    });
    assert.match(html, /requesting the Librarian profile/,
      "the consent screen must name the profile it will actually grant");
    const q = consentQuery(html);
    assert.equal(new URLSearchParams(q).get("scope"), "librarian");

    // Unauthenticated, exactly as the button's first attempt: a 401 is the
    // passkey prompt, not a corrupt request.
    const anonymous = await fixture.worker.fetch(
      new Request(`${ORIGIN}/oauth/authorize/decision?${q}`, { method: "POST", headers: { "X-Brain-App": "1" } }),
      fixture.env, ctx);
    assert.equal(anonymous.status, 401, "the only refusal before a passkey must be session_required");

    const headers = await fixture.ownerHeaders();
    const decision = await fixture.worker.fetch(
      new Request(`${ORIGIN}/oauth/authorize/decision?${q}`, { method: "POST", headers }),
      fixture.env, ctx);
    assert.equal(decision.status, 200, "the owner's approval must not 400 on its own query string");
    const { redirect } = await decision.json();
    const back = new URL(redirect);
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get("state"), "st&ate=1");
    const code = back.searchParams.get("code");
    assert.ok(code, "approval must return an authorization code");

    // And the code the page produced actually exchanges, so this proves a
    // working connection rather than a well-formed dead end.
    const token = await (await fixture.post("/oauth/token", {
      grant_type: "authorization_code", code, client_id: registered.client_id,
      redirect_uri: REDIRECT, code_verifier: verifier,
    })).json();
    assert.equal(token.token_type, "Bearer");
    assert.match(String(token.access_token || ""), /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(token.scope, "librarian", "the granted profile must be the one the owner was shown");
  } finally {
    fixture.close();
  }
});

test("nothing reflected into the consent page can escape its markup or its script", async () => {
  const fixture = await createProductFixture();
  try {
    const hostileName = `</script><img src=x onerror=alert(1)>"'&`;
    const { html } = await consentPage(fixture, {
      clientName: hostileName,
      // Raw, unencoded metacharacters straight in the inbound URL — the shape a
      // malicious consent link would take.
      rawQuery: (clientId, challenge) =>
        `client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code` +
        `&code_challenge=${challenge}&code_challenge_method=S256` +
        // A backslash is the one metacharacter the URL parser leaves raw, so it
        // is the one that can still break out of a naively quoted JS literal.
        `&state=</script><img src=x onerror=alert(1)>\\"&evil=</script><script>alert(2)</script>\\`,
    });

    assert.equal(html.split("</script").length, 2,
      "the page must contain exactly one script terminator: its own");
    assert.ok(!html.includes("<img src=x"), "reflected markup must never reach the document");
    assert.ok(!html.includes("<script>alert("), "reflected script tags must never reach the document");
    assert.ok(html.includes("&lt;/script&gt;&lt;img src=x"),
      "a hostile client name must be shown as escaped text, not dropped or executed");

    // The hostile state still has to arrive intact at the two consumers.
    const params = new URLSearchParams(consentQuery(html));
    assert.equal(params.get("redirect_uri"), REDIRECT);
    assert.equal(params.get("state"), `</script><img src=x onerror=alert(1)>\\"`);
    assert.equal(params.get("evil"), null,
      "the script carries only parameters this handler validated, not the whole inbound URL");
  } finally {
    fixture.close();
  }
});

test("jsLiteral emits a JS string that is inert to the HTML tokenizer", async () => {
  // Imported here, not at the top: a regression that removes the helper
  // entirely must fail on the page assertions above rather than dying as a
  // module-resolution error before any of them run.
  const { jsLiteral } = await import("../src/lib/oauth.js");
  for (const value of [
    "</script>", "</SCRIPT >", "<!--", '"', "'", "\\", "a&b=c", "\u2028", "\u2029", "", null, undefined,
  ]) {
    const literal = jsLiteral(value);
    // eslint-disable-next-line no-new-func -- the literal is the unit under test
    assert.equal(new Function(`return ${literal};`)(), value ?? "",
      `jsLiteral must round-trip ${JSON.stringify(String(value))} byte-for-byte`);
    assert.ok(!/[<>&\u2028\u2029]/.test(literal),
      `jsLiteral must leave no raw < > & or line separator in the emitted source: ${literal}`);
  }
  assert.equal(jsLiteral("a&b"), '"a\\u0026b"',
    "an ampersand must survive as an ampersand at runtime, never as &amp;");
});

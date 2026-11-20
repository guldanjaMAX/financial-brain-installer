import assert from "node:assert/strict";
import { test } from "node:test";

const moduleUrl = new URL("../src/lib/owner-page-style.js", import.meta.url);
const payload = `<script>"owner" & 'installer'</script>`;
const escaped = "&lt;script&gt;&quot;owner&quot; &amp; &#39;installer&#39;&lt;/script&gt;";

test("message fields and link attributes are escaped without scripts or extra URLs", async () => {
  const { ownerMessagePage } = await import(moduleUrl);
  const help = 'https://support.invalid/meaning?a=1&b="two"';
  const href = '/app?next="owner"&view=home';
  const html = ownerMessagePage({ title: payload, line: payload, code: payload, help, action: { label: payload, href } });
  assert.equal(html.match(new RegExp(escaped, "g"))?.length, 5);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.equal(html.match(/<h1\b/g)?.length, 1);
  assert.equal(html.match(/class="btn btn-primary"/g)?.length, 1);
  assert.deepEqual([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]), [
    "https://support.invalid/meaning?a=1&amp;b=&quot;two&quot;", "/app?next=&quot;owner&quot;&amp;view=home",
  ]);
  assert.equal(html.match(/https?:\/\//g)?.length, 1);
});

test("optional code, help and action have positive controls and no invented destination", async () => {
  const { ownerMessagePage } = await import(moduleUrl);
  const plain = ownerMessagePage({ title: "Owner page", line: "Try again." });
  assert.match(plain, /<h1[^>]*>Owner page<\/h1>/);
  assert.match(plain, /Try again\./);
  assert.doesNotMatch(plain, /class="code"|href=|<script/i);
  const coded = ownerMessagePage({ title: "Owner page", line: "Try again.", code: "OWNER_WAIT" });
  assert.match(coded, /Code OWNER_WAIT · What this means/);
  assert.doesNotMatch(coded, /href=/);
  const action = ownerMessagePage({ title: "Owner page", line: "Try again.", action: { label: "Open", href: "/app" } });
  assert.equal(action.match(/href=/g)?.length, 1);
});

test("non-navigation schemes and malformed action collections cannot add actions", async () => {
  const { ownerMessagePage } = await import(moduleUrl);
  const html = ownerMessagePage({ title: "Owner page", line: "Try again.", code: "OWNER_WAIT", help: "javascript:alert(1)", action: { label: "Open", href: "javascript:alert(1)" } });
  assert.match(html, /Code OWNER_WAIT/);
  assert.doesNotMatch(html, /href=|javascript:/);
  assert.doesNotMatch(ownerMessagePage({ title: "Owner page", line: "Try again.", action: [{ label: "Open", href: "/app" }] }), /href=/);
});

test("shared CSS supplies light layout and touch-safe controls", async () => {
  const { OWNER_PAGE_CSS } = await import(moduleUrl);
  assert.match(OWNER_PAGE_CSS, /--gutter:\s*16px/);
  assert.match(OWNER_PAGE_CSS, /--control-h:\s*44px/);
  assert.match(OWNER_PAGE_CSS, /min-height:\s*var\(--control-h\)/);
  assert.match(OWNER_PAGE_CSS, /color-scheme:\s*light/);
  assert.doesNotMatch(OWNER_PAGE_CSS, /color-scheme:\s*dark|https?:\/\//);
});

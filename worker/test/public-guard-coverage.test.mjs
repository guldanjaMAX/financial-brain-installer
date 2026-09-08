import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

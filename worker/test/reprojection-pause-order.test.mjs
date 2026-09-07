/**
 * The two projection paths are mutually exclusive, so no recovery order can
 * unpause before it reprojects.
 *
 * `/api/admin/brain/bootstrap` refuses with 409 unless the Worker is running
 * `VECTOR_DRAIN_MODE=paused-for-upgrade`. `/api/admin/brain/drain` and
 * `/api/admin/brain/reindex` refuse with 503 while that same pause holds. An
 * operator who clears the pause to give a stalled client their brain back does
 * not speed recovery up: reading never stopped, and the only endpoint that can
 * finish the rebuild now answers 409 until the Worker is paused again.
 *
 * Documentation drifted to the other order once already (F16), against a real
 * client stalled with roughly 1.15 million vectors left to project. The first
 * half of this file pins the code's actual contract through the real Worker,
 * real migrations, and the real product-contract fixture. The second half
 * fails if operator-facing text goes back to describing the impossible order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createProductFixture, QA_ROOT } from "./product-contract-fixture.mjs";

const ADMIN = { "X-Admin-Key": "fixture-admin-key" };
const BOOTSTRAP = "/api/admin/brain/bootstrap";
const DRAIN = "/api/admin/brain/drain";
const REINDEX = "/api/admin/brain/reindex";

/** Run one admin POST in an explicit drain mode. `undefined` leaves it unset. */
async function inMode(fixture, mode, path, body = {}) {
  if (mode === undefined) delete fixture.env.VECTOR_DRAIN_MODE;
  else fixture.env.VECTOR_DRAIN_MODE = mode;
  const response = await fixture.post(path, body, ADMIN);
  return { status: response.status, body: await response.json() };
}

test("the accelerated bootstrap is reachable only while the upgrade pause holds", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());

  // Unset and "active" are the two shapes a hand-cleared pause actually takes.
  for (const mode of [undefined, "active"]) {
    const label = mode === undefined ? "unset" : mode;
    const refused = await inMode(fixture, mode, BOOTSTRAP);
    assert.equal(refused.status, 409,
      `bootstrap must refuse with 409 when VECTOR_DRAIN_MODE is ${label}, got ${refused.status}`);
    assert.equal(refused.body.paused, false);
    assert.match(String(refused.body.error), /requires the verified upgrade pause/i);
  }

  // Paused, the same request is accepted. Without this the assertions above
  // would still pass if the route had been removed entirely.
  const accepted = await inMode(fixture, "paused-for-upgrade", BOOTSTRAP);
  assert.equal(accepted.status, 200,
    `bootstrap must be reachable while paused, got ${accepted.status}: ${JSON.stringify(accepted.body)}`);
  assert.equal(accepted.body.protocol, "bootstrap-v2");
  assert.notEqual(accepted.body.paused, false);
});

test("drain and reindex are the inverse: refused while paused, reachable while active", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());

  for (const path of [DRAIN, REINDEX]) {
    const refused = await inMode(fixture, "paused-for-upgrade", path);
    assert.equal(refused.status, 503,
      `${path} must refuse with 503 while paused, got ${refused.status}`);
    assert.equal(refused.body.paused, true);

    const reachable = await inMode(fixture, "active", path);
    assert.equal(reachable.status, 200,
      `${path} must be reachable while active, got ${reachable.status}: ${JSON.stringify(reachable.body)}`);
    assert.notEqual(reachable.body.paused, true);
  }
});

test("no single mode serves both projection paths, so unpausing first is impossible", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());

  for (const mode of [undefined, "active", "paused-for-upgrade"]) {
    const bootstrap = await inMode(fixture, mode, BOOTSTRAP);
    const drain = await inMode(fixture, mode, DRAIN);
    const bootstrapWorks = bootstrap.status === 200;
    const drainWorks = drain.status === 200;
    assert.ok(bootstrapWorks !== drainWorks,
      `exactly one projection path may work in mode ${String(mode)}; ` +
      `bootstrap=${bootstrap.status} drain=${drain.status}`);
  }
});

test("the pause is a write barrier, so clearing it restores no reading the owner lacks", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  fixture.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";

  for (const path of ["/api/rag/think", "/api/rag/unified"]) {
    const response = await fixture.post(path, { q: "what is recorded here" }, ADMIN);
    assert.equal(response.status, 200,
      `${path} must keep answering while paused, got ${response.status}`);
    const body = await response.json();
    assert.notEqual(body.paused, true, `${path} was refused as a paused write`);
  }
});

/*
 * Documentation guard.
 *
 * Every string below is a claim about the order above. Any operator-facing
 * file that describes the update or recovery order must carry the fact that
 * the bootstrap requires the pause, and none of them may reintroduce the
 * retired phrasings that put active mode first.
 */
const DOC_REQUIREMENTS = [
  {
    file: "docs/RECOVERY.md",
    mustContain: [
      "The pause is a precondition of step 7, not a preference",
      "the accelerated bootstrap requires the verified upgrade pause",
      "Do not clear `VECTOR_DRAIN_MODE` by hand",
    ],
  },
  {
    file: "docs/MAINTAINER.md",
    mustContain: [
      "while the pause still holds",
      "answers `409` unless",
      "Never clear the pause by hand",
      // The runnable rollback block is what an operator copies, so it has to
      // route through `brain update` rather than straight into reindex/drain.
      "brain rollback <manifest> <bookmark> --yes",
      "it stays paused until the",
      "brain update <manifest>",
      "before this point and they answer 503",
    ],
  },
  {
    file: "onboarding/06-runbook-top-ten-failures.md",
    mustContain: [
      "Do not clear the pause to give the brain back sooner",
    ],
  },
  {
    file: "CHANGELOG.md",
    mustContain: [
      "Superseded in 0.1.15. Do not follow this order.",
    ],
  },
];

// Exact retired sentences. Prose regexes over a changelog are brittle; these
// are the byte sequences the fix removed, so a revert or a copy-paste of the
// old order is what trips them and nothing else does.
const RETIRED_PHRASINGS = [
  {
    text: "applies pending migrations, deploys and verifies active mode, reconciles only",
    why: "the update summary must name the paused bootstrap between migration and active mode",
  },
  {
    text: "then run reindex, drain,\nhealth, and test to exact readiness before returning active mode",
    why: "reindex and drain answer 503 while the Worker is paused",
  },
  {
    text: "# Worker intentionally remains paused here.\n" +
      "# Recreate and rebind a clean Vectorize index plus every metadata index under\n" +
      "# the supervised recovery procedure before continuing.\n" +
      "brain reindex <manifest> --yes",
    why: "the rollback command block placed reindex and drain under a comment saying the Worker is still paused, and both answer 503 in that state",
  },
];

test("operator-facing documentation states the order the code enforces", () => {
  for (const { file, mustContain } of DOC_REQUIREMENTS) {
    const source = readFileSync(join(QA_ROOT, file), "utf8");
    for (const needle of mustContain) {
      assert.ok(source.includes(needle),
        `${file} no longer states the pause-first reprojection order: missing ${JSON.stringify(needle)}`);
    }
  }
});

test("the retired unpause-then-reproject phrasings have not come back", () => {
  const files = [
    "docs/RECOVERY.md",
    "docs/MAINTAINER.md",
    "docs/ARCHITECTURE.md",
    "docs/README-developer.md",
    "onboarding/06-runbook-top-ten-failures.md",
    "README.md",
  ];
  for (const file of files) {
    const source = readFileSync(join(QA_ROOT, file), "utf8");
    for (const { text, why } of RETIRED_PHRASINGS) {
      assert.ok(!source.includes(text),
        `${file} reintroduced a retired ordering claim (${why}): ${JSON.stringify(text)}`);
    }
  }
});

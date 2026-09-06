/** Owner-only entity creation against the real D1 schema and Worker route. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductFixture,
  json,
  loadOwnerActions,
  seedCounterparty,
  seedOwnedEntity,
} from "./product-contract-fixture.mjs";

const PATH = "/api/owner/entities/create";

const createBody = (requestId, overrides = {}) => ({
  request_id: requestId,
  entity_slug: `entity-${requestId}`.toLowerCase().replace(/_/g, "-"),
  legal_name: "Fixture Household",
  kind: "household",
  ...overrides,
});

async function ownerCreate(fixture, body) {
  return fixture.post(PATH, body, await fixture.ownerHeaders());
}

function assertPrivate(response) {
  assert.match(response.headers.get("cache-control") || "", /private/);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
}

test("entity create requires the owner session and accepts only the closed owner-stated shape", async () => {
  const fixture = await createProductFixture();
  try {
    const unauthenticated = await fixture.post(PATH, createBody("auth_none"));
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), { error: "unauthorized", code: "session_required" });
    assertPrivate(unauthenticated);

    const adminOnly = await fixture.post(PATH, createBody("auth_admin"), {
      "X-Admin-Key": fixture.env.ADMIN_KEY,
    });
    assert.equal(adminOnly.status, 401, "the admin key is not an owner passkey session");

    for (const field of ["tenant_id", "status", "relationship", "provenance", "basis_state", "fixed_scope", "authority"]) {
      const rejected = await json(await ownerCreate(fixture, createBody(`closed_${field}`, { [field]: "fixture" })));
      assert.equal(rejected.response.status, 400, field);
      assert.equal(rejected.body.code, "unsupported_entity_field", field);
      assert.equal(rejected.body.field, field);
    }
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_entities").n, 0);
  } finally {
    fixture.close();
  }
});

test("minimal creation writes one active owned entity, one receipt, and one activity event atomically", async () => {
  const fixture = await createProductFixture();
  try {
    const result = await json(await ownerCreate(fixture, createBody("minimal", {
      entity_slug: "family-home",
      legal_name: "Fixture Family",
    })));
    assert.equal(result.response.status, 201);
    assertPrivate(result.response);
    assert.deepEqual(result.body, {
      request_id: "minimal",
      entity_scope: { entity_slug: "family-home" },
      entity: {
        entity_slug: "family-home",
        legal_name: "Fixture Family",
        label: "Fixture Family",
        kind: "household",
        parent_entity_slug: null,
        ownership_bp: null,
      },
      changed: true,
      activity_event_id: "evt_entity_created_minimal",
      replayed: false,
    });
    assert.deepEqual({ ...fixture.first(
      `SELECT tenant_id,entity_slug,legal_name,display_label,kind,status,relationship,
              parent_entity_slug,ownership_bp,fixed_scope,provenance,basis_state
         FROM fin_entities WHERE entity_slug='family-home'`,
    ) }, {
      tenant_id: "primary", entity_slug: "family-home", legal_name: "Fixture Family",
      display_label: null, kind: "household", status: "active", relationship: "owned",
      parent_entity_slug: null, ownership_bp: null, fixed_scope: 0,
      provenance: "owner_stated", basis_state: "confirmed",
    });
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id='minimal'").n, 1);
    assert.deepEqual({ ...fixture.first(
      "SELECT event_type,entity_slug,subject_kind,subject_id,display_label FROM owner_activity_events WHERE request_id='minimal'",
    ) }, {
      event_type: "entity_created", entity_slug: "family-home", subject_kind: "entity",
      subject_id: "family-home", display_label: "Fixture Family",
    });
  } finally {
    fixture.close();
  }
});

test("all ledger entity kinds work and optional ownership metadata requires a safe active owned parent", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "family", "Fixture Family");
    seedCounterparty(fixture, "outside-party");
    seedOwnedEntity(fixture, "closed-parent", "Closed Parent");
    fixture.raw("UPDATE fin_entities SET status='closed' WHERE entity_slug='closed-parent'");

    for (const kind of ["person", "household", "business", "trust", "property", "investment"]) {
      const slug = `kind-${kind}`;
      const result = await json(await ownerCreate(fixture, createBody(`kind_${kind}`, {
        entity_slug: slug,
        legal_name: `Fixture ${kind}`,
        display_label: `My ${kind}`,
        kind,
        parent_entity_slug: "family",
        ownership_bp: 7500,
      })));
      assert.equal(result.response.status, 201, kind);
      assert.equal(result.body.entity.kind, kind);
      assert.equal(result.body.entity.parent_entity_slug, "family");
      assert.equal(result.body.entity.ownership_bp, 7500);
    }

    for (const [requestId, overrides, code] of [
      ["bad_kind", { kind: "other" }, "invalid_entity_kind"],
      ["bad_slug", { entity_slug: "Not A Slug" }, "invalid_entity_slug"],
      ["bad_name", { legal_name: "   " }, "invalid_entity_legal_name"],
      ["bad_label", { display_label: "x".repeat(161) }, "invalid_entity_display_label"],
      ["bad_bp", { parent_entity_slug: "family", ownership_bp: 10001 }, "invalid_entity_ownership_bp"],
      ["bp_without_parent", { ownership_bp: 5000 }, "ownership_requires_parent"],
      ["self_parent", { entity_slug: "self-parent", parent_entity_slug: "self-parent" }, "entity_parent_self"],
      ["missing_parent", { parent_entity_slug: "missing" }, "entity_parent_not_found"],
      ["counterparty_parent", { parent_entity_slug: "outside-party" }, "entity_parent_not_active_owned"],
      ["closed_parent", { parent_entity_slug: "closed-parent" }, "entity_parent_not_active_owned"],
    ]) {
      const result = await json(await ownerCreate(fixture, createBody(requestId, overrides)));
      assert.equal(result.response.status, 400, requestId);
      assert.equal(result.body.code, code, requestId);
    }

    fixture.raw(
      `INSERT INTO fin_entities
         (tenant_id,entity_slug,legal_name,kind,status,relationship,parent_entity_slug,
          provenance,basis_state,recorded_at)
       VALUES
         ('primary','cycle-a','Cycle A','household','active','owned','cycle-b','owner_stated','confirmed','2026-01-01'),
         ('primary','cycle-b','Cycle B','household','active','owned','cycle-a','owner_stated','confirmed','2026-01-01')`,
    );
    const cycle = await json(await ownerCreate(fixture, createBody("cycle", {
      entity_slug: "cycle-child", parent_entity_slug: "cycle-a",
    })));
    assert.equal(cycle.response.status, 409);
    assert.equal(cycle.body.code, "entity_parent_cycle");
  } finally {
    fixture.close();
  }
});

test("create is idempotent, never overwrites a slug, and keeps failed batches empty", async () => {
  const fixture = await createProductFixture();
  try {
    const body = createBody("stable_create", {
      entity_slug: "stable-entity", legal_name: "Stable Entity", kind: "business",
    });
    const first = await json(await ownerCreate(fixture, body));
    const replay = await json(await ownerCreate(fixture, body));
    assert.equal(first.response.status, 201);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_entities WHERE entity_slug='stable-entity'").n, 1);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM owner_activity_events WHERE request_id='stable_create'").n, 1);

    const requestConflict = await json(await ownerCreate(fixture, { ...body, legal_name: "Different" }));
    assert.equal(requestConflict.response.status, 409);
    assert.equal(requestConflict.body.code, "request_id_conflict");
    const slugConflict = await json(await ownerCreate(fixture, { ...body, request_id: "different_request" }));
    assert.equal(slugConflict.response.status, 409);
    assert.equal(slugConflict.body.code, "entity_already_exists");
    assert.equal(fixture.first("SELECT legal_name FROM fin_entities WHERE entity_slug='stable-entity'").legal_name, "Stable Entity");

    fixture.control.failNextBatch = true;
    const failed = await json(await ownerCreate(fixture, createBody("batch_failure", {
      entity_slug: "must-not-land",
    })));
    assert.equal(failed.response.status, 503);
    assert.equal(failed.body.code, "entity_create_unavailable");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_entities WHERE entity_slug='must-not-land'").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id='batch_failure'").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM owner_activity_events WHERE request_id='batch_failure'").n, 0);
  } finally {
    fixture.close();
  }
});

test("entity create rechecks the complete owned parent lineage in its commit transaction", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, "cycle-parent", "Cycle Parent");
    const { handleOwnerActions } = await loadOwnerActions(fixture.productRoot);
    const headers = await fixture.ownerHeaders();
    const directCreate = (body, beforeEntityCreateCommit) => handleOwnerActions(
      fixture.env,
      new Request(`https://brain.invalid${PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      PATH,
      { beforeEntityCreateCommit },
    );

    const cycle = await json(await directCreate(createBody("lineage_cycle", {
      entity_slug: "cycle-child",
      parent_entity_slug: "cycle-parent",
    }), async () => {
      fixture.raw(
        "UPDATE fin_entities SET parent_entity_slug='cycle-child' WHERE entity_slug='cycle-parent'",
      );
    }));
    assert.equal(cycle.response.status, 503);
    assert.equal(cycle.body.code, "entity_create_unavailable");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_entities WHERE entity_slug='cycle-child'").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id='lineage_cycle'").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM owner_activity_events WHERE request_id='lineage_cycle'").n, 0);

    seedOwnedEntity(fixture, "lineage-root", "Lineage Root");
    seedOwnedEntity(fixture, "lineage-parent", "Lineage Parent");
    fixture.raw(
      "UPDATE fin_entities SET parent_entity_slug='lineage-root' WHERE entity_slug='lineage-parent'",
    );
    const retiredAncestor = await json(await directCreate(createBody("lineage_retired", {
      entity_slug: "lineage-child",
      parent_entity_slug: "lineage-parent",
    }), async () => {
      fixture.raw("UPDATE fin_entities SET status='closed' WHERE entity_slug='lineage-root'");
    }));
    assert.equal(retiredAncestor.response.status, 503);
    assert.equal(retiredAncestor.body.code, "entity_create_unavailable");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_entities WHERE entity_slug='lineage-child'").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id='lineage_retired'").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM owner_activity_events WHERE request_id='lineage_retired'").n, 0);
  } finally {
    fixture.close();
  }
});

test("upgrade pause and competing create choices fail closed", async () => {
  const fixture = await createProductFixture();
  try {
    fixture.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
    const paused = await json(await ownerCreate(fixture, createBody("paused", { entity_slug: "paused-entity" })));
    assert.equal(paused.response.status, 503);
    assert.equal(paused.body.code, "owner_writes_paused");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_entities").n, 0);

    delete fixture.env.VECTOR_DRAIN_MODE;
    const { handleOwnerActions } = await loadOwnerActions(fixture.productRoot);
    const headers = await fixture.ownerHeaders();
    let waiting = 0;
    let release;
    const bothAtCommit = new Promise((resolve) => { release = resolve; });
    const beforeEntityCreateCommit = async () => {
      waiting++;
      if (waiting === 2) release();
      await bothAtCommit;
    };
    const directCreate = (body) => handleOwnerActions(
      fixture.env,
      new Request(`https://brain.invalid${PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      PATH,
      { beforeEntityCreateCommit },
    );
    const [one, two] = await Promise.all([
      directCreate(createBody("choice_one", { entity_slug: "one-choice" })),
      directCreate(createBody("choice_two", { entity_slug: "one-choice" })),
    ]);
    assert.equal(waiting, 2, "both choices passed preflight before either commit began");
    assert.deepEqual([one.status, two.status].sort(), [201, 409]);
    const loser = one.status === 409 ? one : two;
    assert.equal((await loser.json()).code, "entity_already_exists");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_entities WHERE entity_slug='one-choice'").n, 1);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM owner_activity_events WHERE entity_slug='one-choice'").n, 1);
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id IN ('choice_one','choice_two')",
    ).n, 1);
  } finally {
    fixture.close();
  }
});

import assert from "node:assert/strict";
import worker from "../src/index.js";

/* A paused brain refuses ingest on eight write paths. Reporting ok:true through
   that is what turned one client's failed update into eight days of silence: they
   added nothing, and nothing told them anything was wrong. These tests exist so that
   cannot come back. */

const base = { BRAIN_NAME: "fixture-client", BRAIN_VERSION: "0.1.18" };
const health = async (env) => {
  const res = await worker.fetch(new Request("https://b.example/health"), env, {});
  return { res, body: await res.json() };
};

/* ---------------- an active brain reports ok */

{
  const { res, body } = await health({ ...base });
  assert.equal(res.status, 200);
  assert.equal(body.ok, true, "an unpaused brain is ok");
  assert.equal(body.status, "ok");
  assert.equal(body.accepting_documents, true);
  assert.equal(body.vector_drain_mode, "active");
}

/* ---------------- a paused brain says so, in the field that monitors read */

{
  const { res, body } = await health({ ...base, VECTOR_DRAIN_MODE: "paused-for-upgrade" });
  assert.equal(
    body.ok, false,
    "a brain that cannot accept a document must not report ok:true",
  );
  assert.equal(body.status, "paused-for-upgrade");
  assert.equal(body.accepting_documents, false);
  assert.match(body.reason, /cannot accept documents/i, "the reason is plain language");
  assert.match(body.reason, /did not finish/i, "it names the cause, a partial update");

  // Deliberate: update's own paused-mode probe must still succeed while the
  // pause is in force, so the HTTP status stays 200 and only the body tells
  // the truth. Changing this to 503 breaks brain update.
  assert.equal(
    res.status, 200,
    "HTTP stays 200 so update's paused-mode health probe still passes",
  );
}

/* ---------------- the fields update depends on survive both ways */

for (const env of [{ ...base }, { ...base, VECTOR_DRAIN_MODE: "paused-for-upgrade" }]) {
  const { body } = await health(env);
  // Health reports the version of the CODE answering, not the deploy-time
  // variable. The variable can outlive the code it described, and on one brain
  // it did so by two releases for months while every probe looked healthy. The
  // two callers that match on this field, setup's already-live refusal and
  // verifyRollbackHealth's expectVersion, both compare against the package
  // version, so reporting the code's own version is what makes them mean
  // anything.
  assert.equal(body.version, "0.4.4", "health reports the worker's own version");
  assert.equal(body.configured_version, "0.1.18", "a disagreeing deploy-time variable is surfaced");
  assert.equal(body.version_mismatch, true, "and the disagreement is named rather than hidden");
  assert.equal(body.vector_writer_protocol, "lease-v1", "cmdHealth matches on protocol");
  assert.ok(body.vector_drain_mode, "cmdHealth matches on drain mode");
}

/* ---------------- an unknown drain mode is not treated as paused */

{
  const { body } = await health({ ...base, VECTOR_DRAIN_MODE: "something-else" });
  assert.equal(body.ok, true, "only the exact paused sentinel means paused");
  assert.equal(body.vector_drain_mode, "active");
}

console.log("health honesty: all focused offline tests passed");

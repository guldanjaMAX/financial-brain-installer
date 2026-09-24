/**
 * Agreement enumeration for the financial-document writer.
 *
 * documentCreate mirrors migration 0017's paired CHECK constraints in app code so
 * an owner reads "have_it needs a filed date" instead of an opaque 503. That
 * mirroring is a CLAIM. A test that re-states the rules proves only the
 * restatement, so this drives both sides from one enumeration — the REAL route
 * (through the owner fixture, with a real session) and the REAL DDL — and
 * asserts agreement in both directions.
 *
 * The direction that matters is the second: a validator stricter than the schema
 * is safe; one that is looser lets a constraint failure reach an owner as an
 * outage.
 *
 * The first version of this file authenticated as nobody and scored 1290/1440
 * "agreement" while every request was a 401 that never reached the validator.
 * Hence the control below, which runs first and refuses to continue if a plainly
 * valid row does not come back 201.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createProductFixture, loadOwnerActions, json } from "./product-contract-fixture.mjs";

const PATH = "/api/owner/documents/create";

const KINDS = ["statement", "tax_return", "will", "bogus_kind"];
const CUSTODY = ["reference", "reconcilable", "bogus"];
const AVAIL = ["have_it", "can_get_it", "do_not_have_it", "bogus"];
const FILED = [null, "2026-01-31", "31-01-2026"];
const FROM = [null, "the accountant"];
const CORPUS = [null, "drive:abc123"];
const RECON = [null, "2026-06-30"];

test("the validator and the schema agree, and the validator is never looser", async () => {
  const fixture = await createProductFixture();
  try {
    const { handleOwnerActions } = await loadOwnerActions(fixture.productRoot);
    const headers = await fixture.ownerHeaders();
    const call = (body) => handleOwnerActions(
      fixture.env,
      new Request(`https://brain.invalid${PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      PATH,
    );

    // CONTROL. If this is not 201 the enumeration below measures nothing.
    const control = await call({
      request_id: "control-row", fin_doc_uid: "control-doc",
      doc_kind: "statement", title: "Control", custody_class: "reference",
      availability: "have_it", filed_at: "2026-01-31",
    });
    assert.equal(control.status, 201,
      `CONTROL FAILED — a plainly valid row was refused: ${JSON.stringify(await json(control))}`);

    // CONTROL 2, on the probe arm. Last run this arm threw on every row and
    // scored it as "the database refused". A control on one arm is not a control.
    let probeWorks = true;
    try {
      fixture.sqlite.prepare(
        `INSERT INTO fin_documents
           (tenant_id, fin_doc_uid, doc_kind, title, custody_class, availability,
            filed_at, readable, restricted, provenance, basis_state, recorded_at)
         VALUES ('primary','probe-control','statement','C','reference','have_it',
                 '2026-01-31',1,0,'owner_stated','confirmed','2026-09-23T00:00:00Z')`,
      ).run();
    } catch (e) { probeWorks = false; console.log("probe control threw:", e.message); }
    assert.ok(probeWorks, "PROBE CONTROL FAILED — the DDL arm cannot insert a valid row");

    let n = 0, cases = 0, agreed = 0;
    const looser = [];
    const stricter = [];

    for (const doc_kind of KINDS)
    for (const custody_class of CUSTODY)
    for (const availability of AVAIL)
    for (const filed_at of FILED)
    for (const available_from of FROM)
    for (const corpus_doc_uid of CORPUS)
    for (const reconciled_through of RECON) {
      n++;
      const row = {
        request_id: `r${n}`, fin_doc_uid: `d${n}`, doc_kind, title: `T${n}`,
        custody_class, availability,
        ...(filed_at ? { filed_at } : {}),
        ...(available_from ? { available_from } : {}),
        ...(corpus_doc_uid ? { corpus_doc_uid } : {}),
        ...(reconciled_through ? { reconciled_through } : {}),
      };
      cases++;
      const res = await call(row);
      const accepted = res.status === 201;

      // The same row, straight at the DDL, through the fixture's own database.
      let dbAccepts = true;
      try {
        fixture.sqlite.prepare(
          `INSERT INTO fin_documents
             (tenant_id, fin_doc_uid, doc_kind, title, custody_class, availability,
              available_from, filed_at, reconciled_through, corpus_doc_uid,
              readable, restricted, provenance, basis_state, recorded_at)
           VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'owner_stated','confirmed', ?)`,
        ).run(`probe${n}`, doc_kind, "T", custody_class, availability,
              available_from, filed_at, reconciled_through, corpus_doc_uid,
              "2026-09-23T00:00:00Z");
      } catch { dbAccepts = false; }

      if (accepted === dbAccepts) agreed++;
      else if (accepted) looser.push({ ...row, db: "refused" });
      else stricter.push({ ...row, code: (await json(res))?.code });
    }

    console.log(`enumerated ${cases}; agreement ${agreed}/${cases}`);
    console.log(`validator stricter than the schema (safe): ${stricter.length}`);
    console.log(`validator LOOSER than the schema (503 reaches the owner): ${looser.length}`);
    for (const l of looser.slice(0, 8)) console.log("  LOOSER", JSON.stringify(l));

    assert.equal(looser.length, 0,
      `the validator accepts rows the schema refuses: ${JSON.stringify(looser.slice(0, 3))}`);
  } finally {
    fixture.close?.();
  }
});

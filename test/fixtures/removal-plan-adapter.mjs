import { createHash } from "node:crypto";

// Existing connector fixtures model one physical row per family. Keep their
// deletion assertions and failures, while exposing the new two-phase route.
// The real multi-member and transaction-fence tests use SQLite instead.
export function installRemovalPlanAdapter({ inventory, revision, record = () => {} }) {
  const original = globalThis.fetch;
  const marker = () => ({ instance: "fixture", runtime: "fixture-runtime",
    generation: revision(), nonce: createHash("sha256").update(JSON.stringify(inventory())).digest("hex") });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "fixture.invalid" || url.pathname !== "/api/admin/brain/ingest-removal-plan") {
      return original(input, options);
    }
    const body = JSON.parse(options.body);
    record(body.action);
    const current = marker();
    if (body.marker && JSON.stringify(body.marker) !== JSON.stringify(current)) {
      return Response.json({ error: "fixture inventory changed" }, { status: 409 });
    }
    if (body.action === "preview") {
      const targets = [...new Set(body.families.flatMap((family) => inventory().filter((uid) =>
        (uid === family.base_doc_uid || uid.startsWith(`${family.base_doc_uid}#part`)) &&
        !family.keep_doc_uids.includes(uid))))].sort();
      return Response.json({ marker: current, targets, documents: targets.length });
    }
    const response = await original(new URL("/api/admin/brain/forget", url).href, {
      ...options, body: JSON.stringify({ confirm: true,
        families: body.targets.map((uid) => ({ base_doc_uid: uid, keep_doc_uids: [], family_kind: "structural" })) }),
    });
    if (!response.ok) return response;
    const receipt = await response.json();
    return Response.json({ marker: marker(), documents: receipt.documents });
  };
}

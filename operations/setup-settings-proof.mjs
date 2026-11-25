// Pure metadata proof. Never accept a route or a retained secret as evidence
// that an upload will keep the same database, runtime identity, or write fence.
export function proveSetupSettings({ settings, expectedBindings, health, slug, activeSecretNames = [], retainedSecretNames = [] }) {
  const fail = () => { throw new Error("existing Worker settings proof did not match"); };
  if (!health || health.brain !== slug || typeof health.version !== "string" || !health.version) fail();
  if (!Array.isArray(settings?.bindings)) fail();
  const actual = new Map();
  for (const row of settings.bindings) {
    if (!row || typeof row.name !== "string" || !row.name || actual.has(row.name)) fail();
    actual.set(row.name, row);
  }
  const expected = new Map(expectedBindings.map(row => [row.name, row]));
  if (expected.get("DB")?.type !== "d1" || typeof expected.get("DB").id !== "string" || !expected.get("DB").id) fail();
  // Health's code version is authoritative, including on an older Worker.
  expected.set("BRAIN_VERSION", { type: "plain_text", name: "BRAIN_VERSION", text: health.version });
  for (const [name, row] of expected) {
    const live = actual.get(name);
    if (!live || live.type !== row.type) fail();
    for (const field of ["id", "index_name", "text"]) {
      if (row[field] !== undefined && live[field] !== row[field]) fail();
    }
  }
  const fence = actual.get("VECTOR_ROLLBACK_FENCE");
  if (fence && (fence.type !== "plain_text" || fence.text !== "0")) fail();
  const mode = actual.get("VECTOR_DRAIN_MODE");
  if (mode && (mode.type !== "plain_text" || mode.text !== "active")) fail();
  for (const [name, row] of actual) {
    if (expected.has(name) || name === "VECTOR_ROLLBACK_FENCE" || name === "VECTOR_DRAIN_MODE") continue;
    // Upload preserves secret_text bindings. Disabled or removed connectors
    // leave inert names behind; neither their presence nor value is identity.
    if (name.startsWith("CUSTOM_API_TOKEN_")) {
      if (!/^CUSTOM_API_TOKEN_[A-Z0-9_]{1,40}$/.test(name) || row.type !== "secret_text") fail();
    } else if (!retainedSecretNames.includes(name) || row.type !== "secret_text") fail();
  }
  for (const name of activeSecretNames) {
    if (actual.get(name)?.type !== "secret_text") fail();
  }
  return Object.freeze({ proven: true });
}

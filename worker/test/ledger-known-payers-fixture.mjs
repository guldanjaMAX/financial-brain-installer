// Independent fixture authority, declared before receipts. Never derive this
// list from a bank payee or description: that would bypass the identity gate.
export function seedKnownPayers(fixture, names, now) {
  for (const [index, name] of names.entries()) fixture.raw(
    `INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
     VALUES (?,?,'business','owned','owner_stated','confirmed',?)`, `known-payer-${index}`, name, now);
}

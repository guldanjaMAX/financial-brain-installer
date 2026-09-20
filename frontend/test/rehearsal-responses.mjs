/**
 * Keep each rehearsal screen on one synthetic truth set. A scenario that says
 * the Brain has read no records must not answer from the populated fixture when
 * the owner moves from Home to Explore.
 */
export function ownerThinkResponse(scenario, entitySlug = null) {
  const entityScope = { entity_slug: entitySlug || null, applied: Boolean(entitySlug) };
  if (scenario === "empty") {
    return {
      answer: null,
      status: "no_results",
      entity_scope: entityScope,
      citations: [],
      results: [],
      gaps: [{
        type: "no_results",
        detail: "This local rehearsal contains no records for the question.",
      }],
    };
  }
  return {
    answer: "Mesa Coffee has one confirmed cash figure as of July 31. [1] The rental account is not included because no confirmed figure is recorded.",
    entity_scope: entityScope,
    degraded: entitySlug ? "vector" : undefined,
    degraded_reason: entitySlug ? "entity-vector-authority-unindexed" : undefined,
    confidence: {
      percent: 86,
      band: "high",
      basis: [
        "Strongest evidence is T1 primary: named like an authoritative record (statement)",
        "One known account is explicitly missing",
      ],
    },
    citations: [{
      n: 1,
      title: "Mesa Coffee checking, July 2026",
      source: "drive",
      ts: "2026-07-31",
      authority: {
        tier: "T1",
        rank: 1,
        name: "primary",
        reason: "named like an authoritative record (statement)",
        eligible: true,
        authoritative: true,
      },
    }],
  };
}

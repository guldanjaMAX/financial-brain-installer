export class BankProviderTransitionError extends Error {
  constructor() {
    super("Bank provider writes are paused while a reviewed provider transition finishes.");
    this.name = "BankProviderTransitionError";
    this.code = "BANK_PROVIDER_TRANSITION_FENCED";
    this.status = 503;
  }
}

/** One durable rule shared by every provider-specific mutation path. */
export async function assertBankProviderTransitionAllows(env, provider) {
  const state = await env.DB.prepare(
    `SELECT transition_target FROM bank_provider_runtime_state
      WHERE id=1 AND transition_target IS NOT NULL`,
  ).first();
  if (state?.transition_target && state.transition_target !== provider) {
    throw new BankProviderTransitionError();
  }
  return true;
}

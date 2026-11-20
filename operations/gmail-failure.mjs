// Provider exceptions can contain message text, account details and credentials.
// The public command boundary renders only this product-owned copy. Structured
// operation/status evidence has already been recorded by the runner.
export function gmailFailureMessage(error) {
  // Match fixed local diagnostics exactly; never interpolate an exception.
  // A bad saved window needs repair, not an indefinite reconnect/retry loop.
  if (error?.message === "saved Gmail batch window is invalid; the history cursor was kept") {
    return "Gmail refresh did not finish: the saved Gmail batch window is invalid; the history cursor was kept. " +
      "Ask your installer to repair the saved work, then retry. " +
      "Code: INGEST_FAILED. Help: https://financialbrain.ai/help/INGEST_FAILED";
  }
  return "Gmail refresh did not finish. Accepted work is saved and stored email was kept. " +
    "Check the sync settings and Google connection, then retry the refresh. " +
    "Code: INGEST_FAILED. Help: https://financialbrain.ai/help/INGEST_FAILED";
}

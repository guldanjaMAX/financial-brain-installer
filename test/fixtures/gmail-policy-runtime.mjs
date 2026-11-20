// This CLI fixture models provider and D1 state, not an installed dependency
// closure. Inject the existing runtime seam for this synthetic mailbox only.
// Production runtime hashing and its link refusal remain unchanged.
import { registerHooks } from 'node:module';
if (!process.env.BRAIN_GMAIL_POLICY_MODE || process.env.BRAIN_GOOGLE_TOKEN_STORE !== 'file') {
  throw new Error('Synthetic Gmail runtime fixture is not configured');
}
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/operations/ingest-removal-plan.mjs')) return result;
  const source = String(result.source);
  const target = 'request = requestIngestRemovalPlan, runtime = ingestRemovalRuntime,';
  if (source.split(target).length !== 2) throw new Error('Synthetic runtime seam missing or ambiguous');
  return { ...result, source: source.replace(target,
    'request = requestIngestRemovalPlan, runtime = () => "synthetic-gmail-runtime",') };
} });

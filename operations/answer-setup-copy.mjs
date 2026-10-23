/**
 * Reviewed owner-facing copy for the optional Anthropic answer setup.
 *
 * Keep this module free of credentials and instance data. Callers substitute
 * only the manifest locator, cap, reset time, and resolved model identifiers.
 */

export const ANTHROPIC_CONSOLE_URL = "https://platform.claude.com/";

export const UPDATE_FIRST = (manifest) =>
  `Your Brain is on an older version than this installer. Update it first with: brain update ${manifest}. Nothing was changed.`;
export const KEY_SHAPE = "That does not look like an Anthropic API key. If the key window is still open in the Claude Console, click Copy again and rerun the same command. Otherwise create a new key there, or use --key-set-in-dashboard to enter it in Cloudflare's masked secret field. Nothing was changed.";
export const KEY_REJECTED = "Anthropic did not accept this key. In the Claude Console (API keys), create a new key named Financial Brain, click Copy, and rerun the same command. You can delete the earlier key there. Nothing was changed.";
export const BILLING = "Your Anthropic account needs credit before it can answer. Add credit in the Claude Console (Billing), then click Copy again in the key window, or create a new key, and rerun the same command. Nothing was changed.";
export const MODEL_UNAVAILABLE = "Your Anthropic account cannot use Claude Opus or Claude Sonnet yet. Check the account in the Claude Console, then copy the key again and rerun the same command. Nothing was changed.";
export const BUSY = "Anthropic is busy right now, or this account reached its per-minute limit (new accounts start low). Wait a minute, click Copy again in the key window, and rerun the same command. Nothing was changed.";
export const UNREACHABLE = "This computer could not reach Anthropic. Check the internet connection, click Copy again in the key window, and rerun the same command. Nothing was changed.";
export const CHECK_FAILED = "Anthropic refused the test message for a reason this installer does not recognize. Nothing was changed. Support code: ANTHROPIC_CHECK_FAILED.";
export const CHECK_PROBLEM = "The answer model check could not be read completely. Your current answer setup was kept. In a few minutes, run the same check again. Support code: ANTHROPIC_CHECK_FAILED.";
export const CLIPBOARD_CLEAR_WARNING = "Claude answers are connected, but this command could not clear the clipboard. Clear it now before closing the key window; a clipboard history app may still keep a copy.";
export const ROLLED_BACK_BUILT_IN = "Your Brain could not answer with Claude using this key, so it was put back on the built-in model. Fix the item below, then rerun the same command.";
export const ROLLED_BACK_PREVIOUS = "The change could not be finished, so your Brain was put back exactly as it was. Fix the item below, then rerun the same command.";
export const ROLLBACK_INCOMPLETE = (manifest) =>
  `Your Brain could not be put back automatically. To return it to the built-in model, run: brain disconnect anthropic ${manifest}`;
export const CHECK_PENDING = (manifest) =>
  `Your key works, but your Brain's own test could not finish yet. In a few minutes, run: brain connect anthropic ${manifest} --keep-key`;
export const LIMIT_ALREADY_REACHED = (manifest, reset) =>
  `Claude is connected, but today's spending limit is already used, so answers start again at ${reset}. To raise the limit, run: brain connect anthropic ${manifest} --keep-key --daily-cap <usd>`;
export const HALF_RUN = (manifest) =>
  `An earlier answer setup stopped halfway. To finish safely, run: brain disconnect anthropic ${manifest}. Then set it up again.`;
export const KEEP_KEY_MISSING = (manifest) =>
  `No Anthropic key is stored in this Brain yet. Copy a key from the Claude Console and run: brain connect anthropic ${manifest} --from-clipboard`;
export const DASHBOARD_STEPS = "In Cloudflare, open your Brain's Worker, then Settings, Variables and Secrets, Add. Choose Secret, name it ANTHROPIC_API_KEY, paste the key and click Save. Then rerun the same command. Nothing was changed.";
export const DAILY_RECONCILE_FAILED = (manifest) =>
  `Daily imports need one more step after this change. Run: brain daily on ${manifest}`;
export const INSECURE_PROMPT = "This window cannot ask for the key privately. Copy the key, then run: brain connect anthropic <manifest> --from-clipboard";
export const MODEL_NOT_REVIEWED = ({ field, id, manifest }) =>
  `retrieval.${field} is set to ${id}, which this installer has not reviewed. Nothing was changed. First run brain disconnect anthropic ${manifest} to return to the built-in model. Then, if the owner wants the recommended setup, run brain connect anthropic ${manifest} --from-clipboard.`;
export const ENV_IGNORED = (manifest) =>
  `ANTHROPIC_API_KEY in this terminal was ignored. To connect Claude answers, run: brain connect anthropic ${manifest} --from-clipboard`;
export const HEALTH_KEY_MISSING = "Answers are paused: this Brain is set to answer with Claude, but its Anthropic key is missing.";
export const HEALTH_NEXT_STEP = (manifest) => `Next: brain connect anthropic ${manifest} --from-clipboard`;
export const CONSOLE_REVOKE_LINE = "The Anthropic key was removed from your Brain. It still works in your Anthropic account until you delete it there: Claude Console, API keys.";
export const KEY_KEPT_FOR_RERANK = "The Anthropic key stays in your Brain because reranking still uses it.";
export const DISCONNECT_LINE = "Your Brain now answers with the built-in Cloudflare model.";

export function DONE_LINES({ cap, reset, clipboard = false }) {
  return [
    "Done. Claude Opus now writes your answers and Claude Sonnet checks them, on your own Anthropic account.",
    `Daily limit: $${cap}, resetting at ${reset} each day. Your Brain keeps the key only as a secret inside your Brain.`,
    ...(clipboard ? ["Your clipboard was cleared (a clipboard history app may still keep a copy). You can close the key window now."] : []),
  ];
}

export const SETUP_BUILT_IN = "Answer setup: built-in Cloudflare model (no Anthropic key needed). Check the sources before relying on an answer.";
export const SETUP_RECOMMENDED = "Answer setup: Opus answers, Sonnet checks (your Anthropic account)";
export const SETUP_CUSTOM = (answerModel, gateModel) =>
  `Answer setup: custom (answers: ${answerModel}, checks: ${gateModel})`;
export const RECOVERY_KEY_LINE = (manifest) =>
  `This Brain answers with Claude. Reconnect its Anthropic key with: brain connect anthropic ${manifest} --from-clipboard`;

export const GAP_DETAIL = "Answers are paused until the Anthropic key is reconnected.";

export const TECHNICIAN_ANTHROPIC_COPY = Object.freeze({
  title: "Choose who writes your answers",
  human_boundary: "Before approval, give the owner one decision: Opus answers, Sonnet checks on their own Anthropic account (recommended), or keep the built-in model. The owner signs in to the Claude Console and approves any billing. Before the key is created, ask the owner to stop any screen share and pause any recording. The owner clicks Create and Copy, keeps the key window open until the command finishes, then closes it. The assistant may navigate, type the key name and read the Data retention page; it stops if the Development Partner Program button does not read Join or HIPAA is on, and it never reads, screenshots or pastes the key.",
  automated_proof: "Before changing anything, the connect command checks the key with Anthropic (a free model list and two tiny test messages). It then writes both models and the daily limit, keeps daily imports registered, stores the key as a Worker secret and reads its name back, deploys, and has the Worker test both models with the stored key. The four test messages together cost under one cent. A key that fails puts the built-in model back.",
  before_action: "Anthropic's Claude Console will open. After you sign in, I will check two privacy settings and then open the page for creating an API key. If you are sharing your screen or recording, I will ask you to stop before the key appears.",
  why: "With your own Anthropic key, Claude Opus writes each answer and Claude Sonnet checks it against your records before you see it. In our testing it tied for the fewest wrong answers of every setup we tried, at a lower cost than the one setup that answered slightly more.",
  minimum_access: "One API key named Financial Brain, used only by your Brain. It cannot change your Anthropic account, billing or other keys. Your Brain's daily limit stops answers for the day once its estimated spend reaches the limit; it does not limit the key itself.",
  browser_help: "I can open the Console, find the right pages, read the privacy settings and type the key's name. I stop before anything you sign, pay for or reveal.",
  owner_only: "You sign in, add a card or credit if Anthropic asks, then click Create and Copy and keep the key window open. Approve one command, then close the key window when I say it worked.",
  privacy: "I never see the key. The command reads it from your clipboard, stores it only as a secret inside your Brain and clears your clipboard (a clipboard history app may keep a copy). For each question, your Brain sends Anthropic your question, your name as the Brain's owner, and about a dozen of the best-matching record excerpts with their titles and dates. Anthropic's commercial terms do not allow it to train on them. It deletes them within 30 days, except content its safety checks flag (kept up to 2 years) or where the law requires longer.",
});
export const RULE_LINE = "Keep Anthropic API keys out of chat, commands, files and screenshots. The connect command reads the key from the clipboard, stores it as a Worker secret and clears the clipboard.";

export const SKILL_CONSOLE_PARAGRAPH = "Anthropic Console (answer setup). With approval and browser control, open the Claude Console, navigate, read the Data retention settings, and on API keys start Create Key and type the name Financial Brain. Confirm the Development Partner Program button reads Join and HIPAA is off; if either differs, stop and explain. If the owner is sharing a screen or recording a call, ask them to stop sharing and pause the recording before the key is created, and to resume only after the key window is closed. The owner signs in, approves billing or credit, clicks Create and Copy, and keeps the key window open until the command reports success; then the owner closes it. Do not look at the screen while the key window is open. Never read, screenshot, transcribe or paste the key; a key that appears in chat, a screenshot or a recording is exposed and must be deleted in the Console and replaced.";
export const SKILL_WINDOWS_LINE = "The Anthropic answer step is the exception on Windows: it uses the reviewed clipboard route (--from-clipboard, cleared afterwards) or the masked Cloudflare dashboard field (--key-set-in-dashboard), never a hidden prompt.";
export const SKILL_DECISION_STEP = "After the smoke step on install day, give the owner one decision with your pick, using the decision text below: Opus answers, Sonnet checks (recommended), or keep the built-in model. Fill in the reset time in the owner's time zone. On yes, follow the Anthropic Console paragraph, then run the plan's anthropic command with a 10-minute Bash timeout. On no, move on and do not offer it again.";
export const SKILL_DECISION_TEXT = `Before we connect your sources, one choice: who writes your Brain's answers.

My pick: Opus answers, Sonnet checks. Claude Opus writes each answer from your records, and Claude Sonnet checks it before you see it. It runs on your own Anthropic account and card. We never see your key or pay for it. In our testing Claude Opus was the clear winner: none of the 48 answers this setup gave was graded wrong, though about 1 in 10 had a small mistaken detail. It is not a guarantee, so every answer still shows its sources.

Cost: each Brain answer costs about 5.5 cents. At 5 to 20 questions a day that is roughly $8 to $33 a month, up to double when a question needs a retry. Your Brain stops answering for the day if its estimated spend reaches $5, and starts again at <reset time in your time zone>.

Privacy: for each question, your Brain sends Anthropic your question, your name, and about a dozen matching record excerpts. Under its commercial terms Anthropic may not train on them. It deletes them within 30 days, except content its safety checks flag (up to 2 years) or where the law requires longer.

The other choice is the built-in Cloudflare model: no second account and almost no cost, but in the same test 16 of its 43 answers were wrong.

If you say yes, your part is: sign in to Anthropic, add a card if it asks, click Create and Copy when I say, and approve one command. I do the rest. Shall I set it up?`;
export const SKILL_ON_REQUEST = "For an existing Brain, set up Claude answers only when the owner asks for it, for example 'set up Claude answers'. Never offer it on your own after an update. An update never changes the answer model.";
export const SKILL_CREDENTIAL_LINE = "Anthropic API keys: entered only through brain connect anthropic (clipboard or the masked Cloudflare field). Never in chat, an environment variable, a command argument or a file.";

export const CONTRACT_SECTION = `## If answers are paused
- If a gap has type anthropic_key_missing, tell the owner once that answers are paused until the Anthropic key is reconnected, and offer to run {{CONNECT_COMMAND}} after they copy a new key. brain_search still works meanwhile.
- If answer_error says the Anthropic account needs attention, say once that the key was not accepted or the credit ran out, and offer to open the Claude Console. Do not retry the same question.
- If answer_error says today's spending limit was reached, give the time answers start again in the owner's own time zone (answer_resumes_at, which is midnight UTC), and say the limit can be raised with {{CAP_COMMAND}}. The same limit also covers reading scanned pages. Do not retry.
- If answer_error says answers are paused for a few minutes, wait a few minutes before asking again.`;
export const MONEY_RULES_LINE = "If answer_error says answers are paused or today's spending limit was reached, skip only the CLI fallback for that question and say when answers start again. The ledger templates keep working through brain_think, so continue using them for supported money questions.";


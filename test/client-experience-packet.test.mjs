import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKET = join(ROOT, "onboarding", "client-experience");
const names = [
  "README.md",
  "TECHNICIAN-RUNBOOK.md",
  "ACCEPTANCE-AND-HANDOFF.md",
  "SUPPORT-AND-OFFLINE.md",
  "DATA-PROTECTION-DRAFT.md",
];
const documents = Object.fromEntries(names.map((name) => [name, readFileSync(join(PACKET, name), "utf8")]));
const all = Object.values(documents).join("\n");
const preInterview = readFileSync(join(ROOT, "onboarding", "00-pre-install-interview.md"), "utf8");
const intake = readFileSync(join(ROOT, "onboarding", "01-intake-questionnaire.md"), "utf8");
const intakeRunbook = readFileSync(join(ROOT, "onboarding", "01-intake-RUNBOOK.md"), "utf8");
const effortTimeline = readFileSync(join(ROOT, "onboarding", "02-client-effort-and-timeline.md"), "utf8");
const kickoff = readFileSync(join(ROOT, "onboarding", "03-kickoff-and-checkins.md"), "utf8");
const handoffGuide = readFileSync(join(ROOT, "onboarding", "05-handoff-and-revocation.md"), "utf8");
const onboardingScorecard = readFileSync(join(ROOT, "onboarding", "10-client-onboarding-scorecard.md"), "utf8");
const topLevelReadme = readFileSync(join(ROOT, "README.md"), "utf8");
const developerReadme = readFileSync(join(ROOT, "docs", "README-developer.md"), "utf8");
const ownerWorkspaceApi = readFileSync(join(ROOT, "docs", "OWNER-WORKSPACE-API.md"), "utf8");
const failuresRunbook = readFileSync(join(ROOT, "onboarding", "06-runbook-top-ten-failures.md"), "utf8");
const provisioningPrerequisites = readFileSync(join(ROOT, "onboarding", "08-provisioning-prerequisites.md"), "utf8");
const answerLimits = readFileSync(join(ROOT, "onboarding", "04-what-it-can-and-cannot-answer.md"), "utf8");
const sourceMatrix = readFileSync(join(ROOT, "onboarding", "07-ingest-source-matrix.md"), "utf8");
const gateSource = readFileSync(join(ROOT, "frontend", "src", "components", "Gate.tsx"), "utf8");
const technicianSkill = readFileSync(join(ROOT, "skills", "financial-brain-technician", "SKILL.md"), "utf8");
const manifestTemplate = readFileSync(join(ROOT, "templates", "brain.manifest.json"), "utf8");
const manifestTemplateGuidance = JSON.parse(manifestTemplate).testing._comment.join(" ");
const brainManifestSchema = JSON.parse(readFileSync(join(ROOT, "manifest.schema.json"), "utf8"));
const evaluationGuide = readFileSync(join(ROOT, "docs", "EVALUATION.md"), "utf8");
const goldenTemplate = readFileSync(join(ROOT, "eval", "golden", "TEMPLATE.golden.json"), "utf8");
const goldenSessionSource = readFileSync(join(ROOT, "eval", "golden-20.mjs"), "utf8");
const customerRuntimeSources = [
  readFileSync(join(ROOT, "acceptance.mjs"), "utf8"),
  readFileSync(join(ROOT, "brain.mjs"), "utf8"),
  readFileSync(join(ROOT, "report-html.mjs"), "utf8"),
  readFileSync(join(ROOT, "report.mjs"), "utf8"),
].join("\n");
const customerGuidance = [
  preInterview,
  intake,
  documents["README.md"],
  documents["ACCEPTANCE-AND-HANDOFF.md"],
].join("\n");
const assistedAcceptanceGuidance = [
  documents["TECHNICIAN-RUNBOOK.md"],
  intakeRunbook,
  effortTimeline,
  kickoff,
].join("\n");
const support = JSON.parse(readFileSync(join(PACKET, "support-profile.example.json"), "utf8"));
const schema = JSON.parse(readFileSync(join(PACKET, "support-profile.schema.json"), "utf8"));

test("the top-level map guidance promises a bounded starting scope, not completeness", () => {
  assert.match(topLevelReadme, /bounded, non-authoritative starting-map preview/i);
  assert.doesNotMatch(topLevelReadme, /complete non-authoritative map preview/i);
});

test("the client packet covers the complete journey with realistic proof boundaries", () => {
  for (const phrase of [
    "Pre-interview",
    "Readiness and install",
    "First source",
    "Owner-led acceptance",
    "Acceptance and handoff",
    "Future update notification",
    "Configured:",
    "Scripted or fixture proof:",
    "Live tested:",
    "Blocked:",
  ]) assert.match(all, new RegExp(phrase, "i"));
  assert.match(documents["README.md"], /15 to 45 minutes/);
  assert.match(documents["README.md"], /60 to 90 minutes/);
  assert.match(documents["README.md"], /30 minutes to many hours/);
  assert.match(all, /Node\.js 22 or newer is a behind-the-scenes technician prerequisite/);
  assert.match(all, /passkey-capable phone, tablet, or computer/);
});

test("copyable Claude prompts keep human ceremonies and secrets out of chat", () => {
  assert.match(all, /Open https:\/\/financialbrain\.ai\/update, read the whole page/);
  assert.match(all, /Begin read-only/i);
  assert.match(all, /Do not ask me to paste a password, token, authentication code/);
  assert.match(all, /hidden terminal prompt/);
  assert.match(all, /Ask for exact approval/i);
  assert.match(customerGuidance, /offer (?:to use )?browser control/i);
  assert.match(customerGuidance, /return control[^.]*before login, 2FA[^.]*consent, billing[^.]*passkey/is);
  assert.doesNotMatch(all, /(?:sk-|ghp_|eyJ[A-Za-z0-9_-]{20,})/);
});

test("the source, adaptive acceptance, support, and update contracts stay honest", () => {
  assert.match(all, /dry run or preview/i);
  assert.match(all, /partial, unavailable/i);
  assert.match(customerGuidance, /evidence-derived/i);
  assert.match(customerGuidance, /Golden 20 is strictly optional/i);
  assert.match(all, /brain eval <manifest> --golden-20/);
  assert.match(all, /not a release\s+certification/i);
  assert.match(all, /brain support --preview/);
  assert.match(all, /update available.*current.*update check unavailable/is);
  assert.match(all, /Unavailable is not the same as current/);
  assert.match(all, /never performs a background update/);
});

test("customer acceptance is owner-led and never requires invented or canned cases", () => {
  assert.match(preInterview, /zero is also fine/i);
  assert.match(documents["ACCEPTANCE-AND-HANDOFF.md"], /owner may use it, reword\s+it, replace it with a real question, or skip it/i);
  assert.match(documents["ACCEPTANCE-AND-HANDOFF.md"], /There is no canned-question quota/i);
  assert.match(customerGuidance, /one (?:clear )?question or action at a time/i);
  assert.doesNotMatch(customerGuidance, /draft Golden 20 questions/i);
  assert.doesNotMatch(customerGuidance, /Twenty owner-written cases are reviewed and saved/i);
  assert.doesNotMatch(customerGuidance, /Ten questions you would ask a perfect assistant/i);
  assert.doesNotMatch(customerGuidance, /Five things it must NOT answer/i);
});

test("shipped technician guidance uses adaptive assisted acceptance with no owner question quota", () => {
  assert.match(assistedAcceptanceGuidance, /adaptive assisted acceptance/i);
  assert.match(assistedAcceptanceGuidance, /Zero owner-authored questions are required/i);
  assert.match(assistedAcceptanceGuidance,
    /owner (?:may|can) use it, reword it, replace it with a real question, or skip it/i);
  assert.match(assistedAcceptanceGuidance, /technical details.*owner does not need.*exact commands/is);
  assert.match(effortTimeline, /adaptive acceptance checks/i);
  assert.match(effortTimeline, /Zero owner-authored questions are required/i);
  assert.match(effortTimeline, /optional real questions may be blank/i);
  for (const rejected of [
    /bring the ten questions/i,
    /your ten questions/i,
    /you type\. i stay quiet/i,
    /let them type/i,
    /owner has not written the twenty questions/i,
    /copy §6\.1/i,
    /three real questions/i,
    /original ten/i,
  ]) assert.doesNotMatch(assistedAcceptanceGuidance, rejected);
});

test("setup, test, and handoff guidance use evidence gates instead of owner homework", () => {
  for (const text of [handoffGuide, technicianSkill, manifestTemplateGuidance]) {
    assert.match(text, /Zero (?:owner-authored|prepared) questions are required for\s+setup, adaptive acceptance,[\s\S]{0,20}handoff/i);
    assert.match(text, /accepted[\s\S]{0,220}stored[\s\S]{0,100}provenance[\s\S]{0,220}projected[\s\S]{0,220}query-visible[\s\S]{0,100}citation/i);
  }
  assert.match(onboardingScorecard, /Do not require a prepared question\s+list/i);
  assert.match(onboardingScorecard, /source map comes from the owner's approved goals, sources, and exclusions/i);
  assert.match(
    brainManifestSchema.properties.testing.properties.probe_questions.description,
    /Optional owner-authored private regression questions.*Zero are required for setup, adaptive acceptance, or handoff/i,
  );
  for (const rejected of [
    /testing\.probe_questions is EMPTY/i,
    /Fill testing\.probe_questions/i,
    /Your ten questions/i,
    /Choose the order from the client's questions/i,
    /source map comes from the client's acceptance questions/i,
    /No seed questions were captured/i,
    /Send us ten questions/i,
    /\*\*Everything is working\.\*\*/i,
  ]) {
    assert.doesNotMatch(
      `${customerRuntimeSources}\n${handoffGuide}\n${onboardingScorecard}\n${technicianSkill}\n${manifestTemplate}`,
      rejected,
    );
  }
});

test("Golden 20 remains an opt-in private regression method, not a handoff gate", () => {
  const templateHelp = JSON.parse(goldenTemplate)._how_to_read_this.join(" ");
  for (const text of [evaluationGuide, templateHelp, goldenSessionSource]) {
    assert.match(text, /optional/i);
    assert.match(text, /private regression/i);
    assert.match(text, /not required for setup, adaptive acceptance,[\s\S]{0,20}or handoff/i);
    assert.match(text, /does not replace the same-item (?:source )?receipt and evidence gate/i);
  }
  assert.ok(
    templateHelp.search(/optional private regression/i) < templateHelp.search(/write the questions FIRST, from memory/i),
    templateHelp,
  );
  assert.match(templateHelp, /write the questions FIRST, from memory/i);
});

test("technician source onboarding proves one exact item through four independent gates", () => {
  const runbook = documents["TECHNICIAN-RUNBOOK.md"];
  const promptStart = runbook.indexOf("### Source onboarding prompt");
  const promptEnd = runbook.indexOf("## 6.", promptStart);
  const prompt = runbook.slice(promptStart, promptEnd);
  assert.ok(promptStart >= 0 && promptEnd > promptStart);
  for (const text of [runbook, prompt]) {
    assert.match(text, /same approved low-sensitivity item/i);
    assert.match(text, /stop at the first (?:state that is not proved|unproven state)/i);
    assert.match(text, /Received.*terminal source receipt.*accepted, refused, unreadable, failed, and retryable counts/is);
    assert.match(text, /Saved.*exact same item.*logical family in D1.*chunks.*source and extraction provenance/is);
    assert.match(text, /Search ready.*exact generation.*confirmed Vectorize receipt.*no matching outbox/is);
    assert.match(text, /two health readings.*pending work.*declin(?:e|ing)|two health readings show pending work declining or zero/is);
    assert.match(text, /Answer checked.*distinctive phrase.*exact same item.*expected source citation and provenance/is);
  }
  assert.match(runbook, /Received is not Saved, Saved is not Search\s+ready, and Search ready is not Answer checked/i);
});

test("Financial Map reads are explained before host approval and writes stay outside Optimize", () => {
  const runbook = documents["TECHNICIAN-RUNBOOK.md"];
  assert.match(runbook, /Immediately before that read.*sends no Financial Map snapshot and changes nothing/is);
  assert.match(runbook, /approval prompt.*private read/is);
  assert.match(runbook,
    /before making any financial completeness\s+conclusion.*guided read-only interview/is);
  assert.match(runbook, /End Optimize before preview mode.*separate\s+approval/is);
  assert.match(runbook, /activation.*another owner\s+decision.*fresh passkey ceremony/is);
  const mapOrderGuidance = [
    topLevelReadme,
    onboardingScorecard,
    developerReadme,
    ownerWorkspaceApi,
  ];
  for (const text of mapOrderGuidance) {
    assert.match(text, /before\s+any\s+financial-completeness conclusion/is);
    assert.match(text, /session-only\s+interview/is);
    assert.match(text, /interview submits\s+nothing and changes nothing/is);
    assert.match(text, /(?:Optimize ends|End Optimize)\s+before/is);
    assert.doesNotMatch(text, /interview after (?:the|its) (?:read-only )?report/i);
    assert.doesNotMatch(text, /after (?:the )?Optimize report[^.]{0,120}interview/is);
  }
});

test("OCR guidance preserves consent, cost, and unknown scan state", () => {
  assert.match(customerGuidance, /OCR[^.]*off by default/is);
  assert.match(customerGuidance, /owner explicitly enables it/i);
  assert.match(customerGuidance, /estimated\s+page count, cost range, time range, and daily spend cap/i);
  assert.match(customerGuidance, /not automatically a scan/i);
  assert.match(customerGuidance, /state remains unknown/i);
  assert.match(failuresRunbook, /scanned PDF with no text layer can be read with OCR/i);
  assert.match(failuresRunbook, /OCR is off\s+by default/i);
  assert.match(failuresRunbook, /estimated page count, cost range, time range, and daily spend\s+cap/i);
  assert.match(failuresRunbook, /uninspected file or failed extraction remains unknown/i);
  assert.doesNotMatch(failuresRunbook, /There is no text recognition on scanned documents/i);
});

test("access guidance describes multiple source-level zones without item-level overclaim", () => {
  assert.match(customerGuidance, /multiple source-level access zones/i);
  assert.match(customerGuidance, /Each registered source can have at most one zone label/i);
  assert.match(customerGuidance, /named (?:access\s+)?grant can include one or more allowed zones/i);
  assert.match(customerGuidance, /unzoned source[^.]*owner-only[^.]*excluded from every\s+named\s+zone\s+grant/is);
  assert.match(customerGuidance, /Zones (?:are source-level boundaries[^.]*They )?do not (?:separate|split) individual (?:files, messages, or accounts|items) inside one (?:registered )?source/i);
});

test("new-computer checks cover local tools while Optimize stays out of access ceremonies", () => {
  const readme = documents["README.md"];
  const handoff = documents["ACCEPTANCE-AND-HANDOFF.md"];
  assert.match(readme, /New or replacement computer/i);
  assert.match(readme, /Brain CLI[\s\S]*financial-brain-technician[\s\S]*owner-assistant MCP registration/i);
  assert.match(handoff, /Optimize is read-only/i);
  assert.match(handoff, /does not install or\s+repair those items, enroll a passkey, list devices, or ask the owner to\s+recognize devices/i);
  assert.match(handoff, /purpose is to confirm owner access/i);
  assert.match(handoff, /cannot see or store the passkey, biometric,\s+or device PIN/i);
  assert.match(handoff, /passkey step does not connect files, messages, accounts/i);
});

test("brain tools is disclosed as a writing setup action before first use", () => {
  const toolsCommand = renderCliCommands("brain tools");
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const source of [topLevelReadme, provisioningPrerequisites, documents["TECHNICIAN-RUNBOOK.md"]]) {
    const renderedCopy = renderCliCommands(source);
    const firstUse = renderedCopy.indexOf(toolsCommand);
    assert.ok(firstUse >= 0);
    const firstTouch = renderedCopy.slice(0, firstUse + 700);
    assert.match(firstTouch, /not a read-only check/i);
    assert.match(firstTouch, /installs or updates.*technician skill/is);
    assert.match(firstTouch, /bootstrap status/i);
    assert.match(firstTouch, /user's PATH/i);
    assert.match(firstTouch, /(?:ask|owner).*approve/is);
  }
  const optimizeBoundary = new RegExp(
    `Optimize[^.]*never runs[^.]*${escapeRegex(toolsCommand)}`,
    "is",
  );
  for (const source of [topLevelReadme, provisioningPrerequisites, documents["TECHNICIAN-RUNBOOK.md"], kickoff]) {
    const renderedCopy = renderCliCommands(source);
    assert.match(renderedCopy, optimizeBoundary);
    assert.match(renderedCopy, /non-writing/i);
    assert.match(renderedCopy, /machine-continuity[^.]*MCP[^.]*configuration/is);
  }
  assert.doesNotMatch(topLevelReadme, /read-only `brain tools`/i);
});

test("customer guidance bounds empty results to the evidence actually searched", () => {
  assert.match(answerLimits, /empty result is bounded to the material and coverage actually searched/i);
  assert.match(answerLimits, /history, freshness, readability, access zones, or search readiness is\s+unproven, the result is unknown, not absent/i);
  assert.match(answerLimits, /complete authorized corpus[^.]*not proof[^.]*anywhere in the world/i);
  assert.match(answerLimits, /no transcript was found in that\s+authorized scope, not that one never existed elsewhere/i);
  assert.doesNotMatch(gateSource, /Everything you have written, decided and been told/i);
  assert.match(gateSource, /material connected to your Brain[\s\S]{0,100}coverage it cannot prove/i);
  assert.match(kickoff, /Anything outside that proven scope stays unknown/i);
  assert.match(kickoff, /Incomplete history, freshness, readability, zones, or search\s+keeps the result unknown/i);
});

test("source guidance requires same-item proof and keeps run failures bounded", () => {
  assert.match(failuresRunbook, /source-level clues[^.]*not proof that any exact file arrived/is);
  assert.match(failuresRunbook, /Stop at the first unproven checkpoint/i);
  assert.match(failuresRunbook, /Received:[\s\S]*terminal source receipt[\s\S]*Saved:[\s\S]*same item[\s\S]*expected\s+logical family in D1[\s\S]*chunks[\s\S]*source and\s+extraction provenance/i);
  assert.match(failuresRunbook, /Search ready:[\s\S]*exact generation[\s\S]*confirmed Vectorize receipt[\s\S]*no\s+matching outbox work remains/i);
  assert.match(failuresRunbook, /Answer checked:[\s\S]*distinctive phrase[\s\S]*same item[\s\S]*expected source\s+citation and provenance/i);
  assert.match(sourceMatrix, /failed or unavailable status\s+means the source was not loaded successfully in this run/i);
  assert.match(sourceMatrix, /does not prove\s+D1 has no older records from an earlier run/i);
  assert.match(sourceMatrix, /authenticated\s+`brain sources <manifest>` inventory/i);
  assert.match(failuresRunbook, /concise columns are `name`, `kind`, `zone`, `physical`, `readable`, and\s+`freshness`/i);
  assert.match(failuresRunbook, /complete contract-v3 receipt/i);
  assert.doesNotMatch(failuresRunbook, /status is still\s+`pending`/i);
});

test("the Windows pilot names one safe first source and does not offer unsupported credential ceremonies", () => {
  const setupGuide = readFileSync(join(ROOT, "onboarding", "09-technician-setup-and-rehearsal.md"), "utf8");
  assert.match(setupGuide, /deliberately refuses those three\s+steps on Windows/i);
  assert.match(setupGuide, /Monday Windows x64 first-source lane/i);
  assert.match(setupGuide, /one owner-approved, low-sensitivity, text-readable test\s+document/i);
  assert.match(setupGuide, /preview sends nothing/i);
  assert.match(setupGuide, /without `--dry-run`[\s\S]*Received, Saved, Search ready, and Answer\s+checked/i);
  assert.match(topLevelReadme, /Windows path refuses those three credential ceremonies/i);
});

test("handoff treats original-file R2 storage as optional", () => {
  assert.match(handoffGuide, /Optional original-file copy, omit this row when absent/i);
  assert.match(handoffGuide, /Original files remain in their source provider unless[^.]*R2 original-file copy/is);
  assert.match(handoffGuide, /D1 holds extracted text and\s+metadata, not a backup of the original binary/i);
  assert.match(handoffGuide, /If configured, delete the R2 original-file copy/i);
  assert.match(handoffGuide, /Omit this step entirely when the\s+install has no R2 bucket/i);
});

test("handoff cleanup follows actual custody and the source-inventory v3 contract", () => {
  assert.match(handoffGuide, /Only credentials and source access that were actually used are revoked or\s+removed at handoff/i);
  assert.match(handoffGuide, /If that key never left owner-only custody[^.]*do not rotate it solely for handoff/is);
  assert.match(handoffGuide, /If the admin key was exposed[\s\S]*reviewed owner-controlled secure\s+replacement path/i);
  assert.match(handoffGuide, /If no\s+such path is available, stop and record the handoff as incomplete/i);
  assert.match(handoffGuide, /Before any admin-key rotation[\s\S]*Every owner-app session on every device will be signed out/i);
  assert.match(handoffGuide, /Passkeys,\s+enrolled-device records, and Brain data remain in place/i);
  assert.match(handoffGuide, /Running it without a new value is not an\s+admin-key rotation/i);
  assert.doesNotMatch(handoffGuide, /have the owner rotate the admin key/i);
  assert.doesNotMatch(handoffGuide, /The Cloudflare and admin credentials used during the build are rotated or\s+revoked at handoff/i);

  assert.match(handoffGuide, /node brain\.mjs sources <manifest> --json/);
  assert.match(handoffGuide, /source-inventory contract v3/i);
  for (const field of [
    "connector kind",
    "zone",
    "physical and logical document counts",
    "readable and unreadable counts",
    "freshness evidence",
    "extraction and OCR state",
    "missing provenance fields",
  ]) assert.match(handoffGuide, new RegExp(field, "i"), field);
  assert.doesNotMatch(handoffGuide, /check the last ingest date on each line/i);

  assert.match(topLevelReadme, /reapply durable secrets; rotates ADMIN_KEY only with a reviewed replacement/i);
  assert.match(customerRuntimeSources, /apply durable secrets; ADMIN_KEY rotates only when a reviewed[\s\S]*owner-controlled path supplies a replacement/i);
  assert.doesNotMatch(`${topLevelReadme}\n${customerRuntimeSources}`, /exact durable ADMIN_KEY rotation command|set secrets and durably rotate ADMIN_KEY/i);
});

test("the packet makes high-volume source onboarding and optimize proof explicit", () => {
  for (const phrase of [
    "Zoom client calls",
    "recent, high-value mail",
    "iMessage",
    "WhatsApp",
    "Google Drive",
    "Dropbox",
    "Box folder",
    "Plaid",
    "starter context",
    "live updates",
    "history",
    "meaning search",
    "provenance",
    "access zone",
    "unregistered",
    "/optimize",
    "client onboarding scorecard",
    "Owner Financial Map",
    "possible mention",
  ]) assert.match(all, new RegExp(phrase, "i"), phrase);
  assert.match(all, /30-day reconciliation/);
  assert.match(all, /bounded resumable windows/);
  assert.match(all, /elapsed time, owner time, retries/i);
  assert.match(all, /days 15, 22, and 29/i);
  assert.match(all, /one short question at a time/i);
  assert.match(all, /MCP response is deliberately compact.*signed-in Brain.*complete exact\s+map.*every unresolved item/is);
  assert.match(all, /Activation is a separate owner choice/i);
});

test("ordinary onboarding keeps the held bank boundary consistent", () => {
  const runbook = documents["TECHNICIAN-RUNBOOK.md"];
  const scorecard = onboardingScorecard;
  for (const guidance of [runbook, scorecard]) {
    assert.match(guidance, /Bank feeds? (?:remain|are) (?:outside|not) ordinary onboarding/i);
    assert.match(guidance, /do not open Plaid Link/i);
    assert.match(guidance, /bank password, verification code, or setup key/i);
    assert.match(guidance, /already approved pilot/i);
    assert.match(guidance, /reviewed, version-scoped field plan/i);
  }
  assert.doesNotMatch(runbook, /Plaid or another financial source:\*\* let the owner complete Link/i);
  assert.doesNotMatch(scorecard, /^\d+\. Plaid or another financial source/m);
});

test("the privacy draft has source-specific consent and retention prompts", () => {
  const draft = documents["DATA-PROTECTION-DRAFT.md"];
  for (const phrase of [
    "Zoom client-call transcripts",
    "shared mailboxes",
    "iMessage, SMS, and WhatsApp",
    "Plaid and other financial feeds",
    "Consent and scope decision",
    "Retention and deletion decision",
  ]) assert.match(draft, new RegExp(phrase, "i"), phrase);
  assert.match(draft, /do not create a\s+default consent or retention rule/i);
});

test("Wrangler browser sign-in and recovery-token guidance match the installer", () => {
  assert.match(all, /named Cloudflare browser profile/i);
  assert.match(all, /OS keyring/i);
  assert.match(all, /API token remains available for a reviewed legacy/i);
  for (const permission of ["Workers Scripts", "D1", "Vectorize", "Workers AI"]) {
    assert.match(all, new RegExp(permission));
  }
  assert.match(all, /expiry, normally two days/i);
  assert.match(all, /owner enter the value only through the Brain\s+CLI's hidden prompt/i);
  assert.match(all, /real\s+browser callback[\s\S]*remain field gates/i);
});

test("support contact and response targets are explicit configurable fields", () => {
  assert.equal(support.schema_version, 1);
  assert.match(support.contact.email, /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  assert.match(support.contact.incident_email, /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  for (const key of schema.required) assert.ok(Object.hasOwn(support, key), `missing ${key}`);
  for (const key of schema.properties.response_targets.required) {
    assert.equal(typeof support.response_targets[key], "string");
    assert.ok(support.response_targets[key].trim().length > 0, `empty ${key}`);
  }
  assert.doesNotMatch(JSON.stringify(support), /TODO|TBD|<[^>]+>|\{\{[^}]+\}\}/i);
});

test("privacy and incident text is clearly a counsel-review draft", () => {
  const draft = documents["DATA-PROTECTION-DRAFT.md"];
  assert.match(draft, /product draft for privacy counsel, contract counsel, and security\s+review/i);
  assert.match(draft, /not legal advice, legal approval/i);
  assert.match(draft, /Draft role and subprocessor table/);
  assert.match(draft, /Draft retention schedule for decision/);
  assert.match(draft, /Draft incident and support language/);
  assert.match(draft, /Counsel decisions before publication/);
  assert.doesNotMatch(draft, /legally approved|counsel approved/i);
});

test("customer-facing packet avoids rejected video instructions, placeholder copy, and em dashes", () => {
  const allCustomerCopy = `${all}\n${preInterview}\n${intake}`;
  assert.doesNotMatch(allCustomerCopy, /watch (?:this|the) video|setup video|video walkthrough/i);
  assert.doesNotMatch(allCustomerCopy, /TODO|TBD|lorem ipsum|\{\{[^}]+\}\}/i);
  assert.doesNotMatch(allCustomerCopy, /\u2014/);
});

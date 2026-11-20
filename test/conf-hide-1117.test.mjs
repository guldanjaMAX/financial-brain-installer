import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cmdAsk } from '../brain.mjs';
import { handleMcp } from '../worker/src/lib/mcp-endpoint.js';
import { answerText, confidenceText, evidenceNoteText } from '../worker/src/lib/answer-render.js';
import * as app from '../frontend/src/lib/answer-render.js';
import { moneyQuestionHandoff } from '../worker/src/lib/money-handoff.js';
import { sourceModuleHarness } from './helpers/source-module-harness.mjs';
import { overviewFixture } from '../worker/test/helpers/money-overview-fixture.mjs';
import { overviewMoney } from '../worker/src/lib/money-overview.js';
import { hideConfidenceLine } from '../worker/src/lib/owner-evidence.js';
import { documentResponseConfidence } from '../worker/src/lib/confidence.js';
import { renderOwnerRulesSection } from '../operations/claude-workspace.mjs';
import { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } from '../scripts/run-test-chain.mjs';
import { assertSameLevels, replayFrozenLevels } from './helpers/frozen-confidence-replay.mjs';
import { MONEY_GUIDE, MONEY_ANSWER_INSTRUCTIONS, MONEY_CONFIDENCE_INSTRUCTIONS,
  MONEY_SQL_SAFETY_INSTRUCTIONS, MONEY_CAPABILITY_TRANSITION, MONEY_TOOLS,
  unavailableMoneyOverview, withMoneyConfidence } from '../worker/src/lib/money-query-contract.js';

const hidden = /Confidence\s*:|\b(?:High|Medium|Low)\s*\(?\d+%/i;
const prose = 'The review is November 13 [1].';
const citation = { n: 1, title: 'Review memo', source: 'records', ts: '2026-11-10', date_reliable: true };
const response = percent => ({ answer: prose, answer_contract: { version: 1, kind: 'document' },
  citations: [citation], results: [], gaps: [],
  confidence: { percent, band: percent === 100 ? 'High' : 'Low',
    basis: percent === 100 ? ['The source and answer checks are complete.'] : ['The source search did not complete.'],
    missing: percent === 100 ? [] : ['A complete search of the requested sources.'] } });

async function remoteAnswer(body, profile = 'librarian', question = 'When is the review?') {
  let calls = 0;
  const request = new Request('https://fixture.invalid/mcp', { method: 'POST', body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { question } },
  }) });
  const out = await (await handleMcp({}, request, new URL(request.url), {
    grant: { profile }, think: async () => { calls++; return body; },
  })).json();
  assert.ok(out.result?.content?.[0]?.text, 'the real MCP handler returned a populated answer');
  return { text: out.result.content[0].text, calls };
}

// Exercise the actual CLI with synthetic input and injected I/O. Never resolve
// a desktop credential or fall back to an ambient HTTP implementation.
async function cliAnswer(body) {
  const root = mkdtempSync(join(process.env.HOME, 'owner-output-'));
  try {
    const manifest = join(root, 'brain.manifest.json'), keyFile = join(root, '.brain-admin-key');
    writeFileSync(keyFile, ['fixture', 'key'].join('-'), { mode: 0o600 });
    writeFileSync(manifest, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'fixture.invalid' },
      operations: { admin_key_secret: null } }));
    const lines = [], log = console.log;
    let calls = 0, result;
    try {
      console.log = (...parts) => lines.push(parts.join(' '));
      result = await cmdAsk(manifest, { ask: async () => 'When is the review?', adminKey: readFileSync(keyFile, 'utf8'),
        http: async () => { calls++; return new Response(JSON.stringify(body)); } });
    } finally { console.log = log; }
    assert.equal(calls, 1, 'the real CLI owner-output decision was reached');
    return { text: lines.join('\n'), result };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('R3 F01 compatibility ledger notes translate internal assessment wording and retain exact gaps', async () => {
  for (const explicitMissing of [true, false]) {
    const body = { ...response(10), ledger: { from: '2026-10-01', to: '2026-10-31', complete: false, total_minor: 12000 } };
    delete body.answer_contract;
    if (!explicitMissing) delete body.confidence.missing;
    const original = JSON.stringify(body), score = JSON.stringify(documentResponseConfidence(body));
    const remote = await remoteAnswer(body), cli = await cliAnswer(body);
    assert.equal(remote.calls, 1, 'the real legacy-ledger decision was reached');
    assert.equal(cli.result.ledger.total_minor, 12000);
    const control = await remoteAnswer(response(100));
    assert.equal(control.calls, 1, 'the populated complete-evidence control was reached');
    assert.match(control.text, /November 13 \[1\]/);
    assert.doesNotMatch(control.text, /may be incomplete/);
    for (const output of [remote.text, cli.text, ...[app, { answerText, evidenceNoteText }]
      .map(render => [render.answerText(body), render.evidenceNoteText(body)].join('\n'))]) {
      assert.match(output, /November 13 \[1\]/);
      assert.match(output, /The source search did not complete/);
      assert.match(output, explicitMissing ? /A complete search of the requested sources/ : /connected accounts, synced dates, missing periods and uncertain movements/);
      assert.match(output, /may be incomplete/);
      assert.doesNotMatch(output, /\bconfidence\b|\b(?:High|Medium|Low)\b|\d+(?:\.\d+)?%/i);
    }
    assert.equal(documentResponseConfidence(body).percent, 0, 'legacy evidence still cannot receive an elevated score');
    assert.equal(JSON.stringify(documentResponseConfidence(body)), score);
    assert.equal(JSON.stringify(body), original);
  }
});

test('F01 owner paths retain specific evidence reasons and missing items without duplicating answer details', async () => {
  const body = response(10), original = JSON.stringify(body);
  const remote = await remoteAnswer(body);
  assert.equal(remote.calls, 1, 'the remote evidence decision was reached');
  assert.match(remote.text, /November 13 \[1\]/, 'the populated answer remains visible');
  assert.match(remote.text, /A complete search of the requested sources/);
  assert.match(remote.text, /The source search did not complete/);
  const paths = [remote.text];
  for (const render of [app, { answerText, evidenceNoteText }]) {
    assert.equal(render.answerText(body), prose, 'the populated app/Worker answer was rendered');
    paths.push([render.answerText(body), render.evidenceNoteText(body)].join('\n'));
    const complete = response(100);
    assert.equal(render.answerText(complete), prose, 'the complete-evidence control was rendered');
    assert.equal(render.evidenceNoteText(complete), '');
    const qualified = { ...body, answer: `${prose}\nWhy: ${body.confidence.basis[0]}\nMissing: ${body.confidence.missing[0]}` };
    assert.equal(render.evidenceNoteText(qualified), '', 'specific details already in the five-part answer are not repeated');
    const partlyQualified = { ...body, answer: `${prose}\nWhy: ${body.confidence.basis[0]}` };
    assert.match(render.evidenceNoteText(partlyQualified), /A complete search of the requested sources/);
    assert.doesNotMatch(render.evidenceNoteText(partlyQualified), /The source search did not complete/);
    const money = { ...body, confidence: { percent: 10, level: 'Low', reasons: ['The card ending 3333 has no rows after October 28.'],
      missing: ['The card statement for October 29 through October 31.'] } };
    assert.match(render.evidenceNoteText(money), /card ending 3333 has no rows after October 28/);
    assert.match(render.evidenceNoteText(money), /card statement for October 29 through October 31/);
  }
  const root = mkdtempSync(join(process.env.HOME, 'evidence-cli-'));
  try {
    const manifest = join(root, 'brain.manifest.json'), keyFile = join(root, '.brain-admin-key');
    writeFileSync(keyFile, ['fixture', 'key'].join('-'), { mode: 0o600 });
    writeFileSync(manifest, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'fixture.invalid' }, operations: { admin_key_secret: null } }));
    const lines = [], log = console.log;
    let calls = 0;
    try {
      console.log = (...parts) => lines.push(parts.join(' '));
      const result = await cmdAsk(manifest, { ask: async () => 'When is the review?', adminKey: readFileSync(keyFile, 'utf8'),
        http: async () => { calls++; return new Response(JSON.stringify(body)); } });
      assert.equal(calls, 1, 'the real CLI evidence decision was reached');
      assert.equal(result.confidence.percent, 10);
    } finally { console.log = log; }
    paths.push(lines.join('\n'));
  } finally { rmSync(root, { recursive: true, force: true }); }
  for (const text of paths) {
    assert.match(text, /November 13 \[1\]/);
    assert.match(text, /The source search did not complete/);
    assert.match(text, /A complete search of the requested sources/);
    assert.doesNotMatch(text, hidden);
  }
  assert.equal(JSON.stringify(body), original, 'all source, citation and internal assessment bytes remain unchanged');
});

test('F02 remote, local and app paths hide Markdown assessment badges and preserve genuine source quotes', async () => {
  const localMcp = await sourceModuleHarness(new URL('../components/brain-mcp.mjs', import.meta.url));
  const badges = ['Confidence: High (92%)', '- Confidence: High (92%)', '> Confidence: High (92%)',
    '* **Confidence:** High (92%)', '1. Confidence: High (92%)', '> - **Confidence: High (92%)**',
    '_Confidence: High (92%)_', '__Confidence: High (92%)__', '___Confidence: High (92%)___',
    '__Confidence:__ __High__ (__92%__)'];
  for (const badge of badges) {
    const body = { ...response(100), answer: `${prose}\n${badge}` }, original = JSON.stringify(body);
    const remote = await remoteAnswer(body);
    assert.equal(remote.calls, 1, 'the real remote Markdown decision was reached');
    let calls = 0;
    const { result } = localMcp({ PROFILE: 'owner-assistant', call: async () => { calls++; return body; } },
      'runTool("brain_think", {q:"When is the review?"})');
    const local = await result;
    assert.equal(calls, 1, 'the real local Markdown decision was reached');
    for (const output of [remote.text, local.answer, app.answerText(body), answerText(body)]) {
      assert.match(output, /November 13 \[1\]/, 'the substantive answer is the populated control');
      assert.doesNotMatch(output, hidden);
    }
    assert.equal(local.confidence.percent, 100);
    assert.equal(JSON.stringify(body), original);
    const quoted = { ...body, answer: `${prose}\n${badge} [1]\nThe contract fee is 10% [1].` };
    const quotedRemote = await remoteAnswer(quoted);
    assert.equal(quotedRemote.calls, 1, 'the cited-source control was reached');
    let quoteCalls = 0;
    const quotedLocal = await localMcp({ PROFILE: 'owner-assistant', call: async () => { quoteCalls++; return quoted; } },
      'runTool("brain_think", {q:"When is the review?"})').result;
    assert.equal(quoteCalls, 1);
    for (const output of [quotedRemote.text, quotedLocal.answer, app.answerText(quoted), answerText(quoted)]) {
      assert.ok(output.includes(`${badge} [1]`), 'a genuine cited quotation is retained byte-for-byte');
      assert.ok(output.includes('The contract fee is 10% [1].'));
    }
  }
});

test('owner-output guard checks server-line removal and preserves other layouts across every surface', async t => {
  const localMcp = await sourceModuleHarness(new URL('../components/brain-mcp.mjs', import.meta.url));
  const forbidden = /\bconfidence\b|\b(?:High|Medium|Low)\b|\d+(?:\.\d+)?\s*%/i;
  const assertOwner = (output, label) => {
    assert.ok(output?.trim(), `${label}: populated owner output reached`);
    // Underscores count as word characters to a regex, but as emphasis in
    // Markdown. Check the visible words as well as the unmodified source.
    assert.doesNotMatch(output, forbidden, label);
    assert.doesNotMatch(output.replace(/[*_~`]/g, ''), forbidden, label);
  };
  const ledger = { ...response(10), ledger: { from: '2026-10-01', to: '2026-10-31', complete: false, total_minor: 12000 } };
  delete ledger.answer_contract;
  const incomplete = { ...response(10), status: 'coverage_incomplete',
    notice: 'Source coverage is incomplete. This result is provisional.', results: [{ title: 'Review memo' }] };
  delete incomplete.answer_contract;
  const fixtures = [response(100), response(10), ledger, incomplete];
  const preserved = new WeakMap();
  // Plain, emphasis, code, strike, heading, ordered/unordered list and nested
  // quote styles all pass through the real surfaces, not just the matcher.
  const wrappers = ['', '*', '**', '***', '_', '__', '___', '~~', '`', '**_'];
  const prefixes = ['', '- ', '+ ', '* ', '1. ', '1) ', '> ', '> - ', '## '];
  for (const level of ['High', 'Medium', 'Low']) for (const wrap of wrappers) for (const prefix of prefixes)
    for (const score of [`${level} (92%)`, level, '92%']) {
    const closing = [...wrap].reverse().join('');
    const badge = `${prefix}${wrap}Confidence: ${score}${closing}`;
    const body = { ...response(100), answer: `${prose}\n${badge}` };
    fixtures.push(body);
    if (wrap.includes('~') || wrap.includes('`') || prefix === '## ' || score === level || score === '92%') preserved.set(body, badge);
  }
  for (const badge of ['__Confidence:__ __High__ (__92%__)', '**Confidence:** **Low** (**10%**)',
    '> - _Confidence:_ _Medium_ (_75%_)']) fixtures.push({ ...response(100), answer: `${prose}\n${badge}` });
  // F01 review reproductions, followed by structurally different, seeded
  // Markdown blocks. These use the same populated five real output paths.
  const reviewed = ['| Confidence | High (92%) |\n| --- | --- |',
    '### Confidence\nHigh (92%)', '**Confidence:**\n**High (92%)**',
    'Confidence\n----------\nHigh (92%)'];
  let seed = 0x1117;
  const choose = values => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return values[seed % values.length]; };
  const generated = [];
  const generatedKinds = Array(11).fill(0);
  for (let i = 0; i < 180; i++) {
    const wrap = choose(wrappers), end = [...wrap].reverse().join('');
    const labelWord = choose(['Confidence', 'Assessment', 'Rating']);
    const label = `${wrap}${labelWord}:${end}`;
    const value = `${wrap}${choose(['High', 'Medium', 'Low'])} (${choose([92, 75, 10])}%)${end}`;
    const prefix = choose(prefixes);
    const shapes = [
      `${prefix}${label} ${value}`,
      `${prefix}${label}\n\n${prefix}${value}`,
      `${label}\n==========\n${value}`,
      `| ${label} | ${value} |\n| --- | --- |`,
      `| Date | ${label} | Missing |\n| --- | --- | --- |\n| 2026-11-13 | ${value} | The statement is missing. |`,
      `| Field | Value |\n| --- | --- |\n| ${label} | ${value} |\n| Date | 2026-11-13 |`,
      `${prefix}${value}`,
      `| Date | ${label} | Score |\n| --- | --- | --- |\n| 2026-11-13 | ${wrap}High${end} | 92% |`,
      `${prefix}${label}\n92% (${wrap}High${end})`,
      `| ${label} |\n${value}`,
      `${prefix}${wrap}High confidence (92%)${end}`,
    ];
    const kind = choose(shapes.map((_, index) => index));
    generatedKinds[kind]++;
    const remove = kind === 0 && labelWord === 'Confidence' && prefix !== '## ' && !wrap.includes('~') && !wrap.includes('`');
    generated.push({ block: shapes[kind], remove });
  }
  assert.ok(generatedKinds.every(count => count > 0), 'the fixed seed reached every generated Markdown structure');
  for (const { block, remove } of [...reviewed.map(block => ({ block, remove: false })), ...generated]) {
    const body = { ...response(100), answer: `${prose}\n${block}\nMissing: The statement for November 14 is missing.` };
    fixtures.push(body);
    if (!remove) preserved.set(body, block);
  }
  for (const body of fixtures) {
    const original = JSON.stringify(body), internal = JSON.stringify(documentResponseConfidence(body));
    const remote = await remoteAnswer(body), cli = await cliAnswer(body);
    assert.equal(remote.calls, 1, 'the guard reached the real remote answer decision');
    let calls = 0;
    const local = await localMcp({ PROFILE: 'owner-assistant', call: async () => { calls++; return body; } },
      'runTool("brain_think", {q:"When is the review?"})').result;
    assert.equal(calls, 1, 'the guard reached the real local answer decision');
    assert.equal(JSON.stringify(local.confidence), internal, 'local MCP retains the canonical assessment');
    if (body === incomplete) {
      assert.equal(local.search_status, 'coverage_incomplete', 'the local provisional branch was reached');
      assert.match(local.note, /provisional/);
    }
    const outputs = [['remote', remote.text], ['CLI', cli.text], ['local MCP', local.answer ?? local.note],
      ...[app, { answerText, evidenceNoteText }].map((render, index) =>
        [`renderer ${index}`, [render.answerText(body), render.evidenceNoteText(body)].join('\n')])];
    for (const [label, output] of outputs) {
      if (body === incomplete) {
        assert.match(output, /Source coverage is incomplete/, `${label}: the real provisional answer decision was reached`);
        if (label !== 'local MCP') assert.match(output, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
      } else assert.match(output, /November 13 \[1\]/, `${label}: the substantive answer survives`);
      if (preserved.has(body)) assert.ok(output.includes(preserved.get(body)), `${label}: non-server layout survives byte-for-byte`);
      else assertOwner(output, label);
    }
    assert.equal(JSON.stringify(documentResponseConfidence(body)), internal);
    assert.equal(JSON.stringify(body), original, 'presentation preserves every input byte');
  }
  for (const profile of ['technician', 'break-glass', 'librarian', 'structured-contributor']) {
    const remote = await remoteAnswer(response(100), profile, 'How much did I spend last month?');
    assert.equal(remote.calls, 0);
    assert.match(remote.text, /brain_money_overview|This profile has no money SQL tools/, 'the populated handoff decision was reached');
    assertOwner(remote.text, `remote ${profile} handoff`);
    const handoff = moneyQuestionHandoff('How much did I spend last month?', {
      moneyToolsAvailable: ['librarian', 'structured-contributor'].includes(profile) });
    assert.equal(handoff.money_handoff, true);
    assertOwner(handoff.answer, `local ${profile} handoff`);
    assert.equal(handoff.confidence.percent, 0);
  }
  const fallback = unavailableMoneyOverview();
  assert.equal(fallback.status, 'partial');
  assertOwner(fallback.coverage_text, 'unavailable money overview');
  const f = overviewFixture(t);
  f.account('operating');
  f.coverage('operating', '2025-01-01', '2025-12-31');
  f.row('posted', 'operating', '2025-12-20', 12000);
  for (const pending of [false, true]) {
    if (pending) f.row('held', 'operating', '2025-12-21', 2500, 'outflow', { pending: true });
    const result = await overviewMoney(f.env, { now: () => Date.parse('2025-12-31T18:00:00Z') });
    assert.ok(f.calls.length > 0, 'the guard reached the real overview read');
    assert.equal(result.months[11].totals[0].money_in_minor, 12000);
    assertOwner(result.coverage_text, 'money overview');
    assert.equal(typeof result.confidence.percent, 'number');
    const cleaned = withMoneyConfidence(result);
    assertOwner(cleaned.coverage_text, 'money tool coverage');
    assert.deepEqual(cleaned.confidence, result.confidence);
  }
  t.diagnostic(`${fixtures.length} document fixtures across five owner surfaces; seed 0x1117, 180 generated blocks, structure counts ${generatedKinds.join('/')}; four profile handoffs; strong, pending and unavailable money coverage`);
});

test('F03 restricted and money-capable handoffs keep score instructions out of owner answers', async () => {
  for (const profile of ['technician', 'break-glass', 'librarian', 'structured-contributor']) {
    const available = ['librarian', 'structured-contributor'].includes(profile);
    const remote = await remoteAnswer(response(100), profile, 'How much did I spend last month?');
    assert.equal(remote.calls, 0, 'the populated money handoff was selected before document reading');
    assert.match(remote.text, available ? /brain_money_overview/ : /This profile has no money SQL tools/);
    assert.doesNotMatch(remote.text, /\bconfidence\b|\binternal score\b/i);
    assert.match(remote.text, /missing|no bank rows/i);
    if (!available) {
      assert.match(remote.text, /librarian or structured-contributor/);
      assert.match(remote.text, /current profile and access limits/);
      assert.match(remote.text, /Never add up search snippets/);
    }
    const local = moneyQuestionHandoff('How much did I spend last month?', { moneyToolsAvailable: available });
    assert.equal(local.money_handoff, true, 'the local money handoff decision was reached');
    assert.equal(local.money_tools_available, available);
    assert.equal(local.confidence.percent, 0);
    assert.match(local.confidence_text, /Confidence:/);
    assert.doesNotMatch(local.answer, /\bconfidence\b|\binternal score\b/i);
  }
  assert.match(MONEY_CAPABILITY_TRANSITION, /never raise/i, 'assistant-only policy remains available');
});

// R5 uses the populated real paths for both stripping and preservation. No
// absence assertion can pass on a response that missed the answer decision.
async function r5Outputs(answer) {
  const body = { ...response(100), answer }, before = JSON.stringify(body);
  const remote = await remoteAnswer(body), cli = await cliAnswer(body);
  assert.equal(remote.calls, 1, 'R5 reached the actual remote answer decision');
  const localMcp = await sourceModuleHarness(new URL('../components/brain-mcp.mjs', import.meta.url));
  let calls = 0;
  const local = await localMcp({ PROFILE: 'owner-assistant', call: async () => { calls++; return body; } },
    'runTool("brain_think", {q:"When is the review?"})').result;
  assert.equal(calls, 1, 'R5 reached the actual local answer decision');
  assert.equal(local.confidence.percent, 100);
  assert.equal(cli.result.confidence.percent, 100);
  const outputs = [remote.text, cli.text, local.answer, app.answerText(body), answerText(body)];
  for (const output of outputs) assert.ok(output.includes(prose), 'R5 populated answer control survived');
  assert.equal(JSON.stringify(body), before, 'R5 leaves every canonical input byte untouched');
  return outputs;
}

async function assertKeptBlock(block) {
  const missing = 'Missing: 2 statements are missing through November 14.';
  for (const output of await r5Outputs(`${prose}\n${block}\n${missing}`)) {
    assert.ok(output.includes(missing), 'R5 retains quantified missing evidence beside the badge');
    assert.ok(output.includes(block), 'R6 retains the complete non-server block');
  }
}

test('R5 populated green control removes an explicit badge and retains the answer', async () => {
  for (const output of await r5Outputs(`${prose}\n**Confidence:** High (92%)\nMissing: 2 statements.`)) {
    assert.ok(output.includes('Missing: 2 statements.'));
    assert.doesNotMatch(output, /Confidence:|92%/i);
  }
});

test('R5 F02 quantified missing evidence survives complete and pending assessment continuations', async t => {
  const exact = '10% of the statement pages are missing through November 14.';
  const sentences = [exact, 'I found 3 of 12 months.', '2 statements are missing.',
    'High coverage is incomplete: 2 statements are missing.',
    'Low coverage leaves 3 of 12 months unread.', 'Medium quality evidence is partial: 2 pages are missing.',
    'Assessment: 10% of the statement pages are missing.', 'Score: 2 statements are missing.'];
  // Generate a deterministic table of count, fraction and percentage sentences,
  // without a clock or model. Every sentence must survive in its original form.
  for (const n of [1, 2, 3, 10, 12, 25]) sentences.push(
    `${n}% of the statement pages are missing through November 14.`,
    `${n}% of the evidence is incomplete.`, `${n}% remains unread; the evidence is partial.`,
    `${n} statements are missing.`, `I found ${n} of 30 months.`,
    `(${n}%) of the pages are missing.`, `**${n}%** of the evidence is incomplete.`);
  const blocks = ['Confidence: High (92%)', 'Confidence:', '**Assessment:**\n**High (92%)**',
    '| Confidence | High (92%) |\n| --- | --- |'];
  let checks = 0;
  for (const sentence of sentences) for (const cited of [false, true]) for (const gap of ['\n', '\n\n']) {
    const evidence = `${sentence}${cited ? ' [1]' : ''}`;
    // A populated no-badge arm proves the sentence is ordinary evidence.
    for (const output of await r5Outputs(`${prose}\n${evidence}`)) assert.ok(output.includes(evidence));
    for (const block of blocks) {
      for (const output of await r5Outputs(`${prose}\n${block}${gap}${evidence}`)) {
        assert.ok(output.includes(evidence), `quantified evidence survives exactly: ${evidence}`);
        if (block === 'Confidence: High (92%)') assert.doesNotMatch(output, /Confidence: High \(92%\)/);
        else assert.ok(output.includes(block), 'R6 preserves the non-server block beside the evidence');
        checks++;
      }
    }
  }
  // Metadata reasons and missing lists pass the same boundary as the answer.
  const body = response(10);
  body.confidence.basis = [`Confidence: High (92%)\n${exact}`];
  body.confidence.missing = ['2 statements are missing.'];
  const before = JSON.stringify(body), remote = await remoteAnswer(body);
  assert.equal(remote.calls, 1);
  for (const output of [remote.text, app.evidenceNoteText(body), evidenceNoteText(body)]) {
    assert.ok(output.includes(exact.replace(/\.$/, '')));
    assert.ok(output.includes('2 statements are missing'));
  }
  assert.equal(JSON.stringify(body), before);
  t.diagnostic(`${sentences.length} sentences; ${checks} preservation checks across five real surfaces; cited/uncited and adjacent/blank-line arms`);
});

test('R6 migrated R5 separate Score labels stay with their complete block', async () => {
  for (const block of ['### Confidence\n- Rating: High\n- Score: 92%',
    '**Confidence:**\n**High**\n**Score:** 92%', 'Certainty: High (92%)']) await assertKeptBlock(block);
});

test('R6 migrated R5 hyphen and dash labels remain unchanged', async () => {
  for (const delimiter of ['-', '\u2013', '\u2014']) for (const label of ['Confidence', 'Assessment'])
    await assertKeptBlock(`> **${label}** ${delimiter} **High (92%)**`);
  await assertKeptBlock('### Confidence - High (92%)');
});

test('R6 migrated R5 linked assessment labels remain unchanged', async () => {
  for (const label of ['Confidence', 'Assessment', 'Score']) {
    await assertKeptBlock(`[${label}](#assessment): High (92%)`);
    const quoted = `[${label}](#assessment): High (92%) [1]`;
    for (const output of await r5Outputs(`${prose}\n${quoted}`)) assert.ok(output.includes(quoted), 'cited label control stays exact');
  }
});

test('R6 migrated R5 split labels and scores remain unchanged', async () => {
  for (const block of ['**Confidence**\n**score:** 92%', 'Confidence\nscore: 92%',
    '> Confidence\n> Score - 92%']) await assertKeptBlock(block);
});

test('R6 migrated R4 preserves reviewed blocks, columns and standalone rating words', async () => {
  const blocks = ['| Confidence | High (92%) |\n| --- | --- |', '### Confidence\nHigh (92%)',
    '**Confidence:**\n**High (92%)**', 'Confidence\n----------\nHigh (92%)',
    '> - __Assessment:__\n> - __Medium__\n> - (__75%__)',
    '| Date | **Confidence** | Missing |\n| --- | --- | --- |\n| 2026-11-13 | High (92%) | A statement is missing. |',
    '| Field | Value |\n| --- | --- |\n| Rating | Low (10%) |\n| Date | 2026-11-13 |',
    'High (92%)', '`Low`', 'Confidence: High (92%). Why: A statement is missing.',
    '### Confidence ###\n### High (92%) ###', 'Confidence\n92%',
    '> Assessment\n> Medium\n> (75%)',
    '| Date | Assessment | Score |\n| --- | --- | --- |\n| 2026-11-13 | High | 92% |',
    '| Confidence | High | 92% |\n| --- | --- | --- |',
    '| High (92%) |', '| Confidence |\n92%',
    'Confidence: 92% (High)', 'High confidence (92%)',
    'Confidence\nHigh because the statement was read.'];
  const leaked = [];
  for (const [index, block] of blocks.entries()) {
    const body = { ...response(100), answer: `${prose}\n${block}\nMissing: A statement is missing.` };
    const original = JSON.stringify(body), remote = await remoteAnswer(body);
    assert.equal(remote.calls, 1, 'the actual remote boundary was reached');
    for (const [surface, output] of [['remote', remote.text], ['app', app.answerText(body)], ['Worker', answerText(body)]]) {
      assert.match(output, /November 13 \[1\]/, 'populated answer control');
      assert.match(output, /A statement is missing/);
      if (!output.includes(block)) leaked.push([index, surface]);
      if (block.includes('2026-11-13')) assert.ok(output.includes('2026-11-13'), 'table facts survive column and row removal');
    }
    assert.equal(JSON.stringify(body), original, 'the whole internal record is unchanged');
  }
  assert.deepEqual(leaked, [], 'every non-server layout is retained completely');
  for (const block of blocks.slice(0, 4).concat(blocks.slice(10, 13), blocks.slice(14, 19))) {
    assert.equal(hideConfidenceLine(`${prose}\n${block}\nMissing: A statement is missing.`),
      `${prose}\n${block}\nMissing: A statement is missing.`, 'non-server blocks retain every heading, score and alignment byte');
  }
  const controls = `${prose}\nThe contract fee is 10% [1].\nThe high water mark was recorded on 2026-11-13.\nMissing: A statement is missing.`;
  assert.equal(hideConfidenceLine(controls), controls, 'source percentages, dates and ordinary high wording survive exactly');
  const table = '| Item | Value |\n| --- | --- |\n| Fee [1] | 10% |\n| Date | 2026-11-13 |';
  assert.equal(hideConfidenceLine(table), table, 'an unrelated populated source table is byte-identical');
  const contract = '$120 received in November 2026 [1].\nCoverage: Account ending 3333, from 2026-11-01 through 2026-11-13.\nMissing or counted twice: $25 is pending; the statement is missing.\nEstimates: likely incomplete because pending rows are excluded.\nHow to check: Compare the November 13 statement [1].';
  const body = { ...response(100), answer: `${contract}\nConfidence: High (92%)` };
  const remote = await remoteAnswer(body), cli = await cliAnswer(body);
  assert.equal(remote.calls, 1);
  for (const output of [remote.text, cli.text, app.answerText(body), answerText(body)]) {
    for (const line of contract.split('\n')) assert.ok(output.includes(line), 'each of the five answer parts survives exactly');
    assert.doesNotMatch(output, /Confidence|High|92%/);
  }
});

test('R4 cited source tables retain their exact evidence beside generated assessment controls', () => {
  const plain = '| Date | Source |\n| --- | --- |\n| 2026-11-13 | Record [1] |';
  assert.equal(hideConfidenceLine(plain), plain, 'populated source table control');
  for (const source of [
    '| Field | Value |\n| --- | --- |\n| Confidence | High (92%) [1] |',
    '| Confidence | Source |\n| --- | --- |\n| High (92%) [1] | Record [1] |',
    '| Confidence | High (92%) [1] |\n| --- | --- |',
  ]) assert.equal(hideConfidenceLine(source), source, 'cited source assessment tables retain their exact evidence');
});

test('R4 money and error prose share the owner boundary without changing canonical score fields', async () => {
  const badge = '**Confidence: High (92%)**';
  const body = { confidence: { level: 'High', percent: 100, reasons: [], missing: [] },
    coverage_text: `Accounts ending 3333, from 2026-11-01 through 2026-11-13.\n${badge}`,
    error: `${badge}\nThe statement is missing.`, next_step: `Read the statement.\n${badge}` };
  const before = JSON.stringify(body), cleaned = withMoneyConfidence(body);
  for (const field of ['coverage_text', 'error', 'next_step']) {
    assert.ok(cleaned[field].length > 10, 'populated money prose decision reached');
    assert.doesNotMatch(cleaned[field], /confidence|High|92%/i);
  }
  assert.equal(JSON.stringify(cleaned.confidence), JSON.stringify(body.confidence));
  assert.match(cleaned.confidence_text, /High.*100%/);
  assert.equal(JSON.stringify(body), before);
  const { moneyQueryErrorText } = await import('../worker/src/lib/money-query-contract.js');
  const error = moneyQueryErrorText({ code: 'MONEY_QUERY_INVALID', error: `${badge}\nThe statement is missing.` });
  assert.match(error, /statement is missing.*Support code: MONEY_QUERY_INVALID/s);
  assert.doesNotMatch(error, /confidence|High|92%/i);
  const cliBody = { ...response(100), answer_error: `${badge}\nThe statement is missing.` };
  const cli = await cliAnswer(cliBody);
  assert.equal(cli.result.answer_error, cliBody.answer_error, 'the CLI retains its internal error record');
  assert.match(cli.text, /statement is missing/);
  assert.doesNotMatch(cli.text, /confidence|High|92%/i, 'the actual CLI warning uses the owner boundary');
  for (const render of [app, await import('../worker/src/lib/answer-render.js')]) {
    const composed = render.finalAnswerText(`The statement is missing.\n${badge}`, undefined);
    assert.equal(composed, 'The statement is missing.\n');
    const reason = render.answerReasonText({ evidence_gate: { reason: `The statement is missing.\n${badge}` } });
    assert.equal(reason, 'The statement is missing.');
    const gaps = render.moneyExplanation({ gaps: [{ type: 'ledger_out_of_coverage', detail: `The statement is missing.\n${badge}` }] });
    assert.equal(gaps, 'The statement is missing.\n');
    const output = render.safeAnswerErrorText('unknown');
    assert.ok(output.length > 10, 'reviewed error envelope decision reached');
    assert.doesNotMatch(output, /confidence|\bHigh\b|92%/i);
  }
});

test('local MCP brain_think hides a compatibility badge and preserves the internal assessment', async () => {
  const localMcp = await sourceModuleHarness(new URL('../components/brain-mcp.mjs', import.meta.url));
  for (const percent of [100, 10]) {
    const body = response(percent);
    body.answer += `\nConfidence: ${body.confidence.band} (${percent}%)`;
    let calls = 0;
    const { result } = localMcp({ PROFILE: 'owner-assistant', call: async () => { calls++; return body; } },
      'runTool("brain_think", {q:"When is the review?"})');
    const out = await result;
    assert.equal(calls, 1, 'the complete local MCP tool path was reached');
    assert.equal(out.answer, `${prose}\n`);
    assert.doesNotMatch(out.answer, hidden);
    assert.equal(out.confidence.percent, percent);
    assert.equal(JSON.stringify(out.citations), JSON.stringify(body.citations));
  }
});

test('CLI answers hide scores while retaining the answer, sources and internal value', async () => {
  const root = mkdtempSync(join(process.env.HOME, 'confidence-cli-'));
  const manifest = join(root, 'brain.manifest.json');
  const keyFile = join(root, '.brain-admin-key');
  writeFileSync(keyFile, ['fixture', 'key'].join('-'), { mode: 0o600 });
  writeFileSync(manifest, JSON.stringify({ client: { slug: 'fixture' }, brain: { domain: 'fixture.invalid' },
    operations: { admin_key_secret: null } }));
  try {
    for (const percent of [100, 10]) {
      const body = response(percent), lines = [], original = console.log;
      let calls = 0, result;
      try {
        console.log = (...parts) => lines.push(parts.join(' '));
        result = await cmdAsk(manifest, { ask: async () => 'When is the review?', adminKey: readFileSync(keyFile, 'utf8'),
          http: async () => { calls++; return new Response(JSON.stringify(body)); } });
      } finally { console.log = original; }
      assert.equal(calls, 1, 'the real CLI answer decision was reached');
      assert.equal(result.confidence.percent, percent);
      assert.match(lines.join('\n'), /November 13 \[1\]/);
      assert.match(lines.join('\n'), /Review memo/);
      assert.doesNotMatch(lines.join('\n'), hidden);
      assert.equal(/may be incomplete/.test(lines.join('\n')), percent < 100);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('remote MCP ask keeps citations and the evidence decision with a plain thin-evidence note', async () => {
  for (const percent of [100, 10]) {
    let calls = 0;
    const body = response(percent);
    const request = new Request('https://fixture.invalid/mcp', { method: 'POST', body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { question: 'When is the review?' } },
    }) });
    const result = await (await handleMcp({}, request, new URL(request.url), {
      grant: { profile: 'librarian' }, think: async () => { calls++; return body; },
    })).json();
    assert.equal(calls, 1, 'the MCP ask decision was reached');
    const text = result.result.content[0].text;
    assert.match(text, /November 13 \[1\]/);
    assert.match(text, /\[1\] Review memo/);
    assert.doesNotMatch(text, hidden);
    assert.equal(/may be incomplete/.test(text), percent < 100);
    assert.equal(body.confidence.percent, percent);
  }
});

test('app and Worker presentation hide score lines without changing the source answer or score', () => {
  for (const percent of [100, 10]) {
    const body = response(percent);
    for (const render of [app, { answerText, confidenceText, evidenceNoteText }]) {
      assert.equal(render.answerText(body), prose, 'the real answer renderer was reached');
      const note = render.evidenceNoteText(body);
      assert.doesNotMatch(note, hidden);
      assert.equal(Boolean(note), percent < 100);
      if (note) { assert.doesNotMatch(note, /\d|\b(?:High|Medium|Low)\b/i); assert.equal(note.match(/[.!?]/g).length, 1); }
    }
    assert.equal(body.confidence.percent, percent);
    assert.match(confidenceText(body), /Confidence:/, 'internal assessment text is retained');
  }
});

test('money handoff and coverage prose hide scores while JSON keeps them', () => {
  const handoff = moneyQuestionHandoff('How much did I spend last month?');
  assert.ok(handoff.money_handoff, 'the money routing decision was reached');
  assert.doesNotMatch(handoff.answer, hidden);
  assert.equal(handoff.confidence.percent, 0);
  assert.match(handoff.confidence_text, /Confidence:/, 'canonical scoring text remains internal');
  const overview = unavailableMoneyOverview();
  assert.equal(overview.status, 'partial');
  assert.doesNotMatch(overview.coverage_text, hidden);
  assert.equal(overview.confidence.percent, 0);
  const good = withMoneyConfidence({ rows: [{ cents: 12000 }], confidence: { level: 'High', percent: 100, reasons: [], missing: [] } });
  assert.equal(good.rows[0].cents, 12000);
  assert.equal(good.confidence.percent, 100);
  const legacy = withMoneyConfidence({ ...good, coverage_text: 'Account coverage is incomplete.\nConfidence: High (100%). Why: A statement is missing.' });
  assert.equal(legacy.coverage_text, 'Account coverage is incomplete.\nConfidence: High (100%). Why: A statement is missing.', 'R6 retains inline evidence without editing words');
  assert.match(legacy.coverage_text, /A statement is missing/);
  assert.equal(legacy.confidence.percent, 100, 'presentation never alters the internal tool score');
});

test('real money overview keeps quantified evidence and internal scores without an owner badge', async t => {
  const f = overviewFixture(t);
  f.account('operating');
  f.coverage('operating', '2025-01-01', '2025-12-31');
  f.row('posted', 'operating', '2025-12-20', 12000);
  const strong = await overviewMoney(f.env, { now: () => Date.parse('2025-12-31T18:00:00Z') });
  assert.ok(f.calls.length > 0, 'the real overview read decision was reached');
  assert.equal(strong.months[11].totals[0].money_in_minor, 12000);
  assert.equal(typeof strong.confidence.percent, 'number');
  assert.deepEqual((await overviewMoney(f.env, { now: () => Date.parse('2025-12-31T18:00:00Z') })).confidence, strong.confidence, 'identical evidence retains the canonical assessment');
  assert.doesNotMatch(strong.coverage_text, hidden);
  f.row('held', 'operating', '2025-12-21', 2500, 'outflow', { pending: true });
  const thin = await overviewMoney(f.env, { now: () => Date.parse('2025-12-31T18:00:00Z') });
  assert.equal(thin.accounts[0].pending_rows, 1, 'pending-row evidence decision was reached');
  assert.ok(thin.confidence.percent < 100);
  assert.equal(thin.months[11].totals[0].money_in_minor, 12000);
  assert.doesNotMatch(thin.coverage_text, hidden);
  assert.match(thin.coverage_text, /\$25\.00/);
  assert.match(thin.coverage_text, /may be incomplete/);
  assert.match(thin.confidence_text, /Confidence:/);
});

test('compatibility inline ratings retain reasons, substantive percentages and cited source text', () => {
  const line = 'Confidence: Low (10%). Why: The search did not complete. Missing: A complete search.';
  assert.equal(hideConfidenceLine(prose), prose, 'a populated plain answer is the green control');
  assert.equal(hideConfidenceLine(line), line, 'R6 preserves the complete line containing evidence');
  const quoted = 'Confidence: High (92%) [1]';
  assert.equal(hideConfidenceLine(quoted), quoted, 'a cited source statement remains exact');
  assert.equal(hideConfidenceLine('The contract fee is 10% [1].'), 'The contract fee is 10% [1].');
});

test('compatibility answers remove exact server lines and preserve other assessment formats', () => {
  for (const badge of ['Confidence: 92%', 'Confidence: High', 'Confidence: High 92%', '**Confidence:** High (92%)', '**Confidence: High (92%)**', 'Confidence:High(92%)']) {
    const body = { ...response(100), answer: `${prose}\n${badge}` };
    for (const render of [app.answerText, answerText]) {
      const output = render(body);
      assert.match(output, /November 13 \[1\]/, 'the populated answer decision was reached');
      const serverFormat = badge === '**Confidence:** High (92%)' || badge === '**Confidence: High (92%)**';
      assert.equal(output, serverFormat ? `${prose}\n` : body.answer);
      if (serverFormat) assert.doesNotMatch(output, hidden);
      else assert.ok(output.includes(badge));
    }
  }
});

test('agent instructions no longer request owner score lines and preserve internal ceilings', () => {
  const paths = ['skills/financial-brain-technician/SKILL.md', 'templates/owner-contract/answer-contract-v1.md',
    ...['v2', 'v3'].flatMap(version => ['', '-windows'].map(platform => `templates/owner-contract/money-rules-${version}${platform}.md`))];
  const texts = [MONEY_GUIDE, MONEY_ANSWER_INSTRUCTIONS, MONEY_CONFIDENCE_INSTRUCTIONS,
    MONEY_SQL_SAFETY_INSTRUCTIONS, MONEY_CAPABILITY_TRANSITION, ...MONEY_TOOLS.map(tool => tool.description),
    ...paths.map(path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))];
  assert.ok(texts.length > 10, 'all instruction surfaces were read');
  for (const text of texts) {
    assert.doesNotMatch(text, /Confidence\s*:|(?:print|put|append) (?:the )?confidence(?:\.line| line| and)/i);
  }
  assert.match(MONEY_CONFIDENCE_INSTRUCTIONS, /never raise/i);
  assert.match(MONEY_CONFIDENCE_INSTRUCTIONS, /consistent_with_certificate/);
  assert.match(MONEY_ANSWER_INSTRUCTIONS, /five|5\./);
});

test('generated assistant workspace rules hide scores on both platforms and answer models', () => {
  let rendered = 0;
  for (const platformName of ['darwin', 'win32']) for (const assistant of ['claude', 'codex']) {
    for (const answerSetup of ['built-in', 'opus-sonnet']) {
      const text = renderOwnerRulesSection({ platformName, assistant, answerSetup });
      rendered++;
      assert.match(text, /five/);
      assert.match(text, /Never raise a returned score/);
      assert.match(text, /Never add confidence labels or percentages/);
      assert.doesNotMatch(text, /Confidence\s*:|Put confidence\.line in the answer/);
    }
  }
  assert.equal(rendered, 8, 'all actual workspace rendering branches were reached');
  for (const commands of [TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS]) {
    assert.equal(commands.filter(command => command === 'node --test test/conf-hide-1117.test.mjs').length, 1);
  }
});

test('frozen score comparator rejects a changed level, percent or missing case with a populated green control', () => {
  const baseline = [{ name: 'fixture', knownSkip: false, scores: [['queryMoney', 'High', 'High', 95]], failure: null }];
  assertSameLevels(baseline, structuredClone(baseline));
  for (const [index, value] of [[1, 'Medium'], [2, 'Medium'], [3, 89]]) {
    const changed = structuredClone(baseline);
    changed[0].scores[0][index] = value;
    assert.throws(() => assertSameLevels(baseline, changed), /byte-identical/);
  }
  assert.throws(() => assertSameLevels(baseline, []), /byte-identical/);
  assert.throws(() => assertSameLevels([], []), /populated baseline/);
});

test('all frozen internal confidence levels and percentages remain byte-identical to HEAD', t => {
  const receipt = replayFrozenLevels(t);
  t.diagnostic(`${receipt.cases} frozen cases; ${receipt.scores} internal confidence observations; identical to HEAD ${receipt.head}`);
});

test('R6 populated green control reaches all five owner surfaces without a badge', async () => {
  const fact = 'Missing: 2 statements through November 14.';
  for (const output of await r5Outputs(`${prose}\n${fact}`)) assert.ok(output.includes(fact));
});

test('R6 evidence sentences with labels and rating words survive byte-for-byte', async t => {
  const sentences = [
    'Assessment: High-resolution scans are missing for November 14.',
    'Assessment: Low-resolution scans are incomplete; 2 pages are missing.',
    'Assessment: Low coverage leaves 3 of 12 months unread.',
  ];
  let seed = 0x1117;
  const choose = values => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return values[seed % values.length]; };
  const labels = ['Assessment:', 'Confidence:', 'Rating:', 'Score:', 'Certainty:', 'Assessment -'];
  const ratings = ['High', 'Medium', 'Low'];
  const seenLabels = new Set(), seenRatings = new Set();
  for (let n = 0; n < 180; n++) {
    const label = choose(labels), rating = choose(ratings);
    seenLabels.add(label); seenRatings.add(rating);
    sentences.push(`${label} ${rating}${choose(['-resolution scans', ' coverage', ' quality evidence'])} ${choose(['is incomplete', 'is missing', 'remains unread'])}; ${choose([2, 3, 12])} pages through November 14.`);
  }
  assert.equal(seenLabels.size, labels.length, 'the seed exercises every label');
  assert.equal(seenRatings.size, ratings.length, 'the seed exercises every rating word');
  const badge = 'Confidence: High (92%)';
  let checks = 0;
  for (const sentence of sentences) for (const cite of ['', ' [1]']) {
    const evidence = `${sentence}${cite}`;
    assert.equal(hideConfidenceLine(evidence), evidence, 'the boundary preserves the complete evidence line');
    for (const output of await r5Outputs(`${prose}\n${badge}\n${evidence}`)) {
      assert.ok(output.includes(evidence), `exact evidence survives: ${evidence}`);
      assert.doesNotMatch(output, /Confidence: High \(92%\)/, 'the explicit badge removal decision is also reached');
      checks++;
    }
  }
  t.diagnostic(`${sentences.length} fixed-seed evidence sentences; ${checks} preservation checks across five populated surfaces`);
});

test('R6 enumerated standalone server formats are removed only as whole lines', async t => {
  // The standalone format is shared by money-confidence.js:confidenceText,
  // money-query-confidence.js:moneyConfidence and the frozen baseline's line /
  // display fields. Document ownerConfidenceLine adds evidence on the same
  // line and deliberately does not qualify for removal.
  const frozen = JSON.parse(readFileSync(new URL('../worker/test/fixtures/newest-wins-money-baseline-1114.json', import.meta.url), 'utf8'));
  const emitted = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (['line', 'display', 'confidence_text'].includes(key) && typeof item === 'string' && item.startsWith('Confidence: ')) emitted.add(item.split('\n')[0]);
      else if (item && typeof item === 'object') visit(item);
    }
  };
  visit(frozen);
  const standalone = [...emitted].filter(line => !line.includes('. Why:'));
  assert.ok(standalone.length > 0, 'the frozen server-format enumeration is populated');
  for (const line of standalone) assert.match(line, /^Confidence: (High|Medium|Low) \((100|[1-9]?\d)%\)$/);
  const wrappers = ['', '*', '**', '***', '_', '__', '___'];
  const prefixes = ['', '- ', '+ ', '* ', '1. ', '1) ', '> ', '> - ', '> > 2. '];
  let checks = 0;
  for (const level of ['High', 'Medium', 'Low']) for (const percent of [0, 10, 69, 70, 89, 90, 92, 100])
    for (const wrap of wrappers) for (const prefix of prefixes) {
      const badge = `${prefix}${wrap}Confidence: ${level} (${percent}%)${wrap}`;
      assert.equal(hideConfidenceLine(`Before [1].\n${badge}\nAfter: 2 pages missing.`), 'Before [1].\nAfter: 2 pages missing.');
      checks++;
    }
  const examples = [...standalone, '**Confidence:** **High** (**92%**)', '_Confidence:_ _Low_ (_10%_)'];
  for (const badge of examples) for (const output of await r5Outputs(`${prose}\n${badge}\nMissing: 2 statements.`)) {
    assert.ok(output.includes('Missing: 2 statements.'));
    assert.doesNotMatch(output.replace(/[*_]/g, ''), /Confidence: (High|Medium|Low) \(\d+%\)/);
  }
  t.diagnostic(`${standalone.length} frozen standalone values; ${checks} whole-line format checks; bold/italic and list/quote variants`);
});

test('R6 other labels, inline ratings, split blocks and tables stay unchanged', async () => {
  const cases = ['Assessment: High (92%)', 'Rating: Low (10%)', 'Score: 92%', 'Certainty: High (92%)',
    'Confidence: 92%', 'Confidence: High', 'Confidence: High 92%', 'Confidence:High(92%)',
    'Confidence: High (101%)', 'Confidence: High (092%)', 'Confidence: High (92.5%)',
    'Confidence: Certain (92%)', 'confidence: High (92%)',
    'Confidence: High (92%). Why: 2 pages are missing. Missing: The November 14 scan.',
    'Before Confidence: High (92%)', 'Confidence: High (92%) after the November 14 scan.',
    'Confidence: High (92%) [1]', '**Confidence:**\n**High (92%)**',
    '| Assessment rating | Detail |\n| --- | --- |\n| High | The November 14 statement is missing. |',
    '| Confidence | High (92%) |\n| --- | --- |',
    'The compatibility ledger reading has no money-tool confidence assessment.', confidenceText(response(10)),
  ];
  for (const value of cases) {
    assert.equal(hideConfidenceLine(value), value, 'the complete non-format input is byte-identical');
    for (const output of await r5Outputs(`${prose}\n${value}`)) assert.ok(output.includes(value), 'all five surfaces preserve the non-format block');
  }
});

test('R6 the boundary preserves nonmatching bytes and original line terminators', () => {
  for (const eol of ['\n', '\r\n']) {
    const before = `  Missing: 2 pages.  ${eol}`, after = `\tSource fee: 10% [1].  ${eol}${eol}`;
    assert.equal(hideConfidenceLine(before + after), before + after, 'untouched evidence retains all whitespace');
    assert.equal(hideConfidenceLine(`${before}> **Confidence: High (92%)**${eol}${after}`), before + after,
      'only the matching line and its own terminator disappear');
  }
  for (const value of [null, undefined, 0, { answer: prose }]) assert.equal(hideConfidenceLine(value), value);
});

test('R6 cited compatibility metadata retains its source words through the note formatter', async () => {
  const body = response(10);
  const cited = 'The compatibility ledger reading has no money-tool confidence assessment. [1]';
  body.confidence.basis = [cited];
  const before = JSON.stringify(body), remote = await remoteAnswer(body);
  assert.equal(remote.calls, 1, 'the real metadata-note decision was reached');
  for (const output of [remote.text, app.evidenceNoteText(body), evidenceNoteText(body)]) {
    assert.ok(output.includes(cited), 'cited metadata retains the exact source words');
  }
  assert.equal(JSON.stringify(body), before, 'canonical metadata remains unchanged');
});

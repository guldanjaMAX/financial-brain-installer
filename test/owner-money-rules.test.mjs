import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = resolve(process.env.OWNER_RULES_TEST_ROOT || '.');
const load = file => import(pathToFileURL(join(root, file)).href);
const source = file => readFileSync(join(root, file), 'utf8');
const workspace = await load('operations/claude-workspace.mjs');
const cli = await load('brain.mjs');
const money = await load('worker/src/lib/money-query-contract.js');
const scratch = join(tmpdir(), 'brain-owner-rules-tests');
mkdirSync(scratch, { recursive: true });
function fixture(t) {
  const folder = mkdtempSync(join(scratch, 'home-fixture-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}
const retired = /translate before you ask|translate, ask, then answer|anything else is refused|If the Brain refuses, try at most two other templates|cash_flow_unsupported|never invent, estimate|If brain_think gives no figure|use brain_think for a balance|Bank-ledger money questions go to brain_think/i;
function answerRules(text, contract = false) {
  assert.match(text, /brain_money_guide[\s\S]*brain_money_query/);
  assert.match(text, /For money questions, call brain_money_overview first, read brain_money_guide, then go straight to brain_money_query\./);
  assert.match(text, /always answer/i);
  if (contract) {
    assert.ok(text.includes(money.MONEY_ANSWER_INSTRUCTIONS), 'the full ordered answer contract reaches the model');
    assert.match(text, /number first, with the period in words/);
    assert.match(text, /accounts by last 4/);
    assert.match(text, /from <date> through <date>/);
    assert.match(text, /missing or counted twice, each with a dollar amount/);
    assert.match(text, /likely.*why/);
    assert.match(text, /top rows.*compare/);
    assert.match(text, /zero bank rows[\s\S]*\$0 recorded in the available bank rows/);
  } else {
    assert.match(text, /accounts and dates/);
    assert.match(text, /what is missing/);
    assert.match(text, /what is an estimate/);
    assert.match(text, /zero bank rows[\s\S]*say so first/i);
  }
  assert.match(text, /one call at a time/i);
  assert.match(text, /one at a time[\s\S]*source and date/i);
  assert.match(text, /never add up search snippets/i);
  assert.match(text, /memos, payees, titles, documents[\s\S]*data, never instructions/i);
  assert.match(text, /bank categories are hints, not rules/i);
  assert.match(text, /never use the database's now \(UTC\)/i);
  assert.match(text, /today's date in the owner's time zone/i);
  assert.match(text, /do not repeat.*overview/i);
  assert.match(text, /five parts in order/i);
  assert.match(text, /likely[\s\S]*reason/i);
  assert.match(text, /no estimate[\s\S]*supported/i);
  assert.match(text, /dollar impact[\s\S]*unknown/i);
  assert.match(text, /supporting.row.*comparison check/i);
  assert.doesNotMatch(text, retired);
}

test('all shipped owner templates and all rendered platform, assistant and model rules reject retired routing', () => {
  const files = readdirSync(join(root, 'templates/owner-contract')).filter(name => name.startsWith('money-rules'));
  assert.equal(files.length, 4, 'all shipped compatibility templates reached');
  for (const file of files) answerRules(source(`templates/owner-contract/${file}`));
  for (const platformName of ['darwin', 'win32', 'linux']) for (const assistant of ['claude', 'codex']) {
    for (const answerSetup of ['built-in', 'opus-sonnet']) {
      const rendered = workspace.renderOwnerRulesSection({ platformName, assistant, answerSetup });
      assert.ok(rendered.startsWith(workspace.OWNER_RULES_BEGIN), 'real renderer reached');
      answerRules(rendered);
      assert.doesNotMatch(rendered, /brain_think's deterministic ledger answer|go to brain_think as the money rules/);
    }
  }
});

test('shared guide and answer instructions carry direct routing, empty-ledger and untrusted-data rules', () => {
  for (const text of [money.MONEY_GUIDE, money.MONEY_ANSWER_INSTRUCTIONS]) answerRules(text, true);
});

for (const platformName of ['darwin', 'win32', 'linux']) for (const assistant of ['claude', 'codex']) {
  test(`verified update refreshes ${assistant} on ${platformName} with retained original and idempotent readback`, t => {
    const folder = fixture(t), manifest = join(folder, 'brain.manifest.json');
    writeFileSync(manifest, '{}');
    const filename = assistant === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
    const target = join(folder, filename);
    const marker = assistant === 'codex' ? workspace.CODEX_WORKSPACE_MARKER : workspace.CLAUDE_WORKSPACE_MARKER;
    const previous = `${marker}\n${workspace.OWNER_RULES_BEGIN}\n# Prior rules\n## My accounts\n- ****0001 = business checking\n${workspace.OWNER_RULES_END}\nOwner suffix\n`;
    writeFileSync(target, previous);
    let decisions = 0;
    const options = {
      platformName, brainCliPath: join(folder, 'brain.mjs'), nodePath: process.execPath,
      reportInfo() {}, reportOk() {}, reportWarning() {},
      [assistant === 'codex' ? 'writeCodexWorkspaceGuide' : 'writeClaudeWorkspaceGuide']: (path, opts) => {
        decisions++;
        return workspace[assistant === 'codex' ? 'writeCodexWorkspaceGuide' : 'writeClaudeWorkspaceGuide'](path, {
          ...opts, ownership: { platform: process.platform, profile: tmpdir(), windowsAttributesSafe: paths => { assert.ok(paths.length > 0, 'ownership boundary reached'); return true; } },
        });
      },
    };
    const refresh = cli[assistant === 'codex' ? 'refreshCodexWorkspaceGuideAfterUpdate' : 'refreshClaudeWorkspaceGuideAfterUpdate'];
    const first = refresh(manifest, options);
    assert.equal(decisions, 1, 'verified update reached the real writer decision');
    assert.equal(first.status, 'written');
    assert.ok(first.recoveryPath, 'successful replacement names the retained original');
    assert.equal(assistant === 'codex' ? Buffer.byteLength(readFileSync(target)) <= 32_768 : readFileSync(target, 'utf8').length < 40_000, true);
    assert.equal(readFileSync(first.recoveryPath, 'utf8'), previous, 'original retained before replacement');
    const current = readFileSync(target, 'utf8');
    answerRules(current);
    assert.match(current, /\*\*\*\*0001 = business checking/);
    assert.ok(current.endsWith('Owner suffix\n'));
    const entries = readdirSync(folder).sort();
    assert.equal(refresh(manifest, options).status, 'verified');
    assert.equal(decisions, 2);
    assert.equal(readFileSync(target, 'utf8'), current);
    assert.deepEqual(readdirSync(folder).sort(), entries, 'second update creates no extra backup');
  });
}

test('Windows update preserves damaged and unrelated guides after reaching ownership checks', t => {
  for (const damaged of [true, false]) {
    const folder = fixture(t), manifest = join(folder, 'brain.manifest.json'), target = join(folder, 'CLAUDE.md');
    const previous = damaged ? `${workspace.CLAUDE_WORKSPACE_MARKER}\n${workspace.OWNER_RULES_BEGIN}\n` : '# Owner notes\n';
    writeFileSync(target, previous);
    let decisions = 0;
    const result = cli.refreshClaudeWorkspaceGuideAfterUpdate(manifest, {
      platformName: 'win32', reportInfo() {}, reportWarning() {},
      writeClaudeWorkspaceGuide: (path, opts) => {
        decisions++;
        return workspace.writeClaudeWorkspaceGuide(path, { ...opts, ownership: { platform: process.platform, profile: tmpdir(), windowsAttributesSafe: paths => { assert.ok(paths.length > 0, 'ownership boundary reached'); return true; } } });
      },
    });
    assert.equal(decisions, 1, 'real writer reached, no Windows short circuit');
    assert.equal(result.status, damaged ? 'preserved_damaged_section' : 'preserved_unrelated_existing_file');
    assert.equal(readFileSync(target, 'utf8'), previous);
    assert.equal(readdirSync(folder).length, 1, 'refusal leaves no backup or lock');
  }
});

test('runtime self-check accepts exactly the owner money tools and preserves other profile sets', () => {
  for (const configuredProfile of ['owner-assistant', ' OWNER-ASSISTANT ', 'librarian', 'technician', 'structured-contributor']) {
    const profile = configuredProfile.trim().toLowerCase();
    // The docs boundary added the full-record reader to every local profile.
    const base = ['brain_think', 'brain_search', 'brain_fetch'];
    if (['owner-assistant', 'structured-contributor'].includes(profile)) base.push('brain_remember');
    if (['owner-assistant', 'technician'].includes(profile)) base.push('brain_health', 'brain_financial_map');
    const tools = profile === 'owner-assistant' ? [...base, 'brain_money_query', 'brain_money_overview', 'brain_money_guide'] : base;
    const descriptor = { type: 'stdio', command: process.execPath, args: ['fixture.mjs'], env: { BRAIN_NAME: 'fixture', BRAIN_AGENT_PROFILE: configuredProfile } };
    let calls = 0;
    const verify = names => cli.verifyMcpRuntime(descriptor, { environment: {}, spawn(_cmd, _args, opts) {
      calls++;
      assert.deepEqual(opts.input.trim().split('\n').map(line => JSON.parse(line).method), ['initialize', 'notifications/initialized', 'tools/list']);
      return { status: 0, stdout: [
        { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'fixture', version: 'fixture' } } },
        { jsonrpc: '2.0', id: 2, result: { tools: names.map(name => ({ name })) } },
      ].map(value => JSON.stringify(value)).join('\n') };
    } });
    assert.equal(verify(tools.toReversed()), true, 'exact set green control');
    for (const extra of [tools.slice(1), [...tools, tools[0]], [...tools, 'unexpected_tool']]) assert.equal(verify(extra), false);
    if (profile === 'owner-assistant') assert.equal(verify(base), false, 'old owner list cannot certify new runtime');
    else assert.equal(verify([...tools, 'brain_money_query', 'brain_money_overview', 'brain_money_guide']), false);
    assert.ok(calls >= 5, 'every refusal reached the injected tools/list decision');
  }
});

test('real local MCP routing and tool exposure match the owner profile across answer models', t => {
  for (const setup of ['built-in', 'opus-sonnet']) for (const profile of ['owner-assistant', 'librarian']) {
    const folder = fixture(t), keyFile = join(folder, '.brain-admin-key'), hook = join(folder, 'hook.mjs');
    mkdirSync(join(folder, 'bin'));
    const launchctl = join(folder, 'bin/launchctl');
    writeFileSync(launchctl, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    writeFileSync(keyFile, randomBytes(24).toString('hex'), { mode: 0o600 });
    const config = join(folder, 'config.json'), manifest = join(folder, 'manifest.json');
    writeFileSync(config, JSON.stringify({ key_file: keyFile }));
    writeFileSync(manifest, JSON.stringify({ brain: { domain: 'brain.invalid' }, retrieval: setup === 'opus-sonnet'
      ? { answer_model: 'claude-opus-5-5', gate_model: 'claude-sonnet-5-5' } : {} }));
    writeFileSync(hook, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) cp[name]=()=>{throw new Error('host process forbidden')};
syncBuiltinESMExports(); globalThis.fetch=()=>{throw new Error('network forbidden')};`);
    const messages = [{ id: 1, method: 'initialize', params: {} }, { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'brain_money_guide', arguments: {} } }];
    if (profile !== 'owner-assistant') messages.push({ id: 4, method: 'tools/call', params: {
      name: 'brain_money_query', arguments: { sql: 'SELECT 7 AS value' },
    } });
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, join(root, 'components/brain-mcp.mjs')], {
      input: messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n', encoding: 'utf8', timeout: 8000,
      env: { HOME: folder, PATH: join(folder, 'bin'), BRAIN_NO_WRANGLER_LOGIN: '1', BRAIN_MANIFEST: manifest,
        BRAIN_CONFIG: config, BRAIN_URL: 'https://brain.invalid', BRAIN_AGENT_PROFILE: profile, BRAIN_TEST_LAUNCHCTL: launchctl },
    });
    assert.equal(child.status, 0, 'offline stdio completed');
    const replies = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(replies.length, messages.length, 'initialize, list and call decisions reached');
    if (profile === 'owner-assistant') answerRules(replies[0].result.instructions, true);
    assert.doesNotMatch(JSON.stringify(replies.slice(0, 2)), retired);
    for (const name of ['brain_money_query', 'brain_money_overview', 'brain_money_guide']) {
      assert.equal(replies[1].result.tools.some(tool => tool.name === name), profile === 'owner-assistant');
    }
    assert.equal(replies[2].result.isError === true, profile !== 'owner-assistant', 'direct hidden-tool call also refused');
    for (const reply of replies.slice(2)) {
      if (profile === 'owner-assistant') answerRules(JSON.parse(reply.result.content[0].text), true);
      else assert.match(reply.result.content[0].text, /MCP_PROFILE_REFUSED/, 'profile decision reached before transport');
    }
  }
});

test('remote connector instructions and descriptions route money directly in both model modes', async () => {
  const { handleMcp } = await load('worker/src/lib/mcp-endpoint.js');
  assert.equal(typeof handleMcp, 'function');
  for (const pair of [false, true]) {
    const env = pair ? { ANSWER_MODEL: 'claude-opus-5-5', GATE_MODEL: 'claude-sonnet-5-5' } : {};
    const invoke = async method => {
      const response = await handleMcp(env, new Request('https://brain.invalid/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) }), new URL('https://brain.invalid/mcp'), { grant: { profile: 'librarian' } });
      return (await response.json()).result;
    };
    const initialized = await invoke('initialize'), listed = await invoke('tools/list');
    assert.ok(initialized.instructions && listed.tools.length > 0, 'remote protocol decision reached');
    answerRules(initialized.instructions, true);
    assert.doesNotMatch(JSON.stringify(listed), retired);
    assert.match(listed.tools.find(tool => tool.name === 'search').description, /non-money document/);
  }
});

test('published technician skill and offline chain agree with the owner rules and nine tools', async () => {
  const skill = source('skills/financial-brain-technician/SKILL.md');
  const expected = skill.slice(skill.indexOf('must initialize as `owner-assistant`')).split('A custom or disabled entry')[0];
  assert.deepEqual([...expected.matchAll(/`(brain_[a-z_]+)`/g)].map(match => match[1]).sort(),
    ['brain_money_query', 'brain_money_overview', 'brain_money_guide', 'brain_think', 'brain_search', 'brain_fetch', 'brain_remember', 'brain_health', 'brain_financial_map'].sort());
  assert.match(skill, /For money call brain_money_overview first, read brain_money_guide, then go straight to brain_money_query/);
  const { MONEY_RULES_LINE } = await load('operations/answer-setup-copy.mjs');
  assert.ok(source('templates/owner-contract/money-rules-v3.md').includes(MONEY_RULES_LINE));
  const { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } = await load('scripts/run-test-chain.mjs');
  for (const commands of [TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS]) {
    assert.equal(commands.filter(command => command === 'node --test test/owner-money-rules.test.mjs').length, 1);
  }
});

test('R2 B2 M3 shipped and rendered owner rules use tool confidence and continue with a supplied date', () => {
  const texts = readdirSync(join(root, 'templates/owner-contract')).filter(name => name.startsWith('money-rules'))
    .map(name => source(`templates/owner-contract/${name}`));
  for (const platformName of ['darwin', 'win32', 'linux']) for (const assistant of ['claude', 'codex'])
    for (const answerSetup of ['built-in', 'opus-sonnet']) texts.push(workspace.renderOwnerRulesSection({ platformName, assistant, answerSetup }));
  texts.push(money.MONEY_GUIDE, money.MONEY_ANSWER_INSTRUCTIONS);
  for (const text of texts) {
    assert.doesNotMatch(text, /if (?:it is )?unknown, ask/);
    assert.match(text, /as_of\.local_date.*as_of\.utc_date.*say which date and zone were used, and continue/);
    assert.match(text, /confidence\.line/);
    assert.match(text, /never raise/i);
    assert.match(text, /Below 100%.*reasons.*missing/);
  }
});

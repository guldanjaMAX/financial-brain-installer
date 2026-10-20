import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';
export const now = Date.parse('2034-10-20');
export const plainAddress = '12 Synthetic Road, Fixture City, AZ 85001';
export function address(value, answer = entityFactAnswer) {
  const title = 'Address change', day = '2034-10-16';
  return answer({ question: 'What is my mailing address?', owner: 'Record Owner', now,
    results: [{ title, snippet: `[${title}] From: Record Owner <owner@example.invalid>\nTo: service@example.invalid\nDate: ${day}\nSubject: ${title}\n\nMy mailing address is ${value}.` }],
    docs: [{ n: 1, ref: 'fixture-mail', source_kind: 'gmail', date_source: 'email_header', date_reliable: true,
      ts: day, text_source: 'native', text_reliable: true, lineage: { status: 'known', kind: 'source_record' }, authority: {} }] });
}
export function card(field, value, answer = entityFactAnswer, operative = false) {
  return answer({ question: `What is Record Owner's ${field}?`, owner: 'Record Owner', now,
    results: [{ client: 'Record Owner', title: 'Contact record', snippet: operative
      ? `Subject: Record Owner\n## ${field}\nOperative value: ${value}` : `Name: Record Owner\n${field}: ${value}` }],
    docs: [{ n: 1, ref: 'fixture-card', client: 'Record Owner', title: 'Contact record', source_kind: 'curated',
      date_source: 'record:updated', date_reliable: true, ts: '2034-10-16', text_source: 'native', text_reliable: true,
      lineage: { status: 'known', kind: 'source_record' }, authority: operative
        ? { owner_confirmed: true, operative_section: { name: field, value } } : {} }] });
}
export async function mutatedModule(file, before, after) {
  const url = new URL(`../src/lib/${file}`, import.meta.url);
  let source = readFileSync(url, 'utf8');
  assert.equal(source.split(before).length, 2, 'exactly one guard is mutated');
  source = source.replace(before, after).replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
export async function answerWithBudget(limit) {
  const attributionURL = new URL('../src/lib/ledger-attribution.js', import.meta.url);
  let attribution = readFileSync(attributionURL, 'utf8');
  const before = 'answerSteps: caps.codepoints * caps.parses * caps.fields * caps.parses';
  assert.equal(attribution.split(before).length, 2);
  attribution = attribution.replace(before, `answerSteps: ${limit}`);
  const absolutize = (source, url) => source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  const encoded = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const attributionImport = encoded(absolutize(attribution, attributionURL));
  const answerURL = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const answer = readFileSync(answerURL, 'utf8').replace('"./ledger-attribution.js"', JSON.stringify(attributionImport));
  return (await import(encoded(absolutize(answer, answerURL)))).withLedgerAnswer;
}

import './fixtures/net-refund/guards.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as React from '../frontend/node_modules/react/index.js';
import { renderToStaticMarkup } from '../frontend/node_modules/react-dom/server.node.js';
import { transformSync } from '../frontend/node_modules/rolldown/dist/utils-index.mjs';
import * as rendering from '../frontend/src/lib/answer-render.js';
import { sourceLabel } from '../frontend/src/lib/words.ts';

import { execute } from './fixtures/net-refund/execute.mjs';
import { phraseCases, grossPeer } from './fixtures/net-refund/review-cases.mjs';

const source = readFileSync(new URL('../frontend/src/components/Ask.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function citationDateLabel('), end = source.indexOf('export function ScopedAsk(');
assert.ok(start > 0 && end > start, 'actual owner component located');
const component = source.slice(start, end).replace(/\bexport /g, '');
const compiled = transformSync('Ask.tsx', component, { jsx: { runtime: 'classic' } });
assert.deepEqual(compiled.errors, []);
for (const c of phraseCases) test(`${c.id}: actual app answer article preserves the basis`, async () => {
  const net = await execute(c), gross = await execute(grossPeer(c));
  const o = { ...net, question: c.question, grossBody: gross.body, grossTrace: gross.trace };
  assert.ok(net.plan.intents.length && gross.plan.intents.length, 'both validated plans reached');
  assert.ok(o.trace.transactions > 0 && o.grossTrace.transactions > 0, 'probe and green control read real rows');
  let state = 0, textCalls = 0, selectedBody = o.grossBody;
  const empty = () => null;
  const context = { React, Date, ...rendering, sourceLabel,
    useState: () => [[o.question, '', selectedBody, false, null, 'All accounts'][state++], () => {}],
    useFinanceScope: () => ({ activeLabel: 'All accounts', scope: null }), readAskDraft: () => '',
    FinanceScopeBar: empty, Attention: empty, TruthNote: ({ children }) => React.createElement('div', null, children),
    answerText: body => { textCalls++; return rendering.answerText(body); } };
  const Ask = runInNewContext(compiled.code + '\nAsk;', context);
  const grossHtml = renderToStaticMarkup(React.createElement(Ask));
  assert.equal(textCalls, 1, 'gross control reaches the actual component renderer');
  assert.ok(grossHtml.includes('$120.00'));
  assert.equal((grossHtml.match(/Want[^?<]*\?/g) || []).length, 1);
  state = 0; textCalls = 0; selectedBody = o.body;
  const html = renderToStaticMarkup(React.createElement(Ask));
  assert.equal(textCalls, 1, 'actual component invokes the shipped app renderer');
  assert.ok(html.includes('<article'));
  assert.ok(html.includes('$120.00'));
  const qualified = /before subtracting refunds|Refunds have not been subtracted|net.*unavailable/i.test(html);
  const offer = html.match(/Want[^?<]*\?/g) || [];
  assert.equal(offer.length, 1, 'article includes one offer');
  const paragraph = html.match(/<p class="whitespace-pre-wrap leading-relaxed">([\s\S]*?)<\/p>/)?.[1];
  assert.ok(paragraph?.includes('$120.00') && !paragraph.includes(offer[0]), 'answer paragraph holds the facts, not the offer');
  assert.ok(html.includes('Sources') && html.includes(o.body.citations[0].title.replaceAll('&', '&amp;')),
    'actual citation components render after the answer');
  // The app renders facts, then sources, then the one offer last.
  assert.ok(html.lastIndexOf(offer[0]) > html.indexOf('Sources'), 'the one offer comes after the sources');
  assert.equal(qualified, true, 'app cannot present gross as requested net');
});

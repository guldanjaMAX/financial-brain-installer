import { vi, it, expect, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ANSWER_ERROR_MESSAGES } from '../lib/answer-render.js';
import { REFUSAL_NEXT_ACTIONS } from '../lib/retrieval-status.js';
const state = vi.hoisted(() => ({ body: null as any, index: 0, position: 2 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState(initial: any) {
    const index = state.index++;
    return [index === state.position ? state.body : typeof initial === 'function' ? initial() : initial, () => {}];
  } };
});
vi.mock('./FinanceScope', () => ({
  useFinanceScope: () => ({ activeLabel: 'Fixture scope', scope: null }),
  FinanceScopeBar: () => null,
}));
import { Ask, ScopedAsk } from './Ask';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
const offer = 'Want to check the original record?';
const supported = { answer: 'The notebook cover is blue [1].', results: [{}], gaps: [],
  citations: [{ n: 1, title: 'Fixture source', source: 'records' }] };
function article(body: any, scoped: boolean) {
  state.body = body; state.index = 0; state.position = scoped ? 1 : 2;
  const html = renderToStaticMarkup(scoped
    ? <ScopedAsk principal={{} as any} onAccessEnded={() => {}} />
    : <Ask owner />);
  const found = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/);
  expect(found, 'real answer article rendered').not.toBeNull();
  return found![1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
}
for (const scoped of [false, true]) {
  it(`${scoped ? 'shared' : 'owner'} answer keeps its one invitation after all source facts`, () => {
    const control = article({ ...supported, citations: [] }, scoped);
    expect(control.endsWith(offer), 'source-free control ends with its selected offer').toBe(true);
    const text = article(supported, scoped);
    expect(text).toContain('Fixture source');
    expect(text.match(/Want to check the original record\?/g)).toHaveLength(1);
    expect(text.endsWith(offer), 'source-bearing answer must end with its selected offer').toBe(true);
  });

  it(`${scoped ? 'shared' : 'owner'} keeps scan, reason, trust and unparsed citation facts before the offer`, () => {
    const source = {
      n: 1, title: 'Fixture source. Want to inspect this title?', source: 'records',
      scanned: true, text_source: 'ocr_partial', ts: '2026-10-10', date_reliable: true,
    };
    const body = {
      ...supported, citations: [source], gaps: [{ type: 'scanned_evidence' }],
      evidence_gate: { supported: true, complete: true, reason: 'fixture evidence decision' },
      confidence: { percent: 80, band: 'high', basis: ['checked fixture records'] },
    };
    const facts = [
      supported.answer,
      'Part of this answer comes from a scanned document read by OCR. Check the original for exact figures.',
      'Why this answer was shown: fixture evidence decision.',
      'checked fixture records',
      source.title + ' (scanned)',
      'OCR text may be incomplete',
    ];
    for (const citations of [[], [source]]) {
      const text = article({ ...body, citations }, scoped);
      let previous = -1;
      for (const fact of facts.slice(0, citations.length ? facts.length : 4)) {
        const index = text.indexOf(fact);
        expect(index, `real metadata child rendered in order: ${fact}`).toBeGreaterThan(previous);
        previous = index;
      }
      expect(text.match(/Want to check the original record\?/g)).toHaveLength(1);
      expect(text.endsWith(offer)).toBe(true);
    }
  });

  for (const kind of ['selected', 'reviewed', 'error'] as const) {
    it(`${scoped ? 'shared' : 'owner'} ends with one ${kind} action with and without sources`, () => {
      const expected = kind === 'reviewed' ? REFUSAL_NEXT_ACTIONS.coverage_incomplete
        : 'Want to try again in a moment?';
      const body = kind === 'reviewed'
        ? { ...supported, answer: null, status: 'coverage_incomplete', next_action: expected }
        : kind === 'error'
          ? { ...supported, answer: null, answer_error: ANSWER_ERROR_MESSAGES.unavailable }
          : { ...supported, answer: `${supported.answer} ${expected}` };
      for (const citations of [[], supported.citations]) {
        const text = article({ ...body, citations }, scoped);
        expect(text).toContain(kind === 'selected' ? supported.answer
          : kind === 'error' ? 'answers are unavailable right now.' : 'provisional');
        if (citations.length) expect(text).toContain('Fixture source');
        expect(text.split(expected)).toHaveLength(2);
        expect(text.endsWith(expected)).toBe(true);
        expect(text).not.toContain(offer);
      }
    });
  }
}

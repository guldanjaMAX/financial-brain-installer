import assert from 'node:assert/strict';
import { formatMinor } from '../../../eval/fast-loop/money-oracle.mjs';

function expenseDisclosureProjection(body) {
  const replacements = [], lines = body.answer.split('\n');
  for (const part of body.ledger?.parts || (body.ledger ? [body.ledger] : [])) {
    if (part.kind !== 'expense_summary') continue;
    for (const group of part.category_groups || []) {
      const line = lines.find(line => line.startsWith(`${group.category}:`) &&
        JSON.stringify([...line.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]))) === JSON.stringify(group.citations));
      assert.ok(line, 'each category retains its own inline citation membership');
      const refs = group.citations.map(n => body.citations.find(ref => ref.n === n));
      assert.equal(refs.length, group.count);
      assert.ok(refs.every(ref => ref && part.accounts.some(account => account.account_mask === ref.account_mask) &&
        ref.posted_on >= part.from && ref.posted_on <= part.to));
      assert.equal(refs.reduce((sum, ref) => sum + ref.amount_minor, 0), group.total_minor);
      replacements.push([line, line.replace(/(?: \[\d+\])+\.$/, '.')]);
    }
  }
  for (const line of lines.filter(line => line.startsWith('Accounts covered:'))) {
    assert.equal(line, 'Accounts covered: your account ending 1234.', 'synthetic account disclosure stays exact');
    assert.ok((body.ledger?.parts || [body.ledger]).some(part => part.accounts?.some(account => account.account_mask === '1234')));
    replacements.push(['\n' + line, '']);
  }
  return replacements;
}

// Keep pinned historical bytes immutable. Independently validate the added
// disclosure before comparing every pre-existing response fact and citation.
export function historicalCategoryBody(body, rows) {
  const copy = structuredClone(body);
  for (const [before, after] of expenseDisclosureProjection(body)) copy.answer = copy.answer.replace(before, after);
  for (const part of copy.ledger?.parts || (copy.ledger ? [copy.ledger] : [])) {
    if (part.kind !== 'expense_summary' || part.unconfirmed_category_count == null) continue;
    const excluded = rows.filter(row => row.direction === 'outflow' && !row.category && row.date >= part.from && row.date <= part.to);
    const cents = excluded.reduce((n, row) => n + row.cents, 0);
    assert.ok(excluded.length > 0);
    assert.equal(part.unconfirmed_category_count, excluded.length);
    assert.equal(part.unsorted_minor, cents);
    const notice = `Unconfirmed categories: ${excluded.length} rows totaling ${formatMinor(String(cents))}; left out of confirmed category totals.`;
    assert.ok(copy.answer.includes('\n' + notice), 'the independently counted rows remain visible');
    copy.answer = copy.answer.replace('\n' + notice, '');
    delete part.unconfirmed_category_count;
    delete part.unsorted_minor;
  }
  return copy;
}

export function historicalCategoryText(text, body, rows) {
  historicalCategoryBody(body, rows);
  for (const [before, after] of expenseDisclosureProjection(body)) {
    assert.ok(text.includes(before), 'every actual surface retains the added disclosure');
    text = text.replace(before, after);
  }
  for (const notice of body.answer.split('\n').filter(line => line.startsWith('Unconfirmed categories:'))) {
    assert.ok(text.includes('\n' + notice), 'every actual surface retains the excluded-row disclosure');
    text = text.replace('\n' + notice, '');
  }
  return text;
}

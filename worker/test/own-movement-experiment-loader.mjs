import { registerHooks } from 'node:module';
// Experimental transform only: Node receives modified source bytes in memory.
// No deployed module, account record, or stored transaction is rewritten.
const marker = 'async function ledgerActivityAnswer({';
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (!url.endsWith('/worker/src/lib/ledger-answer.js')) return loaded;
  let source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
  if (!source.includes(marker)) throw new Error('experiment anchor drift');
  source = source.replace(marker, `async function ledgerActivityAnswer(args) {
    const possible = args.rows.filter(row => {
      if (row.direction !== 'outflow') return false;
      const text = String(row.description || '').toLowerCase();
      const structured = /^(?:(?:online|mobile|automatic) )?(?:brokerage contribution|transfer|payment|to |ach debit|wire|zelle|owner draw|owner contribution|credit card payment|loan payment)/.test(text);
      const kind = /\\b(?:savings|brokerage|investment|retirement|ira|401k|escrow|self|personal|business|credit card|loan)\\b/.test(text);
      const mask = text.match(/(?:xxxx|ending |account |acct )(\\d{4})\\b/);
      if (!structured || !(kind || mask)) return false;
      // A connected endpoint stays in the existing reciprocal-evidence reader.
      const connected = [...args.bySlug.values()].some(a => a.account_slug !== row.effective_account_slug &&
        (mask && a.mask === mask[1] || a.label && text.includes(a.label.toLowerCase())));
      return !connected;
    });
    if (!possible.length) return finderOriginalActivity(args);
    if (possible.some(r => /\\b(?:fee|interest|principal|component)\\b|\\$\\d.*\\$\\d/.test(r.description.toLowerCase()))) {
      return { answer: 'Possible own movement with components: scope figure withheld.', citations: [],
        ledger: { kind: args.intent.kind, complete: false, total_minor: null, finder_withheld: true } };
    }
    const ids = new Set(possible.map(r => r.id));
    const result = await finderOriginalActivity({ ...args, rows: args.rows.filter(r => !ids.has(r.id)),
      allRows: args.allRows.filter(r => !ids.has(r.id)) });
    if (result.ledger) {
      result.ledger.possible_own_exclusion = { count: possible.length, total_minor: possible.reduce((n,r)=>n+r.amount_minor,0) };
      result.answer += '\\nPossible own transfer, not counted: ' + possible.length + ' rows.';
    }
    return result;
  }
  async function finderOriginalActivity({`);
  if (process.env.OWN_MOVEMENT_RULE_MUTANT === 'drop-component-withholding') {
    source = source.replace('if (possible.some(', 'if (false && possible.some(');
  }
  return { ...loaded, source };
} });

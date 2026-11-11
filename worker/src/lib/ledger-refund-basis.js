// Closed amount adjustments exclude narrative such as receiving store credit
// or shopping after a return. Do not infer subtraction from distant nouns.
const adjustment = /\b(?:net of|after|minus|less)\s+(?:(?:the|any|all|their|its)\s+|['’]s\s+)?(?:refunds?|returns?|credits?)\b|\bwith (?:the |any |all |their |its )?refunds? taken off\b|\brefunds? are netted out\b|\bnet\s+spend(?:ing)?\b/i;
const grossWords = /\bgross\b|\bbefore refunds\b/i;

// Calendar admission reuses the financial basis grammar instead of treating
// its before/after words as unconsumed date operators.
export function refundBasisSpans(text) {
  return [...text.matchAll(new RegExp(`${adjustment.source}|${grossWords.source}`, 'gi'))]
    .map(match => [match.index, match.index + match[0].length]);
}

const descriptionAdjustment = /\b(?:after refunds|net of refunds|refunds are netted out)\b/i;

// Selector words identify records, not a requested amount basis. Mask every
// grounded occurrence before looking for an adjustment, including shared ones.
function basisWords(text, selectors) {
  let result = text;
  for (const literal of [...new Set(selectors.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'), (match, offset) => {
      // A model may annotate the word in "after refunds" as a selector. Only
      // explicit payee uses of that literal are records rather than a basis.
      if (/^refunds?$/i.test(literal) && !/\b(?:at|from|to|for)\s+["']?$/i.test(result.slice(0, offset))) return match;
      return ' ';
    });
  }
  return result.replace(/\binvestment returns?\b/gi, ' ');
}

export function refundBasisForOperand({ question, clause, intents, comparison, operand }) {
  const selectors = intents.flatMap(value => [
    value.vendor_text, value.account_hint,
  ]);
  const local = basisWords(clause, selectors), shared = basisWords(question, selectors);
  const localAdjustment = adjustment.test(local);
  // A shared comparison qualifier governs both periods. A locally requested
  // gross operand stays independently answerable.
  const explicitGross = grossWords.test(local);
  const expense = !operand || ['merchant', 'category', 'totals', 'expense_summary'].includes(operand.kind) && operand.direction !== 'inflow';
  const requested = expense && !explicitGross && (localAdjustment || Boolean(comparison) && adjustment.test(shared));
  const refundPayee = operand?.vendor && /^refunds?$/i.test(operand.vendor) &&
    /\b(?:at|from|to|for)\s+["']?refunds?\b/i.test(question);
  return {
    requested,
    // Monthly output selects gross fields. Only the single-period, overall
    // reader can expose the expressly labeled description-word subtraction.
    descriptionOnly: descriptionAdjustment.test(shared) && (!operand || requested &&
      operand.count === 1 && !operand.monthlyBreakdown &&
      (operand.vendor === null || /^refunds?$/i.test(operand.vendor) && !refundPayee)),
  };
}

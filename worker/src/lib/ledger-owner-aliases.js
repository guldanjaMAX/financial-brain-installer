// Only fixed syntax words tolerate one insertion, deletion, substitution or
// adjacent transposition. Identity literals and numeric values stay exact.
function oneEdit(actual, expected) {
  if (actual === expected) return true;
  if (/\d/.test(actual + expected) || Math.abs(actual.length - expected.length) > 1) return false;
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    if (actual[i] === expected[i]) continue;
    if (actual.length === expected.length) {
      return actual.slice(i + 1) === expected.slice(i + 1) ||
        actual[i] === expected[i + 1] && actual[i + 1] === expected[i] &&
        actual.slice(i + 2) === expected.slice(i + 2);
    }
    return actual.length > expected.length
      ? actual.slice(i + 1) === expected.slice(i) : actual.slice(i) === expected.slice(i + 1);
  }
  return true;
}

const templates = new Map();
function syntax(text, template) {
  if (!templates.has(template)) {
    const slots = template.split(' ');
    const pattern = slots.map(word => word === '{name}'
      ? "([\\p{L}\\p{N}][\\p{L}\\p{N} &/.,*'-]{0,79}?)" : '([\\p{L}\\p{N}]+)').join('\\s+');
    templates.set(template, { slots, pattern: new RegExp('^' + pattern + '$', 'u') });
  }
  const { slots, pattern } = templates.get(template);
  const match = text.match(pattern);
  if (!match) return null;
  let name;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] === '{name}') name = match[i + 1];
    else if (!oneEdit(match[i + 1], slots[i])) return null;
  }
  return { name };
}

// Whole-question templates cannot discard residual restrictions. A captured
// name is passed unchanged to the existing identity and ambiguity guards.
export function ownerQuestionAlias(question) {
  const text = question.toLowerCase().trim().replace(/[?!.]+$/, '').replace(/,\s+and on what$/, ' and on what')
    .replace(/^what's\b/, 'what is').replace(/^whats\b/, 'what is');
  for (const form of [
    'how much money is in the bank', 'how much money is in my bank',
    'how much money do i have in the bank', 'what is my total bank balance',
    'what is in my accounts', 'how much do i have',
  ]) if (syntax(text, form)) return { rewrite: 'what are my account balances' };

  const literalBalanceAlias = (result, name) => ({
    ...result, literalAccount: name,
    // A trailing grammar noun can also belong to a recorded nickname.
    literalAccountFrame: (syntax(text, 'what is in my {name}') ||
      syntax(text, 'how much is in {name}') ||
      syntax(text, 'what is the balance in {name}'))?.name || null,
  });
  // Every ownership alias preserves the same literal slot. In particular,
  // one-edit syntax can consume singular account through the plural form.
  const roleBalanceAlias = (role, kind, single) => literalBalanceAlias({
    accountRole: role, accountKind: kind, singleAccountBalance: single,
  }, (syntax(text, 'what is in my {name} account') ||
      syntax(text, 'what is in my {name} accounts')).name);
  for (const role of ['business', 'personal']) {
    if (syntax(text, `what is in my ${role} accounts`)) return roleBalanceAlias(role, null, false);
  }
  for (const role of ['business', 'personal']) for (const kind of ['checking', 'savings', 'card', 'loan']) {
    if (syntax(text, `what is in my ${role} ${kind} account`)) return roleBalanceAlias(`${role} ${kind}`, kind, true);
  }
  for (const form of [
    // Consume the grammar possessive before capturing an ending. The full
    // frame above still competes when "My" belongs to a recorded nickname.
    'what is the balance in my {name}', 'what is the balance in {name}',
    'how much is in {name} balance', 'what is in my {name} account',
  ]) {
    const match = syntax(text, form);
    if (match) return literalBalanceAlias({ rewrite: `what is my ${match.name} balance` }, match.name);
  }
  for (const period of ['this month', 'last month']) {
    for (const form of ['how much came in', 'how much money came in', 'what came into my accounts']) {
      if (syntax(text, `${form} ${period}`)) return { rewrite: `how much money came in ${period}` };
    }
    for (const form of [`what did i spend ${period} and on what`, `show my spending ${period} by category`]) {
      if (syntax(text, form)) return { rewrite: `what did i spend ${period} and on what` };
    }
    for (const form of ['what were my biggest expenses', 'show my largest purchases']) {
      if (syntax(text, `${form} ${period}`)) return { rewrite: `what were my biggest expenses ${period}` };
    }
    for (const form of ['who paid me', 'show who sent me money']) {
      if (syntax(text, `${form} ${period}`)) return { rewrite: `show income by merchant ${period}` };
    }
  }
  for (const number of ['3', 'three']) for (const form of [
    `how much did i spend at {name} in the last ${number} months`,
    `what is my {name} spending for the last ${number} months`,
  ]) {
    const match = syntax(text, form);
    if (match) return { rewrite: `how much did i spend at ${match.name} in the last 3 months` };
  }
  for (const form of ['how much do i pay {name} each month', 'what is my monthly {name} charge']) {
    const match = syntax(text, form);
    if (match) return { recurring: match.name };
  }
  for (const form of ['did {name} pay the invoice', 'has {name} invoice been paid', 'did {name} pay']) {
    const match = syntax(text, form);
    if (match) return { payer: match.name, invoice: form.includes('invoice') };
  }
  return null;
}

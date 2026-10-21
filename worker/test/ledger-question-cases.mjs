import { originatorWords } from './ledger-attribution-cases.mjs';

// Independent question templates and row-generator vocabulary. The generator
// varies the requested text, never the transaction parser's result.
// Partner answer 13 lists the closed channels; partner ruling 4 (round 7):
// ""Via <name>" that isn't a listed channel refuses." The 45 via templates
// therefore name the payer in a FROM clause after a listed channel ("via
// <channel> from <name>", the channel stripped; ruling 6 for "via wire from"),
// cycling through every listed channel. The old "via <name>" form refuses.
export const listedChannels = ['ACH', 'Zelle', 'wire', 'check', 'Venmo', 'PayPal'];
export const arrivalVerbs = ['arrive', 'arrived', 'receive', 'received', 'come', 'came', 'land', 'landed', 'hit', 'reach', 'reached', 'clear', 'cleared', 'post', 'posted'];
export const selectorTemplates = [
  ...['did', 'has', 'have'].flatMap((aux, auxIndex) => arrivalVerbs.flatMap((verb, verbIndex) => {
    const channel = listedChannels[(auxIndex * arrivalVerbs.length + verbIndex) % listedChannels.length];
    return [
      name => `${aux} the payment from ${name} ${verb} in October 2026?`,
      name => `${aux} the payment via ${channel} from ${name} ${verb} in October 2026?`,
      name => `${aux} the ${name} payment ${verb} in October 2026?`,
    ];
  })),
  name => `Did the payment of $25.00 from ${name} arrive in October 2026?`,
  name => `Has my payment arrived from ${name} in October 2026?`,
  name => `Did a deposit of USD 25.00 from ${name} post in October 2026?`,
  name => `Was the payment of 25 dollars from ${name} received in October 2026?`,
  name => `Is the payment from ${name} received in October 2026?`,
  name => `Did the payment from ${name} reach account 1234 in October 2026, and when?`,
  name => `Did the payment from ${name} arrive into my checking account ending 1234 in October 2026?`,
  ...['how much income', 'how much income came', 'how much did i receive', 'how much did we receive', 'show income', 'show me income', 'what is my income', 'what is the income'].map(prefix => name => `${prefix} from ${name} in October 2026?`),
];

// The 45 pre-ruling-4 forms, "<aux> the payment via <name> <verb>": each one
// now refuses at classification for a name that is not a listed channel.
export const unlistedViaTemplates = ['did', 'has', 'have'].flatMap(aux => arrivalVerbs.map(verb =>
  name => `${aux} the payment via ${name} ${verb} in October 2026?`));

export function* requestedSelectorCases() {
  for (const word of new Set(['Bank', 'Payment', 'from', 'by', 'for', 'in', 'of', ...originatorWords])) {
    for (const whole of [`Payer One ${word}`, `Payer One, ${word}`, `${word} Payer One`]) {
      for (const template of selectorTemplates) for (const registration of ['shorter', 'both', 'longer'])
        yield { whole, question: template(whole), registration };
    }
  }
}

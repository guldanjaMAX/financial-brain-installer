// A deliberately versioned currency catalog. Unsupported codes fail closed;
// adding a currency requires its ISO minor-unit exponent and fixture review.
export const FINANCIAL_CURRENCY_EXPONENTS = Object.freeze({
  USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, NZD: 2, CHF: 2, CNY: 2,
  HKD: 2, SGD: 2, INR: 2, MXN: 2, BRL: 2, ZAR: 2, SEK: 2, NOK: 2,
  DKK: 2, PLN: 2, AED: 2, SAR: 2, ILS: 2, JPY: 0, KRW: 0,
  CLP: 0, VND: 0, KWD: 3, BHD: 3, JOD: 3, OMR: 3, TND: 3,
});
export function financialError(code) { return Object.assign(new Error(code), { code }); }
export function moneyFromDecimal(decimal, currency) {
  if (typeof decimal !== 'string' || decimal.length > 160 || !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(decimal)) throw financialError('money_decimal');
  const exponent = FINANCIAL_CURRENCY_EXPONENTS[currency];
  if (!Object.hasOwn(FINANCIAL_CURRENCY_EXPONENTS, currency)) throw financialError('money_currency');
  const [whole, fraction = ''] = decimal.replace(/^-/, '').split('.');
  if (/[1-9]/.test(fraction.slice(exponent))) return { decimal, currency, exponent, amount_minor: null, precision: 'unrepresentable' };
  const amount = BigInt(whole + fraction.slice(0, exponent).padEnd(exponent, '0')) * (decimal.startsWith('-') ? -1n : 1n);
  if (amount.toString().replace('-', '').length > 78) throw financialError('money_overflow');
  return { decimal, currency, exponent, amount_minor: String(amount), precision: 'exact' };
}
export function assertMoney(value, { exact = false } = {}) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'amount_minor,currency,decimal,exponent,precision') throw financialError('money_shape');
  const parsed = moneyFromDecimal(value.decimal, value.currency);
  if (parsed.exponent !== value.exponent || parsed.amount_minor !== value.amount_minor) throw financialError('money_value');
  if (!['exact', 'provider_rounded', 'derived_rounded', 'unrepresentable'].includes(value.precision) ||
      (parsed.precision === 'unrepresentable') !== (value.precision === 'unrepresentable')) throw financialError('money_precision');
  if (exact && value.precision !== 'exact') throw financialError('money_precision');
  return value;
}
export function moneyFromMinor(amount, currency) {
  if (typeof amount !== 'bigint' && (typeof amount !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(amount))) throw financialError('money_value');
  const exponent = FINANCIAL_CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) throw financialError('money_currency');
  const n = BigInt(amount), digits = (n < 0n ? -n : n).toString().padStart(exponent + 1, '0');
  return moneyFromDecimal(`${n < 0n ? '-' : ''}${exponent ? `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}` : digits}`, currency);
}
export function sumMoney(values) {
  if (!Array.isArray(values) || !values.length) throw financialError('empty_sum');
  values.forEach(value => assertMoney(value, { exact: true }));
  if (values.some(value => value.currency !== values[0].currency)) throw financialError('mixed_currency');
  return moneyFromMinor(values.reduce((sum, value) => sum + BigInt(value.amount_minor), 0n), values[0].currency);
}
export function moneyToSafeInteger(value) {
  assertMoney(value, { exact: true });
  const amount = BigInt(value.amount_minor);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER)) throw financialError('money_overflow');
  return Number(amount);
}

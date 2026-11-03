// Integer-only independent arithmetic. Imports no product module or input bank.
export const ORACLE_VERSION = 'money-oracle-v1';
export const minor = value => {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw Error('INVALID_MINOR');
  return BigInt(value);
};
export const total = values => values.reduce((sum, value) => sum + minor(value), 0n).toString();
export function formatMinor(value) {
  const n = minor(value), abs = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}$${(abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(abs % 100n).toString().padStart(2, '0')}`;
}
export function displayFigures(text) {
  return [...String(text || '').matchAll(/(-?)\$([\d,]+)\.(\d{2})/g)].map(m => ({
    text: m[0], index: m.index, cents: ((m[1] ? -1n : 1n) * (BigInt(m[2].replaceAll(',', '')) * 100n + BigInt(m[3]))).toString(),
  }));
}
export function sumRows(rows, ids) {
  if (new Set(ids).size !== ids.length) throw Error('DUPLICATE_GOLD_ROW');
  return total(ids.map(id => { if (!rows[id]) throw Error('MISSING_GOLD_ROW'); return rows[id].cents; }));
}
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

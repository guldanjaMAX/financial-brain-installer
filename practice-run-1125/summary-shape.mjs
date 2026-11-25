function invalid() { const error = new Error('The fixed schema check failed.'); error.code = 'SUMMARY_INVALID'; throw error; }
// Reject accessors, inherited data and serializer hooks before reading any value.
export function data(value) {
  if (value === null || ['string','boolean','number'].includes(typeof value)) return;
  if (typeof value !== 'object') invalid();
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (proto !== (array ? Array.prototype : Object.prototype) && !(proto === null && !array)) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) invalid();
  for (const [key, desc] of Object.entries(descriptors)) {
    if (array && key === 'length') continue;
    if (!desc.enumerable || !Object.hasOwn(desc,'value') || (array && !/^(?:0|[1-9]\d*)$/.test(key))) invalid();
    data(desc.value);
  }
  if (array) for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value,index)) invalid();
}
export function check(value, rule) {
  if (rule.anyOf) { if (!rule.anyOf.some(arm => { try { check(value, arm); return true; } catch { return false; } })) invalid(); return; }
  if (Object.hasOwn(rule,'const') && value !== rule.const) invalid();
  if (rule.enum && !rule.enum.includes(value)) invalid();
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    if (Object.keys(value).some(key => !Object.hasOwn(rule.properties,key))) invalid();
    for (const [key, child] of Object.entries(rule.properties)) check(value[key], child);
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < rule.minItems || value.length > rule.maxItems) invalid();
    for (const item of value) check(item,rule.items);
  }
  if (rule.type === 'string') {
    if (typeof value !== 'string' || value.length > rule.maxLength || !new RegExp(rule.pattern).test(value)) invalid();
  }
  if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum)) invalid();
  if (rule.type === 'null' && value !== null) invalid();
}

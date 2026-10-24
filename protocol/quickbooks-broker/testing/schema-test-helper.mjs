// Test-only draft-2020-12 subset. Unknown keywords fail instead of silently
// weakening a contract. This is not a runtime validator or a cryptographic verifier.
const allowed = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'description',
  'type', 'const', 'enum', 'properties', 'required', 'additionalProperties',
  'oneOf', 'anyOf', 'allOf', 'minLength', 'maxLength', 'pattern', 'minimum',
  'maximum', 'minItems', 'maxItems', 'items', 'uniqueItems']);

function resolve(root, ref) {
  if (!/^#\/\$defs\/[a-zA-Z][a-zA-Z0-9]*$/.test(ref)) throw new Error('schema_ref_unsupported');
  const value = root.$defs[ref.slice(8)];
  if (!value) throw new Error('schema_ref_missing');
  return value;
}

export function inspectSchema(root) {
  function visit(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('schema_shape_unsupported');
    for (const key of Object.keys(schema)) if (!allowed.has(key)) throw new Error('schema_keyword_unsupported');
    if (schema.$ref) resolve(root, schema.$ref);
    if (schema.type === 'object') {
      if (schema.additionalProperties !== false) throw new Error('schema_object_not_closed');
      if (!schema.properties || !Array.isArray(schema.required)) throw new Error('schema_object_incomplete');
      if (schema.required.some(key => !(key in schema.properties))) throw new Error('schema_required_missing');
    }
    for (const child of Object.values(schema.$defs ?? {})) visit(child);
    for (const child of Object.values(schema.properties ?? {})) visit(child);
    for (const key of ['oneOf', 'anyOf', 'allOf']) for (const child of schema[key] ?? []) visit(child);
    if (schema.items) visit(schema.items);
    if (schema.pattern) new RegExp(schema.pattern, 'u');
  }
  visit(root);
  return true;
}

export function validates(root, name, value) {
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  function walk(schema, data) {
    if (schema.$ref && !walk(resolve(root, schema.$ref), data)) return false;
    if ('const' in schema && !equal(schema.const, data)) return false;
    if (schema.enum && !schema.enum.some(item => equal(item, data))) return false;
    if (schema.oneOf && schema.oneOf.filter(item => walk(item, data)).length !== 1) return false;
    if (schema.anyOf && !schema.anyOf.some(item => walk(item, data))) return false;
    if (schema.allOf && !schema.allOf.every(item => walk(item, data))) return false;
    if (schema.type) {
      const matches = schema.type === 'object' ? data !== null && typeof data === 'object' && !Array.isArray(data)
        : schema.type === 'array' ? Array.isArray(data)
          : schema.type === 'integer' ? Number.isSafeInteger(data)
            : schema.type === 'null' ? data === null : typeof data === schema.type;
      if (!matches) return false;
    }
    if (typeof data === 'string') {
      const length = [...data].length;
      if (schema.minLength !== undefined && length < schema.minLength) return false;
      if (schema.maxLength !== undefined && length > schema.maxLength) return false;
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(data)) return false;
    }
    if (typeof data === 'number') {
      if (!Number.isFinite(data)) return false;
      if (schema.minimum !== undefined && data < schema.minimum) return false;
      if (schema.maximum !== undefined && data > schema.maximum) return false;
    }
    if (schema.type === 'object') {
      if ((schema.required ?? []).some(key => !Object.hasOwn(data, key))) return false;
      for (const [key, child] of Object.entries(data)) {
        if (Object.hasOwn(schema.properties ?? {}, key)) {
          if (!walk(schema.properties[key], child)) return false;
        } else if (schema.additionalProperties === false) return false;
      }
    }
    if (Array.isArray(data)) {
      if (schema.minItems !== undefined && data.length < schema.minItems) return false;
      if (schema.maxItems !== undefined && data.length > schema.maxItems) return false;
      if (schema.items && !data.every(item => walk(schema.items, item))) return false;
      if (schema.uniqueItems && new Set(data.map(item => JSON.stringify(item))).size !== data.length) return false;
    }
    return true;
  }
  if (!Object.hasOwn(root.$defs, name)) throw new Error('schema_name_unknown');
  return walk(root.$defs[name], value);
}

// Synthetic examples are constructed in memory. They are shape controls only;
// signatures, encrypted bytes, and public points here make no authenticity claim.
export function fixture(root, name, opaque) {
  function build(schema) {
    if (schema.$ref) return build(resolve(root, schema.$ref));
    if ('const' in schema) return schema.const;
    if (schema.enum) return schema.enum[0];
    if (schema.oneOf) return build(schema.oneOf[0]);
    if (schema.anyOf) return build(schema.anyOf[0]);
    if (schema.type === 'object') return Object.fromEntries(schema.required.map(key => [key, build(schema.properties[key])]));
    if (schema.type === 'integer') return schema.minimum ?? 1;
    if (schema.type === 'boolean') return false;
    if (schema.type === 'null') return null;
    if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => build(schema.items));
    if (schema.type === 'string') {
      if (schema.pattern?.startsWith('^https:')) return 'https://owner.invalid/api/quickbooks/connect/callback';
      if (schema.pattern === '^[a-f0-9]{64}$') return opaque(64).split('').map(c => (c.charCodeAt(0) % 16).toString(16)).join('');
      if (schema.pattern === '^[a-z0-9][a-z0-9._-]{0,63}$') return 'synthetic-build';
      return opaque(schema.minLength ?? 1);
    }
    throw new Error('fixture_schema_unsupported');
  }
  return build(root.$defs[name]);
}

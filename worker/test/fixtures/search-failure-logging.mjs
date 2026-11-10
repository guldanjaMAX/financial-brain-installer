import assert from 'node:assert/strict';

// Exercise the exported hybrid-search settlement, including its real date
// conversion. Provider text is captured only in memory, never test output.
export async function keywordFailureProbe(search, { query = 'payment', filters = {}, failure = null } = {}) {
  const warnings = [];
  let calls = 0;
  const saved = console.warn;
  console.warn = line => warnings.push(line);
  const prepare = (sql, params = []) => ({
    bind: (...values) => prepare(sql, values),
    async all() {
      if (/chunks_fts MATCH/.test(sql)) {
        calls++;
        if (failure) throw failure(params, sql);
        return { results: [] };
      }
      return { results: [{ name: 'custom_api_current_jobs' }, { name: 'custom_api_document_versions' }] };
    },
  });
  try {
    const result = await search({ DB: { prepare }, VECTORIZE: { query: async () => ({ matches: [] }) } },
      { query, filters, embedding: [0.1], projectionReadiness: { ready: true }, now: 0 });
    assert.ok(calls > 0, 'real keyword SQL decision reached');
    assert.equal(warnings.length, failure ? 1 : 0, 'exact warning count at failed or healthy decision');
    assert.equal(result.degraded_reason, failure ? 'keyword-query-failed' : null);
    return warnings.map(line => JSON.parse(line));
  } finally { console.warn = saved; }
}

export async function privacyCounterexamples(search) {
  await keywordFailureProbe(search); // Positive healthy-search control.
  const content = ['synthetic', 'document', 'payload'].join('_');
  const query = 'private\\query';
  const encoded = JSON.stringify(query);
  let bound;
  const cases = [
    { label: 'document payload', forbidden: content, failure: () => new Error(content) },
    { label: 'bound date', forbidden: '1767225600000', filters: { from: '2026-01-01' }, failure: params => {
      bound = params[2];
      return new Error(`database bound value ${bound}`);
    } },
    { label: 'escaped query', forbidden: encoded, query, failure: () => new Error(encoded) },
  ];
  const leaks = [];
  for (const c of cases) {
    const entries = await keywordFailureProbe(search, c);
    if (JSON.stringify(entries).includes(JSON.stringify(c.forbidden).slice(1, -1))) leaks.push(c.label);
  }
  assert.equal(bound, 1767225600000, 'actual normalized SQL binding reached');
  assert.deepEqual(leaks, [], 'all three private payloads absent from warnings');
  return cases.length;
}

export async function numericContentCarrier(search, carrier) {
  await keywordFailureProbe(search); // Healthy control reaches the same SQL path.
  const fragment = [314, 159, 265].join('');
  const marker = `[code: ${fragment}]`;
  for (const signature of ['none', 'provider overload', 'exact overload']) {
    let reached = false;
    const [entry] = await keywordFailureProbe(search, {
      query: carrier === 'query' ? marker : 'payment',
      filters: { source: marker },
      failure: (params, sql) => {
        assert.ok(/chunks_fts MATCH/.test(sql), 'real keyword SQL failure decision reached');
        if (carrier === 'bound' || carrier === 'sql') {
          assert.equal(params[2], marker, 'actual source binding carries the synthetic marker');
        }
        if (carrier === 'query') {
          assert.ok(params[0].includes(fragment), 'actual FTS query carries the synthetic digits');
        }
        const payload = carrier === 'document' ? `document fragment ${marker}`
          : carrier === 'bound' ? `bound source ${params[2]}`
          : carrier === 'sql' ? `SELECT text FROM chunks WHERE source='${params[2]}'`
          : `query ${marker}`;
        reached = true;
        // The content marker precedes the real overload signature. Its digits
        // must neither become a code nor mask the provider failure category.
        const message = signature === 'none' ? `provider refusal; ${payload}; [code: 7429]`
          : signature === 'exact overload' ? `${payload}; D1 DB is overloaded [code: 7429]`
          : `D1_ERROR: overloaded; ${payload}; [code: 7429]`;
        return new Error(message);
      },
    });
    assert.ok(reached, 'content-bearing provider failure was thrown');
    assert.ok(!JSON.stringify(entry).includes(fragment), 'numeric content fragment never enters warnings');
    assert.notEqual(entry.error.code, Number(fragment), 'content digits are never serialized as a code');
    if (signature === 'none') {
      assert.equal(entry.error.category, 'unknown', 'markers alone are not provider signatures');
      assert.ok(!Object.hasOwn(entry.error, 'code'), 'unrecognized markers emit no code');
    } else {
      assert.equal(entry.error.category, 'd1_overloaded', 'real overload survives an unrelated marker');
      assert.equal(entry.error.code, 7429, 'overload signature maps to a reviewed constant');
    }
  }
}

export async function searchFailureLogging(search) {
  const privateQuery = 'privateaccountref privateledgerref';
  const privateFilter = 'privatefilterref';
  const warnings = [];
  const counts = { keyword: 0, vector: 0, readiness: 0 };
  const saved = console.warn;
  console.warn = (...args) => warnings.push(args);
  const error = stage => new TypeError(`${stage} refused: ${privateQuery}; ${privateFilter}; ${'x'.repeat(400)}`);
  const env = {
    DB: { prepare(sql) {
      const statement = {
        bind: () => statement,
        async all() {
          if (/chunks_fts MATCH/.test(sql)) { counts.keyword++; throw error('D1'); }
          return { results: [{ name: 'custom_api_current_jobs' }, { name: 'custom_api_document_versions' }] };
        },
      };
      return statement;
    } },
    VECTORIZE: {
      async query() { counts.vector++; throw error('Vectorize'); },
      async describe() { counts.readiness++; throw error('describe'); },
    },
  };
  try {
    const result = await search(env, { query: privateQuery, embedding: [0.1], filters: { source: privateFilter },
      supplementalFilters: [{ source: privateFilter }], now: 0 });
    assert.equal(result.degraded_reason, 'keyword-and-vector-query-failed');
    assert.ok(counts.keyword >= 2 && counts.vector >= 4 && counts.readiness === 1,
      'base and supplemental failed decisions reached; retries must not duplicate warnings');
    assert.equal(warnings.length, 3, 'one structured warning per failed stage');
    const entries = warnings.map(args => {
      assert.equal(args.length, 1, 'one bounded JSON log line');
      return JSON.parse(args[0]);
    });
    assert.deepEqual(entries.map(entry => entry.stage).sort(), ['keyword', 'projection_readiness', 'vector']);
    for (const entry of entries) {
      assert.equal(entry.event, 'search_stage_failed');
      assert.ok(['unknown', 'vectorize_error'].includes(entry.error.category));
      assert.ok(!Object.hasOwn(entry.error, 'name'), 'provider-controlled name never enters logs');
      assert.ok(entry.error.message.length > 0 && entry.error.message.length <= 300);
    }
    const line = JSON.stringify(warnings);
    for (const value of [privateQuery, ...privateQuery.split(' '), privateFilter]) {
      assert.ok(!line.includes(value), 'private query and bound filter values never enter logs');
    }
    assert.equal(entries.find(entry => entry.stage === 'projection_readiness').error.category, 'vectorize_error',
      'readiness provider failure survives the catch as a safe category');
    warnings.length = 0;
    env.DB = { prepare() { const s = { bind: () => s, all: async () => ({ results: [] }) }; return s; } };
    env.VECTORIZE.query = async () => ({ matches: [] });
    const control = await search(env, { query: privateQuery, embedding: [0.1], projectionReadiness: { ready: true }, now: 0 });
    assert.equal(control.degraded, null, 'successful control is healthy');
    assert.equal(warnings.length, 0, 'successful stages emit no warning');
  } finally { console.warn = saved; }
}

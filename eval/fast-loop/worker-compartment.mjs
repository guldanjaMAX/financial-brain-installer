import { SourceTextModule, createContext } from 'node:vm';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
import { webcrypto } from 'node:crypto';
import { sha256, clone } from './exact-tape.mjs';

export async function workerCompartment({ root, clock, fail, hooks, trace = true, sourceOverrides = {} }) {
  const instant = Date.parse(clock.now_utc);
  if (!Number.isFinite(instant)) throw Error('INVALID_CLOCK');
  class FrozenDate extends Date {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  }
  const base = realpathSync(resolve(root, 'worker/src'));
  const sourceFiles = {};
  const context = createContext({
    Date: FrozenDate, Response, Request, Headers, URL, URLSearchParams,
    TextEncoder, TextDecoder, AbortController, AbortSignal, crypto: {
      subtle: webcrypto.subtle,
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
      getRandomValues: values => fail('CAPABILITY_DENIED', 'randomness'),
    },
    atob, btoa, structuredClone, performance: { now: () => 0 },
    fetch: () => fail('CAPABILITY_DENIED', 'network'),
    WebSocket: function () { return fail('CAPABILITY_DENIED', 'network'); },
    process: new Proxy({}, { get: () => fail('CAPABILITY_DENIED', 'process') }),
    require: () => fail('CAPABILITY_DENIED', 'subprocess'),
    setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    __replay: hooks,
  }, { codeGeneration: { strings: false, wasm: false } });
  const cache = new Map();
  const replacements = {
    'lib/core.js': ['callLLM', '(_env, options) => globalThis.__replay.model(options)'],
    ...(trace ? {
      'lib/ledger-question.js': ['classifyLedgerQuestion', '(...args) => { const result = actual(...args); globalThis.__replay.intent(result); return result; }'],
      'lib/ledger-answer.js': ['withLedgerAnswer', '(options, next) => { globalThis.__replay.ledger(options); return actual(options, gap => { globalThis.__replay.fallback(gap); return next(gap); }); }'],
      'lib/store-d1.js': ['search', 'async (...args) => { const result = await actual(...args); globalThis.__replay.retrieved(result); return result; }'],
    } : {}),
  };
  function load(path, original = false) {
    const local = relative(base, path);
    if (!local || local === '..' || local.startsWith(`..${sep}`) || !local.endsWith('.js') || realpathSync(path) !== path) return fail('CAPABILITY_DENIED', 'module');
    const id = path + (original ? ':original' : '');
    if (cache.has(id)) return cache.get(id);
    let source = sourceOverrides[local.split(sep).join('/').replace(/^lib\//, '')] ?? readFileSync(path, 'utf8');
    sourceFiles[relative(root, path).split(sep).join('/')] = sha256(source);
    const replacement = !original && replacements[local.split(sep).join('/')];
    if (replacement) {
      const [name, implementation] = replacement;
      source = `export * from '#original'; import { ${name} as actual } from '#original'; export const ${name} = ${implementation};`;
    }
    const module = new SourceTextModule(source, { context, identifier: id,
      importModuleDynamically: () => fail('CAPABILITY_DENIED', 'dynamic-import') });
    cache.set(id, module);
    return module;
  }
  const module = load(resolve(base, 'index.js'));
  await module.link((specifier, parent) => {
    const path = parent.identifier.replace(/:original$/, '');
    if (specifier === '#original') return load(path, true);
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return fail('CAPABILITY_DENIED', 'module');
    return load(resolve(dirname(path), specifier));
  });
  await module.evaluate({ timeout: 3000 });
  return { worker: module.namespace.default, context, sourceFiles: clone(sourceFiles),
    search: cache.get(resolve(base, 'lib/store-d1.js')).namespace.search };
}

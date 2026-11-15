import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

// Legacy command probes need injected I/O, but a hand-picked function loses
// its lexical helpers whenever production adds a dependency. Evaluate the whole
// module with its real imports, replacing only explicit test boundaries. Never
// initialize the CLI, read desktop configuration, resolve a key or open a socket.
export async function sourceModuleHarness(url, { source = readFileSync(url, 'utf8') } = {}) {
  const imports = {};
  const declarations = [...source.matchAll(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;/gm)];
  const modules = await Promise.all(declarations.map(match => import(new URL(match[3], url).href).catch(error => {
    if (match[3].startsWith('node:')) return import(match[3]);
    throw error;
  })));
  for (const [i, match] of declarations.entries()) {
    const clause = match[1].trim(), namespace = modules[i];
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) for (const item of named[1].split(',').map(s => s.trim()).filter(Boolean)) {
      const [name, alias = name] = item.split(/\s+as\s+/);
      imports[alias] = namespace[name];
    }
    const star = clause.match(/\*\s+as\s+(\w+)/);
    if (star) imports[star[1]] = namespace;
    const defaultName = clause.match(/^(\w+)(?:\s*,|$)/);
    if (defaultName) imports[defaultName[1]] = namespace.default;
    source = source.replace(match[0], '');
  }
  source = source.replace(/^#![^\n]*/, '')
    .replace(/^export\s*\{[^}]*\}(?:\s*from\s*['"][^'"]+['"])?\s*;/gm, '')
    .replace(/^export default /gm, 'const __default_export = ')
    .replace(/^export (?=(?:async )?function|const |let |class )/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  if (url.pathname.endsWith('/components/brain-mcp.mjs')) {
    assert.ok(source.includes('const CFG = loadConfig();'), 'configuration boundary exists');
    source = source.replace('const CFG = loadConfig();', 'const CFG = {};');
  }
  return (bindings = {}, expression = '({})') => {
    const handlers = {};
    const forbidden = () => { throw new Error('Uninjected external operation'); };
    const runtimeProcess = {
      env: {}, argv: [], platform: process.platform, execPath: process.execPath,
      pid: process.pid, version: process.version, versions: process.versions,
      cwd: () => dirname(fileURLToPath(url)), getuid: () => process.getuid?.() ?? 0,
      stdin: { setEncoding() {}, on: (name, handler) => { handlers[name] = handler; } },
      stdout: { write: forbidden }, stderr: { write: forbidden }, exit: forbidden,
    };
    let code = source;
    for (const name of Object.keys(bindings)) {
      assert.match(name, /^[A-Za-z_$][\w$]*$/);
      // Renaming a declaration keeps all its references on the injected binding.
      // The original body remains compiled, so syntax errors still fail the test.
      code = code.replace(new RegExp(`^(export )?(async )?function ${name}\\(`, 'm'),
        (_match, _export, async = '') => `${async}function __original_${name}(`)
        .replace(new RegExp(`^(const|let|class) ${name}(?=\\s|[={])`, 'm'), '$1 __original_'+name);
    }
    const context = {
      console, URL, Request, Response, Headers, FormData, Blob, TextEncoder, TextDecoder,
      AbortController, Buffer, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: forbidden, ...imports, ...bindings, process:{...runtimeProcess,...bindings.process},
    };
    if (url.pathname.endsWith('/components/brain-mcp.mjs')) {
      runtimeProcess.env.BRAIN_URL = 'https://brain.invalid';
      runtimeProcess.env.BRAIN_AGENT_PROFILE = bindings.PROFILE;
    }
    const script = new Script(`${code}\n;(${expression})`, {
      filename: fileURLToPath(url),
      importModuleDynamically: specifier => import(specifier.startsWith('.') ? new URL(specifier, url).href : specifier),
    });
    const result = script.runInNewContext(context, { timeout: 5000 });
    return { result, handlers, context };
  };
}

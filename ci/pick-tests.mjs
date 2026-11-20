#!/usr/bin/env node
// Fix-loop selection only. A selection, including a conservative full fallback,
// is never release evidence. No product module or test is executed by the mapper.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SMOKE_FILES = Object.freeze([
  'test/test-chain-complete.test.mjs',
  'test/test-chain-runner.test.mjs',
  'test/release-script-coverage.test.mjs',
  'test/current-version.test.mjs',
  'test/migration-checksum-pin.test.mjs',
  'worker/test/simplefin-runtime.test.mjs',
  'worker/test/highwrong-frozen-1114.test.mjs',
  'worker/test/scanned-evidence.test.mjs',
  'test/install-page-version.test.mjs',
  'test/update-audit.test.mjs',
  'scripts/test-release-workflow-contract.mjs',
  'test/errors.test.mjs',
  'test/package-privacy.test.mjs',
  'test/package-bundle-verifier.test.mjs',
]);

// These supplement imports for text/configuration and dynamic loaders. A rule
// that matches no chain command cannot justify narrowing: it falls back below.
export const DEFAULT_AREAS = Object.freeze([
  { prefix: 'docs/', tests: ['test/*docs*.test.mjs', 'test/*contract*.test.mjs', 'test/*audit*.test.mjs', 'test/*guidance*.test.mjs'] },
  { prefix: 'README.md', tests: ['test/*contract*.test.mjs', 'test/*guidance*.test.mjs'] },
  { prefix: 'CHANGELOG.md', tests: ['test/*version*.test.mjs', 'test/*whatsnew*.test.mjs', 'test/*update*.test.mjs'] },
  { prefix: 'migrations/', tests: ['test/*migration*.test.mjs'] },
  { prefix: 'skills/', tests: ['test/*skill*.test.mjs', 'test/*technician*.test.mjs', 'test/*contract*.test.mjs'] },
  { prefix: 'templates/', tests: ['test/*setup*.test.mjs', 'test/*manifest*.test.mjs', 'test/*contract*.test.mjs'] },
  { prefix: 'onboarding/', tests: ['test/*onboarding*.test.mjs', 'test/*owner-contract*.test.mjs', 'test/*guidance*.test.mjs'] },
  { prefix: 'frontend/', tests: ['test/*frontend*.test.mjs', 'test/*app-assets*.test.mjs', 'test/*owner-workspace*.test.mjs'] },
  { prefix: 'worker/src/', tests: ['worker/test/simplefin-runtime.test.mjs', 'test/package-bundle-verifier.test.mjs', 'test/financial-oracle/*.test.mjs'] },
]);
const MONOLITHS = new Set(['brain.mjs', 'worker/src/index.js']);
const REQUIRED_FULL = /^(?:migrations\/|package(?:-lock)?\.json$|scripts\/run-test-chain[^/]*\.mjs$|ci\/)/;
const CODE = /\.(?:mjs|cjs|js|jsx|ts|tsx)$/;
const KNOWN_KIND = /\.(?:mjs|cjs|js|jsx|ts|tsx|json|sql|md|txt|html|css|scss|ps1|sh|zsh|ya?ml|toml|svg|png|jpe?g|webp|ico|cmd|bat|wxs|wxi|xml)$/;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slash = (s) => s.split('\\').join('/');
function safePath(file) {
  if (typeof file !== 'string' || !file || isAbsolute(file) || file.includes('\\') || file.includes('\0') || file.split('/').some((s) => s === '..' || s === '.')) {
    throw new Error('invalid relative changed path');
  }
  return file;
}
function glob(pattern) {
  if (typeof pattern !== 'string' || !pattern) throw new Error('invalid area glob');
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
    } else if (pattern[i] === '*') out += '[^/]*';
    else if (pattern[i] === '?') out += '[^/]';
    else out += escapeRegex(pattern[i]);
  }
  return new RegExp(`^${out}$`);
}
function commandFiles(command, root) {
  if (command.startsWith('node ')) return command.split(' ').slice(1).filter((s) => !s.startsWith('--'));
  // The chain's npm arm names a script containing several eval test modules.
  const script = /^npm run ([\w:-]+)$/.exec(command);
  if (!script) throw new Error('unrecognized chain command');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const text = pkg.scripts?.[script[1]];
  if (typeof text !== 'string') throw new Error('missing npm test script');
  const files = text.match(/(?:eval|scripts|test|worker\/test)\/[\w./-]+\.mjs/g) || [];
  if (!files.length) throw new Error('unmapped npm test script');
  return files;
}
async function loadCommands(root) {
  const { TEST_COMMANDS } = await import(pathToFileURL(join(root, 'scripts/run-test-chain.mjs')).href);
  if (!Array.isArray(TEST_COMMANDS) || !TEST_COMMANDS.length || TEST_COMMANDS.some((s) => typeof s !== 'string' || !s)) {
    throw new Error('cannot read a nonempty ordered test chain');
  }
  return TEST_COMMANDS;
}
function resultFor(commands, reasons, notes, fullChain, changedFiles) {
  const picked = commands.flatMap((command, index) => reasons[index].size ? [{ index, command, reasons: [...reasons[index]] }] : []);
  return { mode: 'section', certifies: false, fullChain, total: commands.length, commands: picked.map((r) => r.command), picked, notes, changedFiles };
}
function fullResult(commands, reason, changedFiles = []) {
  const note = `${reason}; run the full chain`;
  return resultFor(commands, commands.map((command) => new Set([note, ...SMOKE_FILES.filter((file) => command.split(' ').includes(file)).map((file) => `always-run smoke: ${file}`)])), [note], true, changedFiles);
}

function mapper(root) {
  const texts = new Map(); const edgeCache = new Map();
  function checkedPath(file) {
    let path = root;
    for (const part of safePath(file).split('/')) {
      path = join(path, part);
      // Check each component before any read/exists probe can follow an alias,
      // including a dangling link or a directory link outside the checkout.
      let stat;
      try { stat = lstatSync(path); } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') break;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error('symlink dependency cannot be mapped');
    }
    return join(root, file);
  }
  const text = (file) => {
    if (!texts.has(file)) texts.set(file, readFileSync(checkedPath(file), 'utf8'));
    return texts.get(file);
  };
  function target(from, spec, literal = false) {
    const candidates = [];
    if (spec.startsWith('.')) candidates.push(slash(relative(root, resolve(root, dirname(from), spec))));
    else if (literal) candidates.push(spec);
    for (const candidate of candidates) {
      if (candidate.startsWith('../') || isAbsolute(candidate)) continue;
      for (const suffix of ['', '.js', '.mjs', '/index.js', '/index.mjs']) {
        const file = candidate + suffix;
        const path = checkedPath(file);
        if (existsSync(path)) {
          // Directories are not dependency edges.
          try { readFileSync(path, { encoding: 'utf8', flag: 'r' }); return file; } catch { /* try next suffix */ }
        }
      }
    }
    // A vanished import is still a dependency. A folder area cannot establish
    // coverage for its now-failing consumer after a deletion or rename.
    if (!literal && spec.startsWith('.')) throw new Error('unresolved local dependency cannot be mapped');
    return null;
  }
  function edges(file) {
    if (edgeCache.has(file)) return edgeCache.get(file);
    const found = new Set(); edgeCache.set(file, found);
    if (!CODE.test(file)) return found;
    const source = text(file);
    // A recognized edge in another test does not resolve a computed loader.
    // Only a complete quoted argument is known; prefixes and templates widen.
    for (const call of source.matchAll(/\b(?:import|require)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\(/g)) {
      if (!/^\s*(['"])([^'"\r\n]+)\1\s*\)/.test(source.slice(call.index + call[0].length))) {
        throw new Error('computed dependency cannot be mapped');
      }
    }
    const patterns = [
      /\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
      /\bexport\s+[^'"`;]*?\s+from\s+['"]([^'"\n]+)['"]/g,
      /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]/g,
      /new\s+URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url/g,
    ];
    for (const re of patterns) for (const m of source.matchAll(re)) {
      const file = targetFrom(m[1]); if (file) found.add(file);
    }
    function targetFrom(spec) { return target(file, spec); }
    // Literal paths cover extractors, subprocesses and source-reading tests that
    // do not import a product module. False positive edges only add work.
    for (const m of source.matchAll(/['"`]((?:\.\.?\/)*[\w-][\w./-]*\.(?:mjs|cjs|js|json|sql|md|ps1|sh|zsh))['"`]/g)) {
      const next = target(file, m[1], true); if (next && next !== file) found.add(next);
    }
    return found;
  }
  function reach(files) {
    const seen = new Set(files); let frontier = files;
    for (let level = 0; level < 2; level++) {
      const next = [];
      for (const file of frontier) for (const dependency of edges(file)) if (!seen.has(dependency)) {
        seen.add(dependency); next.push(dependency);
      }
      frontier = next;
    }
    return seen;
  }
  return { text, reach, checkedPath };
}

function functionRegions(source) {
  const lines = source.split('\n'); const regions = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(/.exec(lines[i]);
    if (!m) continue;
    if ((lines[i].match(/\bfunction\b/g) || []).length > 1) return [];
    let end = i;
    // Only unindented named functions with a recognizable closing boundary are
    // eligible. Unsupported arrow/class/top-level edits must use the full chain.
    if (!/\{.*\}\s*;?\s*$/.test(lines[i])) {
      end = i + 1;
      while (end < lines.length && !/^}\s*;?\s*$/.test(lines[end])) end++;
      if (end === lines.length) continue;
    }
    regions.push({ name: m[1], start: i + 1, end: end + 1, body: lines.slice(i, end + 1).join('\n') });
  }
  return regions;
}
function changedSymbols(source, diff) {
  if (!diff || /Binary files/.test(diff) || /^-\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+/m.test(diff)) return null;
  const regions = functionRegions(source); const names = new Set(); let covered = 0;
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@[^\n]*$/gm)) {
    const start = Number(match[1]); const count = Number(match[2] ?? 1);
    // Deletions and edits spanning boundaries need old-tree analysis; do not
    // pretend a preceding hunk header proves which function was removed.
    if (!count) return null;
    const region = regions.find((r) => start >= r.start && start + count - 1 <= r.end);
    if (!region) return null;
    names.add(region.name); covered++;
  }
  if (!covered) return null;
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of regions) if (!names.has(r.name) && [...names].some((s) => new RegExp(`\\b${escapeRegex(s)}\\s*\\(`).test(r.body))) {
      names.add(r.name); grew = true;
    }
  }
  return names;
}

/** Returns chain-ordered commands and a reason per command. smoke only ADDS to
 * the mandatory set; callers cannot remove the release-safety smoke by mistake.
 * areas is an optional [{prefix, tests: [test-file glob]}] replacement table.
 * Changed entries can be paths or {path, oldPath?, diff?}; absent monolith diff
 * information fails safe. A rename must explain both its old and new paths.
 */
export async function pickTests({ root, changedFiles, areas = DEFAULT_AREAS, smoke = [] }) {
  root = resolve(root);
  const commands = await loadCommands(root);
  let changes; let files;
  try {
    if (!Array.isArray(changedFiles)) throw new Error('missing changed-file list');
    changes = changedFiles.map((entry) => typeof entry === 'string' ? { path: safePath(entry) } : { ...entry, path: safePath(entry.path), ...(entry.oldPath ? { oldPath: safePath(entry.oldPath) } : {}) });
    files = [...new Set(changes.flatMap((e) => [e.path, e.oldPath].filter(Boolean)))];
    const rows = commands.map((command) => commandFiles(command, root));
    const reasons = commands.map(() => new Set());
    const mandatory = [...new Set([...SMOKE_FILES, ...smoke])];
    for (const file of mandatory) {
      let matched = false;
      rows.forEach((row, i) => { if (row.includes(file) || commands[i] === file) { reasons[i].add(`always-run smoke: ${file}`); matched = true; } });
      if (!matched) throw new Error(`missing smoke command: ${file}`);
    }
    const finish = (notes, fullChain = false) => resultFor(commands, reasons, notes, fullChain, files);
    const fallback = (reason) => {
      const note = `${reason}; run the full chain`;
      reasons.forEach((set) => set.add(note));
      return finish([note], true);
    };
    for (const file of files) if (REQUIRED_FULL.test(file)) return fallback(`refuses to narrow: ${file}`);
    if (!files.length) return finish(['empty diff: only the always-run smoke set']);
    if (!Array.isArray(areas)) throw new Error('invalid area map');
    const rules = areas.map((rule) => {
      safePath(rule.prefix);
      if (!Array.isArray(rule.tests) || !rule.tests.length) throw new Error('empty area rule');
      return { ...rule, patterns: rule.tests.map(glob) };
    });
    const graph = mapper(root);
    files.forEach(graph.checkedPath);
    const reach = rows.map((row) => graph.reach(row));
    if (!reach.some((set, i) => set.size > rows[i].length)) return fallback('empty dependency map');
    for (const file of files) {
      if (!KNOWN_KIND.test(file)) return fallback(`unknown file kind: ${file}`);
      if (/\.test\.mjs$/.test(file) && !rows.some((row) => row.includes(file))) return fallback(`unregistered test: ${file}`);
      let matched = false;
      let symbols = null;
      if (MONOLITHS.has(file)) {
        const entry = changes.find((e) => e.path === file);
        symbols = changedSymbols(graph.text(file), entry?.diff);
        if (!symbols) return fallback(`cannot locate changed functions: ${file}`);
      }
      rows.forEach((row, i) => {
        if (row.includes(file)) { reasons[i].add(`changed test: ${file}`); matched = true; }
        else if (symbols) {
          const texts = [...reach[i]].filter((f) => /^(?:test|worker\/test|eval)\//.test(f) && CODE.test(f)).map(graph.text).join('\n');
          const mentions = [...symbols].filter((s) => new RegExp(`\\b${escapeRegex(s)}\\b`).test(texts));
          if (mentions.length) { reasons[i].add(`function mentions in ${file}: ${mentions.join(', ')}`); matched = true; }
        } else if (reach[i].has(file)) { reasons[i].add(`dependency within two levels: ${file}`); matched = true; }
        // Read-file and dynamic-loader references can name non-JS fixtures by
        // basename. This only adds tests; it never removes an import selection.
        if (!CODE.test(file)) {
          const name = file.split('/').at(-1);
          if ([...reach[i]].some((f) => CODE.test(f) && /^(?:test|worker\/test|eval)\//.test(f) && graph.text(f).includes(name))) {
            reasons[i].add(`fixture/text reference: ${file}`); matched = true;
          }
        }
        for (const rule of rules) if (file.startsWith(rule.prefix) && row.some((f) => rule.patterns.some((re) => re.test(f)))) {
          reasons[i].add(`area ${rule.prefix}: ${file}`);
          if (rule.prefix !== 'worker/src/') matched = true;
        }
      });
      if (!matched) return fallback(`unmapped changed path: ${file}`);
    }
    return finish(['section run, not a release verdict']);
  } catch (error) {
    // Do not echo raw git output, paths from an error stack or source content.
    const reason = error instanceof Error && /^(?:missing smoke command|invalid |missing changed|empty area|(?:computed|symlink|unresolved local) dependency cannot be mapped$)/.test(error.message) ? error.message : 'dependency map could not be built';
    return fullResult(commands, reason, files || []);
  }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
function localGit(root, args) {
  // Git reads only, with no inherited credential helpers or desktop environment.
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
}
function ignoreRules(root, base) {
  const path = join(root, base, '.gitignore');
  if (!existsSync(path)) return [];
  const rules = [];
  for (let line of readFileSync(path, 'utf8').split('\n')) {
    line = line.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const negative = line.startsWith('!');
    if (negative) line = line.slice(1);
    // Unsupported ignore syntax may only ADD candidates. An unsupported
    // negation disables filtering in this scope so a re-included test is safe.
    if (!line || /[\\[\]\s]/.test(line) || line.split('/').some((part) => part.includes('**') && part !== '**')) { if (negative) return null; continue; }
    const directory = line.endsWith('/');
    if (directory) line = line.slice(0, -1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    rules.push({ base, negative, directory, basename: !anchored && !line.includes('/'), pattern: glob(line) });
  }
  return rules;
}
function untrackedFiles(root, tracked) {
  const found = [];
  const walk = (dir, inherited) => {
    const local = ignoreRules(root, dir);
    const rules = local === null ? [] : [...inherited, ...local];
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const file = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      let ignored = false;
      for (const rule of rules) {
        if (rule.directory && !entry.isDirectory()) continue;
        const within = rule.base ? file.slice(rule.base.length + 1) : file;
        if (rule.pattern.test(rule.basename ? entry.name : within)) ignored = !rule.negative;
      }
      if (ignored) continue;
      if (entry.isDirectory()) walk(file, rules);
      else if (!tracked.has(file)) found.push(file);
      if (found.length > 10000) throw new Error('untracked inventory too large');
    }
  };
  walk('', []);
  return found;
}

/** Ref-to-working-tree diff includes committed, staged and unstaged changes.
 * No merge-base shortcut: changes on either side of the supplied ref count.
 * Both rename paths survive --no-renames. Untracked paths are a conservative
 * superset: unsupported ignore syntax and global excludes may add candidates.
 */
export async function pickChangedTests({ root, ref, areas, smoke, git = (args) => localGit(root, args), untracked = untrackedFiles }) {
  root = resolve(root);
  let changes;
  try {
    if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error('invalid git reference');
    const names = String(git(['diff', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames', '-z', ref, '--'])).split('\0').filter(Boolean);
    const tracked = new Set(String(git(['diff', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames', '-z', EMPTY_TREE, 'HEAD', '--'])).split('\0').filter(Boolean));
    changes = [...new Set([...names, ...untracked(root, tracked)])].map((path) => ({ path }));
    for (const entry of changes) if (MONOLITHS.has(entry.path)) entry.diff = String(git(['diff', '--no-ext-diff', '--no-textconv', '--unified=0', ref, '--', entry.path]));
  } catch {
    return fullResult(await loadCommands(root), 'git change inventory failed');
  }
  return pickTests({ root, changedFiles: changes, areas, smoke });
}

/** An exact --only-style matcher, without a caller regex that could drop smoke. */
export function selectionMatcher(selection) {
  const commands = new Set(selection.commands);
  return { test: (command) => commands.has(command), toString: () => 'changed-file selection' };
}

export async function cli(argv) {
  let root = resolve(fileURLToPath(new URL('../', import.meta.url)));
  let areas; const changedFiles = []; let ref;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--root' || flag === '--areas' || flag === '--changed-since') {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--root') root = resolve(value);
      else if (flag === '--areas') {
        try { areas = JSON.parse(readFileSync(value, 'utf8')); } catch { areas = null; }
      } else ref = value;
    } else if (flag === '--changed') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) changedFiles.push(argv[++i]);
    } else throw new Error('unknown picker option');
  }
  if (ref && changedFiles.length) throw new Error('cannot combine --changed and --changed-since');
  const selection = ref ? await pickChangedTests({ root, ref, areas }) : await pickTests({ root, changedFiles, areas });
  console.log(JSON.stringify(selection, null, 2));
  return selection;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch(() => { console.error('picker configuration error: cannot read the ordered chain'); process.exitCode = 2; });
}

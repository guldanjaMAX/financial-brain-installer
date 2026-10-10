/** Disable each selected refusal on a disposable copy, then run its real probes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const groups = [
  ['brain.mjs', 'test/quickbooks-owner-cli.test.mjs'],
  ['connectors/quickbooks-owner-binding.mjs', 'test/quickbooks-owner-setup.test.mjs'],
  ['operations/quickbooks-owner-transfer.mjs', 'test/quickbooks-owner-setup.test.mjs'],
  ['operations/quickbooks-owner-setup.mjs', 'test/quickbooks-owner-setup.test.mjs'],
  ['connectors/provider-oauth.mjs', 'test/quickbooks-owner-setup.test.mjs'],
  ['worker/src/lib/quickbooks-owner-setup.js', 'worker/test/quickbooks-owner-setup.test.mjs'],
  ['worker/src/lib/quickbooks-oauth-callback.js', 'worker/test/quickbooks-oauth-callback.test.mjs'],
];
for (const [file, suite] of groups) {
  const source = readFileSync(new URL(file, root), 'utf8');
  const testSource = readFileSync(new URL(suite, root), 'utf8');
  const guards = file === 'brain.mjs'
    ? [
        ['if (flags.edition !== undefined && !["online", "desktop"].includes(flags.edition)) die("--edition must be online or desktop");', 'cli_edition'],
        ['if (flags["owner-app-setup"] !== undefined && flags["owner-app-setup"] !== true) die("--owner-app-setup does not take a value");', 'cli_setup_flag'],
        ['if (flags["owner-app-setup"] && flags.edition === "desktop") die("owner-app setup is for QuickBooks Online");', 'cli_setup_edition'],
        ['if (flags.reconnect !== undefined && flags.reconnect !== true) die("--reconnect does not take a value");', 'cli_reconnect'],
        ['if (provider === "quickbooks" && flags["owner-app-setup"] !== undefined) die("owner-app setup requires the production environment");', 'cli_setup_environment'],
      ].map(([text, code]) => Object.assign([text, "'", code], { index: source.indexOf(text) }))
    : file.endsWith('quickbooks-oauth-callback.js')
    ? [
        ['if (startUrl.protocol !== "https:" || startUrl.port) routeError("quickbooks_oauth_origin_invalid");', 'quickbooks_oauth_origin_invalid'],
        ['if (row.redirect_uri !== `${url.origin}${url.pathname}`) return;', 'quickbooks_callback_redirect_match'],
      ].map(([text, code]) => Object.assign([text, "'", code], { index: source.indexOf(text) }))
    : file.startsWith('worker/')
      ? [...source.matchAll(/return refused\((['"])([a-z_]+)\1, \d+\);/g)]
      : [...source.matchAll(/throw ownerAppError\((['"])([a-z_]+)\1\);/g)];
  for (const [index, guard] of guards.entries()) test(`mutation ${file}:${index + 1} ${guard[2]}`, () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'qbo-mutation-')));
    try {
      const quietFile = process.env.BRAIN_TEST_QUIET_FILE;
      assert.equal(Boolean(quietFile && existsSync(quietFile)), false, 'MAC-QUIET became active; stop mutation tests');
      assert.ok(guard.index >= 0, 'guard premise must match the source');
      const original = new URL(file, root).href;
      const copy = pathToFileURL(join(dir, 'mutant.mjs')).href;
      writeFileSync(join(dir, 'source.sha256'), createHash('sha256').update(source).digest('hex') + '\n');
      const modified = source.slice(0, guard.index) + 'void 0;' + source.slice(guard.index + guard[0].length);
      writeFileSync(join(dir, 'mutant.mjs'), file === 'brain.mjs' ? modified.replaceAll('import.meta.url', JSON.stringify(original)) : modified);
      const loader = `export async function resolve(specifier, context, next) {
        const parentURL = context.parentURL === ${JSON.stringify(copy)} ? ${JSON.stringify(original)} : context.parentURL;
        const result = await next(specifier, { ...context, parentURL });
        return result.url === ${JSON.stringify(original)} ? { ...result, url: ${JSON.stringify(copy)} } : result;
      }`;
      writeFileSync(join(dir, 'loader.mjs'), loader);
      const env = { HOME: process.env.HOME, USERPROFILE: process.env.HOME, TMPDIR: process.env.TMPDIR,
        BRAIN_NO_WRANGLER_LOGIN: '1', PATH: process.env.PATH, ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) };
      const headings = [...testSource.matchAll(/test\('([^']+)'/g)];
      const relevant = headings.filter((heading, at) => file.startsWith('worker/') || testSource.slice(heading.index, headings[at + 1]?.index).includes(guard[2]) ||
        (file.endsWith('quickbooks-owner-transfer.mjs') && heading[1].includes('transfer expiry while')) ||
        (file.endsWith('provider-oauth.mjs') && guard[2] === 'quickbooks_owner_binding_conflict' && heading[1].includes('refresh commit')));
      const pattern = relevant.length ? relevant.map((match) => match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : null;
      const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', join(dir, 'loader.mjs'), '--test',
        ...(pattern ? ['--test-name-pattern=' + pattern] : []), suite], {
        cwd: root, env, encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024,
      });
      assert.equal(readFileSync(new URL(file, root), 'utf8'), source, 'product source changed during mutation run');
      assert.equal(readFileSync(new URL(suite, root), 'utf8'), testSource, 'probe source changed during mutation run');
      assert.equal(result.error, undefined, 'mutation subprocess must complete');
      assert.equal(result.signal, null, 'mutation must fail an assertion, not terminate');
      assert.notEqual(result.status, 0, `SURVIVED ${file}:${source.slice(0, guard.index).split('\n').length}`);
      assert.match(result.stdout + result.stderr, /ERR_ASSERTION|AssertionError/, 'a killed guard needs an assertion failure');
      assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|LANE_HOST_BOUNDARY_BLOCKED/, 'broken harness is not a killed guard');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

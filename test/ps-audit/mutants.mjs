import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run manually with an untouched `git archive HEAD` snapshot directory.
// Mutations exist only in a disposable system-temp copy, never in the worktree.
const root = fileURLToPath(new URL('../../', import.meta.url));
const base = process.argv[2];
assert.ok(base, 'supply the base snapshot directory');
const preflight = 'tools/preflight.ps1';
// The preservation fold can verify only script mutations while leaving the
// separate JavaScript-helper audit available for its own integration.
const powershellOnly = process.argv.includes("--powershell-only");
const mutations = [
  ['D01', preflight, s => s.replace('$copies = @($copies | Where-Object { $_ } | Sort-Object -Unique)', '$copies = $copies | Where-Object { $_ } | Sort-Object -Unique')],
  ['D02', preflight, s => s.replace('Test-Path -LiteralPath "$fb\\brain.cmd"', 'Test-Path "$fb\\brain.cmd"')],
  ['D03', preflight, s => s.replace('Get-Content -LiteralPath $mf[0].FullName -Raw -Encoding UTF8', 'Get-Content -LiteralPath $mf[0].FullName -Raw')],
  ['D04', preflight, s => s.replace('$LASTEXITCODE -ne 0 -or $npmOutput.Count -ne 1', '$npmOutput.Count -ne 1')],
  ['D05', 'machine-prep/prep-windows.ps1', s => s.replace('$LASTEXITCODE -ne 0 -or $output.Count -eq 0', '$output.Count -eq 0')],
  ['D06', 'onboarding/start-windows-rehearsal.ps1', s => s.replaceAll(' | Select-Object -First 1', '')],
  ...[['D07', 'operations/quickbooks-desktop-signed.mjs'], ['D08', 'connectors/quickbooks-desktop-binding.mjs']].map(([id,path]) =>
    [id,path,s => s.replace('[IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false)).ReadToEnd()', '[Console]::In.ReadToEnd()')]),
  ['D09', 'machine-prep/handoff/handoff-windows.ps1', s => s.replace(/^\$escapedClaude =[^\n]+/m, `$escapedClaude = $claude.Replace("'", "''")`).replace(/^\$escapedPrompt =[^\n]+/m, `$escapedPrompt = $PromptPath.Replace("'", "''")`)],
  ['D10', 'machine-prep/installers/smoke/windows-payload.ps1', s => s.replaceAll(' -Encoding UTF8', '')],
  ['D11', 'operations/custom-api-clipboard.mjs', s => s.replace('[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ', '')],
].filter(([,path]) => !powershellOnly || /\.ps(?:1|m1)$/.test(path));
const sandbox = mkdtempSync(join(tmpdir(), 'brain-ps-mutants-'));
try {
  cpSync(base, sandbox, {recursive:true, filter:path => !path.endsWith('base.tar')});
  const paths = [...new Set(mutations.map(([,path]) => path))];
  for (const path of paths) cpSync(join(root,path),join(sandbox,path));
  const env = Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATH','PATHEXT'].filter(k => process.env[k]).map(k => [k,process.env[k]]));
  let killed = 0;
  for (const [id,path,mutate] of mutations) {
    const original = readFileSync(join(root,path),'utf8');
    const changed = mutate(original);
    assert.notEqual(changed,original,`${id}: mutation did not apply`);
    writeFileSync(join(sandbox,path),changed);
    const result = spawnSync(process.execPath,['--test','--test-reporter=tap',`--test-name-pattern=^${id} `,join(root,'test/ps-audit/native.test.mjs')], {
      encoding:'utf8', windowsHide:true, shell:false, timeout:60000,
      env:{...env,PS_AUDIT_ROOT:sandbox},
    });
    writeFileSync(join(sandbox,path),original);
    assert.ifError(result.error);
    assert.equal(result.status,1,`${id}: mutant survived\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout,new RegExp(`not ok \\d+ - ${id} `));
    // One selected defect may fail on both installed PowerShell runtimes.
    assert.match(result.stdout,/# fail [1-9]\d*\b/);
    killed++;
    console.log(`${id}: killed; disposable source restored`);
  }
  console.log(`mutants_killed=${killed}/${mutations.length}`);
} finally { rmSync(sandbox,{recursive:true,force:true}); }

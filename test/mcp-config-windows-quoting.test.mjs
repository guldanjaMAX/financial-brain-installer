/**
 * `brain mcp-config <manifest>` prints a Claude Code and a Codex command for
 * the owner to paste. On Windows that paste lands in PowerShell, which rejects
 * POSIX backslash continuations, and a bare `--` can be consumed by PowerShell
 * before the tool sees it (an npm .ps1 shim drops it). On win32 each command is therefore one PowerShell-ready
 * line: single-quoted arguments, embedded ' doubled, and the separator written
 * as '--'. macOS and Linux output stays byte-for-byte what it always was.
 *
 * Isolation: a synthetic manifest with brain.domain set (no Cloudflare lookup),
 * the default adjacent-file admin key holding a fixture value (no keychain),
 * a scratch HOME/USERPROFILE, BRAIN_NO_WRANGLER_LOGIN=1, and a fetch tripwire.
 * Nothing here runs claude or codex.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { cmdMcpConfig, mcpRegistrationDescriptor } from "../brain.mjs";
import {
  adminKeyPersistencePlan,
  persistAdminKeyDurably,
} from "../operations/admin-key-persistence.mjs";

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-mcp-config-quoting-")));
const fixtureKey = `fixture-${"f".repeat(48)}`;
const nativeFileOptions = process.platform === "win32"
  ? { username: process.env.USERNAME || process.env.USER }
  : {};

const priorEnvironment = {};
const priorFetch = globalThis.fetch;
let fetchCalls = 0;

before(() => {
  const scratchHome = join(sandbox, "scratch home");
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });
  for (const [key, value] of Object.entries({
    HOME: scratchHome,
    USERPROFILE: scratchHome,
    BRAIN_NO_WRANGLER_LOGIN: "1",
  })) {
    priorEnvironment[key] = process.env[key];
    process.env[key] = value;
  }
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("mcp-config must not reach the network in this test");
  };
});

after(() => {
  globalThis.fetch = priorFetch;
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function writeFixtureInstall(folderName, slug) {
  const manifest = JSON.parse(readFileSync(new URL("../templates/brain.manifest.json", import.meta.url), "utf8"));
  manifest.client = { slug, display_name: "Payer Brain", timezone: "UTC" };
  manifest.brain = { ...manifest.brain, domain: "payer-brain.fixture.invalid", worker_name: "payer-brain" };
  manifest.infrastructure.cloudflare.account_id = "0".repeat(32);
  manifest.operations = { ...manifest.operations, admin_key_secret: null };
  const directory = join(sandbox, folderName);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifestPath = join(directory, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const plan = adminKeyPersistencePlan(manifestPath, manifest, nativeFileOptions);
  persistAdminKeyDurably(plan, fixtureKey, nativeFileOptions);
  const descriptor = mcpRegistrationDescriptor(manifest, manifestPath, {
    baseUrl: `https://${manifest.brain.domain}`,
  });
  return { manifestPath, descriptor };
}

async function render(manifestPath, platform) {
  const prior = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.map(String).join(" "));
  try {
    await cmdMcpConfig(manifestPath, { flags: {}, platform });
  } finally {
    console.log = prior;
  }
  // Headings are bold on a color terminal; the commands themselves never carry escapes.
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/* The exact POSIX templates as main printed them before this change. */
function posixQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function legacyPosixClaude({ name, env, command, args }) {
  return (
    `  claude mcp add --scope user ${posixQuote(name)} \\\n` +
      Object.entries(env).map(([key, value]) => `    -e ${posixQuote(`${key}=${value}`)} \\\n`).join("") +
      `    -- ${posixQuote(command)} ${args.map(posixQuote).join(" ")}\n`
  );
}

function legacyPosixCodex({ name, env, command, args }) {
  return (
    `  codex mcp add ${posixQuote(name)} \\\n` +
      Object.entries(env).map(([key, value]) => `    --env ${posixQuote(`${key}=${value}`)} \\\n`).join("") +
      `    -- ${posixQuote(command)} ${args.map(posixQuote).join(" ")}\n`
  );
}

/** The argv each tool must receive, element by element. */
function intendedArgv(tool, { name, env, command, args }) {
  const envFlag = tool === "claude" ? "-e" : "--env";
  const head = tool === "claude" ? ["mcp", "add", "--scope", "user"] : ["mcp", "add"];
  return [
    ...head,
    name,
    ...Object.entries(env).flatMap(([key, value]) => [envFlag, `${key}=${value}`]),
    "--",
    command,
    ...args,
  ];
}

/**
 * A strict reader for the only two token shapes the win32 line may contain:
 * a bare word made of [A-Za-z0-9-] (the tool and its literal flags) or a
 * PowerShell single-quoted string. As in PowerShell's own tokenizer, ' and the
 * typographic U+2018, U+2019, U+201A and U+201B all open and close it, and two
 * in a row stand for the second one. Anything else, including a backslash
 * continuation, fails the test.
 */
const POWERSHELL_SINGLE_QUOTES = new Set(["'", "\u2018", "\u2019", "\u201A", "\u201B"]);

function readPowerShellLine(line) {
  const tokens = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === " ") { index += 1; continue; }
    if (POWERSHELL_SINGLE_QUOTES.has(line[index])) {
      let value = "";
      index += 1;
      for (;;) {
        assert.ok(index < line.length, `unterminated quoted argument in ${line}`);
        if (POWERSHELL_SINGLE_QUOTES.has(line[index])) {
          if (POWERSHELL_SINGLE_QUOTES.has(line[index + 1])) { value += line[index + 1]; index += 2; continue; }
          index += 1;
          break;
        }
        value += line[index];
        index += 1;
      }
      tokens.push({ value, quoted: true });
      continue;
    }
    const match = /^[A-Za-z0-9-]+/.exec(line.slice(index));
    assert.ok(match, `unexpected character ${JSON.stringify(line[index])} in ${line}`);
    tokens.push({ value: match[0], quoted: false });
    index += match[0].length;
  }
  return tokens;
}

function commandLine(output, tool) {
  const lines = output.split("\n").filter((line) => line.startsWith(`  ${tool} mcp add `));
  assert.equal(lines.length, 1, `exactly one ${tool} mcp add line`);
  return lines[0];
}

const cases = [
  {
    label: "a path with a space, an apostrophe, a dollar sign and a non-ASCII letter",
    folder: "Payer's $Brain Ü",
    slug: "payer-brain",
    printed: "Payer''s $Brain Ü",
  },
  {
    label: "a brain name with an apostrophe as well",
    folder: "Payer's $Brain Ü second",
    slug: "payer's-brain",
    printed: "Payer''s $Brain Ü",
  },
  {
    label: "a path with a typographic apostrophe, which PowerShell also reads as a quote",
    folder: "Payer\u2019s $Brain Ü curly",
    slug: "payer-brain",
    printed: "Payer\u2019\u2019s $Brain Ü",
  },
];

for (const fixture of cases) {
  test(`POSIX output is byte-for-byte unchanged: ${fixture.label}`, async () => {
    const { manifestPath, descriptor } = writeFixtureInstall(`posix ${fixture.folder}`, fixture.slug);
    assert.ok(descriptor.env.BRAIN_MANIFEST.includes(fixture.folder));
    for (const platform of ["darwin", "linux"]) {
      const output = await render(manifestPath, platform);
      assert.ok(
        output.includes(`Claude Code: run this once, then it works in every folder:\n\n${legacyPosixClaude(descriptor)}`),
        `${platform}: the Claude Code block matches the pre-change POSIX template`,
      );
      assert.ok(
        output.includes(`Codex: run this once:\n\n${legacyPosixCodex(descriptor)}`),
        `${platform}: the Codex block matches the pre-change POSIX template`,
      );
      assert.ok(output.includes(`  Confirm with: codex mcp get ${posixQuote(descriptor.name)}\n`));
      assert.doesNotMatch(output, /in PowerShell/);
    }
    assert.equal(await render(manifestPath, "darwin"), await render(manifestPath, "linux"));
    assert.equal(fetchCalls, 0, "no network lookup happened");
  });

  test(`win32 prints one PowerShell-ready line per tool: ${fixture.label}`, async () => {
    const { manifestPath, descriptor } = writeFixtureInstall(`win32 ${fixture.folder}`, fixture.slug);
    const output = await render(manifestPath, "win32");

    assert.doesNotMatch(output, / \\\n/, "no backslash continuation anywhere");
    assert.doesNotMatch(output, /backslash/i);
    assert.match(output, /Claude Code: run this once in PowerShell, as one line, then it works in every folder:/);
    assert.match(output, /Codex: run this once in PowerShell, as one line:/);
    assert.ok(output.includes(`  Confirm with: codex mcp get '${descriptor.name.replaceAll("'", "''")}'\n`));

    for (const tool of ["claude", "codex"]) {
      const line = commandLine(output, tool);
      const tokens = readPowerShellLine(line);
      assert.deepEqual(tokens.map(({ value }) => value), [tool, ...intendedArgv(tool, descriptor)]);

      // Exactly the flag words stay bare; every value, and the separator, is quoted.
      const bare = tokens.filter(({ quoted }) => !quoted).map(({ value }) => value);
      assert.deepEqual(
        bare,
        tool === "claude"
          ? ["claude", "mcp", "add", "--scope", "user", ...Object.keys(descriptor.env).map(() => "-e")]
          : ["codex", "mcp", "add", ...Object.keys(descriptor.env).map(() => "--env")],
      );
      assert.ok(line.includes(" '--' "), "the separator is written as '--'");
      assert.doesNotMatch(line, / -- /, "no bare -- separator");

      // Embedded apostrophes are doubled; $ and non-ASCII stay literal inside single quotes.
      assert.ok(line.includes(fixture.printed), "the manifest path keeps its apostrophe doubled, $ and Ü literal");
      if (descriptor.name.includes("'")) {
        assert.ok(line.includes(`'${descriptor.name.replaceAll("'", "''")}'`));
      }
    }
    assert.equal(fetchCalls, 0, "no network lookup happened");
  });
}

test("platform defaults to the machine running the command", async () => {
  const { manifestPath } = writeFixtureInstall("default Payer's $Brain Ü", "payer-brain");
  const implicit = await render(manifestPath, undefined);
  const explicit = await render(manifestPath, process.platform);
  assert.equal(implicit, explicit);
});

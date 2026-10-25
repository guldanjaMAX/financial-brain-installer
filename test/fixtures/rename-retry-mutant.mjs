import { registerHooks } from "node:module";

const mutations = {
  no_retry: [[
    '["EPERM", "EACCES", "EBUSY"].includes(error?.code) && attempt < 9',
    "false",
  ]],
  retry_every_error: [[
    '["EPERM", "EACCES", "EBUSY"].includes(error?.code) && attempt < 9',
    "attempt < 9",
  ]],
  unbounded_tries: [[" && attempt < 9", ""]],
  skip_retry_revalidation: [
    ["    revalidate();", "    if (attempt === 0) revalidate();"],
    ["    await revalidate();", "    if (attempt === 0) await revalidate();"],
  ],
  remove_platform_gate: [['platform === "win32" && ', ""]],
  skip_byte_proof: [['    if (!timingSafeEqual(observed, intended)) return false;', "    // Mutation: accept same-length rewritten bytes."]],
  skip_sync_byte_proof_call: [[
    "    if (!requireStagedBytes(from, staged, fs, attempt, platform)) {\n      sleep(225);\n      continue;\n    }",
    "    // Mutation: omit the synchronous staged byte proof.",
  ]],
  skip_async_byte_proof_call: [[
    "    if (!requireStagedBytes(from, staged, fs, attempt, platform)) {\n      await sleep(225);\n      continue;\n    }",
    "    // Mutation: omit the asynchronous staged byte proof.",
  ]],
  oversized_proof_read: [[
    "    observed = Buffer.alloc(intended.length);",
    "    observed = Buffer.alloc(intended.length);\n    io.readSync(descriptor, Buffer.alloc(intended.length + 65536), 0, intended.length + 65536, 0);",
  ]],
  path_only_cleanup: [[
    "    if (current === null || !sameInode(current, created)) return false;",
    "    if (current === null) return false;",
  ]],
  drop_ctime: [
    ['"mtimeMs", "ctimeMs", "mode"', '"mtimeMs", "mode"'],
    ['"mtimeNs", "ctimeNs", "mode"', '"mtimeNs", "mode"'],
  ],
  restore_staging_ctime: [[
    'keys.filter(key => key !== "ctimeMs" && key !== "ctimeNs")',
    'keys',
  ]],
};
const chosen = process.env.BRAIN_RENAME_MUTANT;
if (!Object.hasOwn(mutations, chosen)) throw new Error("Unknown rename retry mutation");
const helperUrl = new URL("../../operations/rename-retry.mjs", import.meta.url).href;

// Change only the module loaded by this test process, preserving product bytes.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url !== helperUrl) return result;
  let source = String(result.source).replace(/\r\n/g, "\n");
  for (const [target, replacement] of mutations[chosen]) {
    if (source.split(target).length !== 2) throw new Error("Rename retry mutation target missing or ambiguous");
    source = source.replace(target, replacement);
  }
  process.stderr.write(`MUTATION_APPLIED ${chosen}\n`);
  return { ...result, source };
} });

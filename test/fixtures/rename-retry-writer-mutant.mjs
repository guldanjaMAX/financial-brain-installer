import { registerHooks } from "node:module";

const mutations = {
  workspace_reread: {
    path: "../../operations/claude-workspace.mjs",
    target: "!unchangedWorkspaceIdentity(temporary, staged, ownership)",
    replacement: "!unchangedWorkspaceFile(temporary, staged, content, ownership)",
  },
  workspace_keep_lock: {
    path: "../../operations/claude-workspace.mjs",
    target: "if (error === identityRefusal) return notWritten();",
    replacement: 'if (error === identityRefusal || ["EPERM", "EACCES", "EBUSY"].includes(error?.code)) return notWritten();',
  },
  workspace_mutex_staging: {
    path: "../../operations/claude-workspace.mjs",
    target: 'const temporary = join(preparing, `${pendingName}.tmp`)',
    replacement: 'const temporary = join(lock, `${pendingName}.tmp`)',
  },
  pid_staging: {
    path: "../../operations/claude-skill.mjs",
    target: 'const temporary = `${target}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;',
    replacement: 'const temporary = `${target}.${process.pid}.tmp`;',
  },
};
const selected = process.env.BRAIN_RENAME_WRITER_MUTANT;
if (!Object.hasOwn(mutations, selected)) throw new Error("Unknown writer mutation");
const mutation = mutations[selected];
const targetUrl = new URL(mutation.path, import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (url !== targetUrl) return loaded;
  const source = String(loaded.source).replaceAll("\r\n", "\n");
  if (source.split(mutation.target).length !== 2) throw new Error("Writer mutation target missing or ambiguous");
  process.stderr.write(`MUTATION_APPLIED ${selected}\n`);
  return { ...loaded, source: source.replace(mutation.target, mutation.replacement) };
} });

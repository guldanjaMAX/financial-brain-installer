import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { readStableRegularFile } from "./package-bundle-verifier.mjs";
import { replaceFileWithRetrySync } from "./rename-retry.mjs";

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const ENTRY = "node_modules/brain-installer/brain.mjs";
const readLauncher = path => readStableRegularFile(path, {
  maxBytes: 16 * 1024, failureCode: "WINDOWS_BRAIN_LAUNCHER_UNSAFE",
});

function exists(path) {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function requireCanonical(path) {
  if (realpathSync(path).toLowerCase() !== path.toLowerCase()) {
    throw new Error("Windows Brain launcher path redirects outside its expected location");
  }
}

// Change only the Node entrypoint argument in the npm launchers. Their
// argument forwarding, exit status and shell-specific Node lookup stay intact.
export function activateWindowsCurrentLaunchers({ platform, localAppData, scriptPath, version }) {
  if (platform !== "win32" || !localAppData || !isAbsolute(localAppData)) return;
  const root = realpathSync(localAppData);
  const prefix = join(root, "FinancialBrain");
  const candidate = dirname(dirname(dirname(scriptPath)));
  const candidateName = basename(candidate);
  if (dirname(candidate).toLowerCase() !== root.toLowerCase() ||
      !/^FinancialBrain-v\d+\.\d+\.\d+$/iu.test(candidateName) ||
      scriptPath.toLowerCase() !== join(candidate, ENTRY).toLowerCase() ||
      !exists(join(prefix, "brain.cmd"))) return;
  if (!VERSION.test(version) || candidateName.toLowerCase() !== `financialbrain-v${version}`) {
    throw new Error("Windows Brain launcher version does not match the running release");
  }
  requireCanonical(prefix);
  requireCanonical(scriptPath);
  const packagePath = join(dirname(scriptPath), "package.json");
  requireCanonical(packagePath);
  const pkg = JSON.parse(readStableRegularFile(packagePath, { maxBytes: 64 * 1024 }));
  if (pkg.name !== "brain-installer" || pkg.version !== version || pkg.bin?.brain !== "./brain.mjs") {
    throw new Error("Windows Brain launcher package identity does not match the running release");
  }

  const replacements = [];
  for (const name of ["brain", "brain.ps1", "brain.cmd"]) {
    const path = join(prefix, name);
    if (name !== "brain.cmd" && !exists(path)) continue;
    const before = readLauncher(path);
    const batch = name === "brain.cmd";
    const entryPattern = batch
      ? /((?:%dp0%|%~dp0)\\?)(?:\.\.\\FinancialBrain-v\d+\.\d+\.\d+\\)?node_modules\\brain-installer\\brain\.mjs(?=")/gu
      : /\/(?:\.\.\/FinancialBrain-v\d+\.\d+\.\d+\/)?node_modules\/brain-installer\/brain\.mjs(?=")/gu;
    const text = before.toString("utf8");
    if (!Buffer.from(text).equals(before) || !text.match(entryPattern)) {
      throw new Error("Windows Brain launcher is not a recognized npm entrypoint");
    }
    const after = Buffer.from(text.replace(entryPattern, (match, base) => batch
      ? `${base}..\\${candidateName}\\${ENTRY.replaceAll("/", "\\")}`
      : `/../${candidateName}/${ENTRY}`));
    replacements.push({ path, before, after });
  }
  // Every launcher remains callable across an interrupted update. A retry can
  // finish a partial switch because both packages and both target forms exist.
  for (const { path, before, after } of replacements) {
    if (before.equals(after)) continue;
    const stage = `${path}.${randomUUID()}.tmp`;
    writeFileSync(stage, after, { flag: "wx", mode: 0o700 });
    try {
      replaceFileWithRetrySync(stage, path, { platform, revalidate() {
        requireCanonical(prefix);
        if (!readLauncher(path).equals(before)) throw new Error("Windows Brain launcher changed during update");
      } });
    } finally {
      if (exists(stage)) unlinkSync(stage);
    }
  }
  for (const { path, after } of replacements) {
    if (!readLauncher(path).equals(after)) throw new Error("Windows Brain launcher readback failed");
  }
}

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveNpmCliPath } from "./npm-cli-runtime.mjs";
import { PRIVATE_UPDATE_BINDING_ENV, assertPrivateUpdateBinding, refusePrivateOffer,
  verifyPrivatePackage } from "./private-update-offer.mjs";
import { inspectNpmArchiveBytes, readStableRegularFile } from "./package-bundle-verifier.mjs";

const PRODUCT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function installPrivateUpdatePackage({ bytes, offer, manifestPath, binding }, {
  runtimeRoot = PRODUCT_ROOT, temporaryRoot = tmpdir(), environment = process.env,
  spawn = spawnSync, npmCli,
} = {}) {
  verifyPrivatePackage(bytes, offer);
  let inspected;
  try {
    inspected = inspectNpmArchiveBytes(bytes);
    if (inspected.packageJson?.name !== "brain-installer" || inspected.packageJson.version !== offer.to_version) {
      refusePrivateOffer("PRIVATE_OFFER_PACKAGE");
    }
  } catch { refusePrivateOffer("PRIVATE_OFFER_PACKAGE"); }
  let prefix;
  try {
    runtimeRoot = realpathSync(runtimeRoot);
    if (basename(runtimeRoot) !== "brain-installer" || basename(dirname(runtimeRoot)) !== "node_modules" ||
        JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8")).name !== "brain-installer") {
      refusePrivateOffer("PRIVATE_OFFER_INSTALL");
    }
    prefix = dirname(dirname(runtimeRoot));
  } catch { refusePrivateOffer("PRIVATE_OFFER_INSTALL"); }
  // Keep the verified archive for a safe retry; npm reads this copy, not the download path.
  let staging;
  try {
    staging = mkdtempSync(join(temporaryRoot, "brain-private-update-"));
    mkdirSync(join(staging, "cache"), { mode: 0o700 });
    writeFileSync(join(staging, "candidate.tgz"), bytes, { flag: "wx", mode: 0o600 });
  } catch { refusePrivateOffer("PRIVATE_OFFER_INSTALL"); }
  const env = {};
  for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TMPDIR", "TMP", "TEMP",
    "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TERM", "NO_COLOR", "BRAIN_NO_WRANGLER_LOGIN"]) {
    if (typeof environment[key] === "string") env[key] = environment[key];
  }
  env.HOME ??= homedir();
  let result;
  try {
    const cli = npmCli ?? resolveNpmCliPath({ environment: env });
    result = spawn(process.execPath, [cli, "install", "--prefix", prefix, "--offline", "--ignore-scripts",
      "--omit=dev", "--no-audit", "--no-fund", "--cache", join(staging, "cache"), join(staging, "candidate.tgz")], {
      env, shell: false, stdio: "inherit",
    });
    if (result.error || result.status !== 0 ||
        JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8")).version !== offer.to_version) {
      refusePrivateOffer("PRIVATE_OFFER_INSTALL");
    }
    // An npm exit and version string alone cannot prove which code will run.
    for (const row of inspected.rows) {
      const path = join(runtimeRoot, ...row.path.split("/"));
      let installed;
      if (row.bytes === 0) {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 0 ||
            !realpathSync(path).startsWith(runtimeRoot + sep)) refusePrivateOffer("PRIVATE_OFFER_INSTALL");
        installed = Buffer.alloc(0);
      } else {
        installed = readStableRegularFile(path, { root: runtimeRoot });
      }
      if (installed.length !== row.bytes || createHash("sha256").update(installed).digest("hex") !== row.sha256) {
        refusePrivateOffer("PRIVATE_OFFER_INSTALL");
      }
    }
  } catch { refusePrivateOffer("PRIVATE_OFFER_INSTALL"); }
  // npm may have run while another process replaced the installed manifest.
  try {
    const raw = readStableRegularFile(manifestPath);
    assertPrivateUpdateBinding({ manifest: JSON.parse(raw.toString("utf8")),
      fingerprint: createHash("sha256").update(raw).digest("hex") }, binding);
  } catch { refusePrivateOffer("PRIVATE_OFFER_BINDING"); }
  // The new package owns all ordinary update locks, custody, migrations, and final proof.
  try {
    result = spawn(process.execPath, [join(runtimeRoot, "brain.mjs"), "update", manifestPath], {
      env: { ...env, [PRIVATE_UPDATE_BINDING_ENV]: JSON.stringify(binding) }, shell: false, stdio: "inherit",
    });
  } catch { refusePrivateOffer("PRIVATE_OFFER_UPDATE"); }
  if (result.error || result.status !== 0) refusePrivateOffer("PRIVATE_OFFER_UPDATE");
  return { status: "updated" };
}

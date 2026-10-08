import { createHash } from "node:crypto";
import { get } from "node:https";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertExactPaths, assertHostedRunner } from "./contract.mjs";

// Independent witness pins, deliberately kept separate from installed script
// constants. Re-pin all four values only after the next kit is sealed.
export const KIT = Object.freeze({
  version: "0.4.9",
  url: "https://financialbrain.ai/kit/brain-installer-0.4.9-0555ad1972d7f8d6.tgz",
  size: 6668013,
  sha256: "0555ad1972d7f8d6c1ded78a9fc4265f873cc4f4ce8c11fd04198cc5599409b2",
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyKit(bytes, pin = KIT) {
  if (bytes.length !== pin.size) throw new Error("pinned kit length mismatch");
  if (hash(bytes) !== pin.sha256) throw new Error("pinned kit SHA-256 mismatch");
}

export function verifyPreparationPins(source, platform, pin = KIT) {
  const entries = platform === "macos"
    ? [["BRAIN_VERSION", pin.version], ["BRAIN_KIT_URL", pin.url], ["BRAIN_KIT_SIZE", String(pin.size)], ["BRAIN_KIT_SHA256", pin.sha256]]
    : [["$BrainVersion", pin.version], ["$BrainKitUrl", pin.url], ["$BrainKitSize", pin.size], ["$BrainKitSha256", pin.sha256]];
  for (const [key, value] of entries) {
    const expected = platform === "macos" ? `${key}="${value}"` : `${key} = ${typeof value === "number" ? value : `"${value}"`}`;
    if (!source.replaceAll("\r\n", "\n").split("\n").includes(expected)) throw new Error("installed preparation pins differ from witness");
  }
}

function inventory(root, prefix = "") {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("package root is not a plain directory");
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    const key = prefix ? `${prefix}/${name}` : name;
    return lstatSync(path).isDirectory() ? [`${key}/`, ...inventory(path, key)] : [key];
  });
}

export function verifyPackageTree(expected, installed, version = KIT.version) {
  const paths = inventory(expected);
  // npm can generate dependency command shims absent from the archive. Bound
  // those names to the authenticated dependency bin maps. They are not kit
  // source bytes and are never invoked by this proof; all other extras refuse.
  const generated = new Set();
  for (const path of paths.filter((path) => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(path))) {
    const pkg = JSON.parse(readFileSync(join(expected, path), "utf8"));
    const dependencyRoot = path.slice(0, -"package.json".length);
    const moduleRoot = path.slice(0, path.lastIndexOf("node_modules/") + "node_modules/".length);
    const bins = typeof pkg.bin === "string" ? { [pkg.name.split("/").at(-1)]: pkg.bin } : (pkg.bin || {});
    for (const [name, target] of Object.entries(bins)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name) || typeof target !== "string" ||
          !paths.includes(relative(expected, resolve(expected, dependencyRoot, target)).split(sep).join("/"))) throw new Error("invalid dependency bin map");
      generated.add(`${moduleRoot}.bin/`);
      for (const suffix of ["", ".cmd", ".ps1"]) generated.add(`${moduleRoot}.bin/${name}${suffix}`);
    }
  }
  const actual = inventory(installed);
  for (const path of actual.filter((path) => generated.has(path) && !paths.includes(path))) {
    const item = join(installed, path);
    if (lstatSync(item).isSymbolicLink()) {
      const target = relative(realpathSync(installed), realpathSync(item));
      if (isAbsolute(target) || target === ".." || target.startsWith(`..${sep}`)) throw new Error("generated command link escaped package");
    } else if (path.endsWith("/") ? !lstatSync(item).isDirectory() : !lstatSync(item).isFile()) throw new Error("invalid generated command shim");
  }
  assertExactPaths(actual.filter((path) => paths.includes(path) || !generated.has(path)), paths);
  let files = 0;
  for (const path of paths.filter((path) => !path.endsWith("/"))) {
    const before = join(expected, path);
    const after = join(installed, path);
    const kind = lstatSync(before);
    if (kind.isSymbolicLink()) {
      if (!lstatSync(after).isSymbolicLink() || readlinkSync(before) !== readlinkSync(after)) throw new Error("installed package link differs from kit");
      for (const [root, candidate] of [[expected, before], [installed, after]]) {
        const target = relative(realpathSync(root), realpathSync(candidate));
        if (isAbsolute(target) || target === ".." || target.startsWith(`..${sep}`)) throw new Error("package link escaped its root");
      }
    } else {
      if (!kind.isFile() || !lstatSync(after).isFile() || hash(readFileSync(before)) !== hash(readFileSync(after))) throw new Error("installed package bytes differ from kit");
      files++;
    }
  }
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (pkg.name !== "brain-installer" || pkg.version !== version || !["brain.mjs", "./brain.mjs"].includes(pkg.bin?.brain) ||
      !lstatSync(join(installed, "brain.mjs")).isFile()) throw new Error("unexpected installed CLI identity");
  return files;
}

// A separately authenticated witness download, not an input substitution for
// preparation. The installed script must perform its own production download.
async function downloadKit() {
  return new Promise((accept, reject) => {
    const request = get(KIT.url, { timeout: 300_000 }, (response) => {
      if (response.statusCode !== 200 || response.headers["content-length"] !== String(KIT.size)) {
        response.destroy(); reject(new Error("kit witness requires direct HTTP 200 and exact Content-Length")); return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > KIT.size) { response.destroy(new Error("kit witness size limit exceeded")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => accept(Buffer.concat(chunks)));
    });
    request.on("timeout", () => request.destroy(new Error("kit witness timed out")));
    request.on("error", reject);
  });
}

export async function runKitProof(host, emit) {
  const phase = async (name) => { emit(`BOOTSTRAP_DECISION_REACHED=${name}`); await host[name](); };
  await phase("assertClean");
  let failure;
  try {
    for (const name of ["verifyPins", "download", "verifyArchive", "prepare", "verifyProvenance", "verifyVersion"]) await phase(name);
  } catch (error) { failure = error; }
  try { await phase("cleanup"); } catch (error) { failure = failure ? new AggregateError([failure, error], "bootstrap and cleanup failed") : error; }
  if (failure) throw failure;
  emit(`PINNED_KIT_BOOTSTRAP_VERIFIED=1 version=${KIT.version}`);
}

// Build Node argv for the authenticated installed entry and network preload.
// Native realpath makes permissions and module loading agree on junctions,
// directory aliases and Windows short names. Only the ESM --import argument
// is a file URL; permission grants and the entry stay native filesystem paths.
// Missing paths throw before launch. No credentials, network or writes are used.
export function versionGuardArgs({ prefix, entrypoint, guard = resolve(import.meta.dirname, "version-guard.mjs") }, {
  realpath = realpathSync.native, windows = process.platform === "win32",
} = {}) {
  const directory = realpath(prefix);
  const entry = realpath(entrypoint);
  const preload = realpath(guard);
  return ["--permission", `--allow-fs-read=${directory}`, `--allow-fs-read=${preload}`,
    "--import", pathToFileURL(preload, { windows }).href, entry, "--version"];
}

export async function bootstrapInstalled({ platform, logs, environment, command, emit }) {
  assertHostedRunner(environment);
  const mac = platform === "macos";
  const home = mac ? environment.HOME : environment.USERPROFILE;
  const base = mac ? home : environment.LOCALAPPDATA;
  if (!home || !base) throw new Error("bootstrap user directories unavailable");
  const prefix = join(base, mac ? ".financial-brain" : "FinancialBrain");
  const installed = join(prefix, ...(mac ? ["lib", "node_modules"] : ["node_modules"]), "brain-installer");
  const prep = join(mac ? join(home, "Applications") : base, "Financial Brain Machine Prep", mac ? "prep-mac.sh" : "prep-windows.ps1");
  const scratch = join(logs, "kit-witness");
  const absent = (path) => {
    try { lstatSync(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    throw new Error("bootstrap destination already occupied");
  };
  let bytes;
  let clean = false;
  await runKitProof({
    assertClean() {
      absent(prefix); absent(`${prefix}.install.lock`); absent(join(home, ".brain"));
      if (readdirSync(base).some((name) => name.startsWith(`${mac ? ".financial-brain" : "FinancialBrain"}.stage.`))) throw new Error("preexisting bootstrap stage");
      clean = true;
      mkdirSync(scratch);
    },
    verifyPins() { verifyPreparationPins(readFileSync(prep, "utf8"), platform); },
    async download() { bytes = await downloadKit(); },
    verifyArchive() {
      verifyKit(bytes);
      emit(`KIT_BYTES_VERIFIED=${bytes.length} sha256=${hash(bytes)}`);
      const archive = join(scratch, "kit.tgz");
      writeFileSync(archive, bytes);
      command("kit-extract", "tar", ["-xzf", archive, "-C", scratch]);
      assertExactPaths(readdirSync(scratch), ["kit.tgz", "package"]);
    },
    prepare() {
      const executable = mac ? "/bin/bash" : join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const args = mac ? [prep, "--prepare-cli"] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", prep, "--prepare-cli"];
      const output = command("installed-cli-preparation", executable, args);
      for (const marker of ["CLI_PREPARATION_SESSION_DECISION_REACHED=1", "CLI_PREPARATION_PREREQUISITE_DECISION_REACHED=1", "DOWNLOAD_STARTED=1", "KIT_SIZE_DECISION_REACHED=1", "CHECKSUM_DECISION_REACHED=1", `BRAIN_INSTALL_VERIFIED=1 version=${KIT.version}`]) {
        if (!output.includes(marker)) throw new Error("installed preparation receipt incomplete");
      }
    },
    verifyProvenance() {
      const count = verifyPackageTree(join(scratch, "package"), installed);
      if (mac && realpathSync(join(prefix, "bin", "brain")) !== realpathSync(join(installed, "brain.mjs"))) throw new Error("installed CLI launcher escaped kit");
      if (!mac && !lstatSync(join(prefix, "brain.cmd")).isFile()) throw new Error("installed CLI launcher missing");
      emit(`INSTALLED_KIT_FILES_VERIFIED=${count}`);
      emit(`INSTALLED_CLI_SHA256=${hash(readFileSync(join(installed, "brain.mjs")))}`);
    },
    verifyVersion() {
      // Invoke the kit's installed bin entry, never the checkout brain.mjs.
      // Permission mode denies subprocesses; the preload denies network APIs.
      const output = command("installed-cli-version", process.execPath,
        versionGuardArgs({ prefix, entrypoint: join(installed, "brain.mjs") }));
      if (output.trim() !== KIT.version) throw new Error("installed CLI version mismatch");
      emit(`INSTALLED_CLI_VERSION_VERIFIED=1 version=${KIT.version}`);
    },
    cleanup() {
      // This exact prefix was absent before this attempt, and this is a fresh
      // hosted VM. Refuse symlink replacement rather than following it.
      if (!clean) throw new Error("bootstrap cleanup lacks clean-target proof");
      if (existsSync(prefix)) {
        if (!lstatSync(prefix).isDirectory() || lstatSync(prefix).isSymbolicLink()) throw new Error("bootstrap cleanup refuses changed target type");
        rmSync(prefix, { recursive: true });
      }
      absent(prefix); absent(`${prefix}.install.lock`); absent(join(home, ".brain"));
      if (readdirSync(base).some((name) => name.startsWith(`${mac ? ".financial-brain" : "FinancialBrain"}.stage.`))) throw new Error("bootstrap staging residue remains");
      rmSync(scratch, { recursive: true });
      emit("BOOTSTRAP_CLEANUP_VERIFIED=1");
    },
  }, emit);
}

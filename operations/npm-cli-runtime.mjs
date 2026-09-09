import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, basename, dirname, relative, resolve, sep, posix, win32 } from "node:path";

const isPortableAbsolute = (path) => isAbsolute(path) || win32.isAbsolute(path);

/**
 * Resolve a proposed npm JavaScript entry only when it is the regular
 * npm-cli.js file inside a package that identifies itself as npm.
 */
export function verifiedNpmCliPath(candidate) {
  if (typeof candidate !== "string" || !candidate) return null;
  try {
    const cli = realpathSync(candidate);
    const info = lstatSync(cli);
    if (!info.isFile() || info.isSymbolicLink() || basename(cli) !== "npm-cli.js") return null;
    const pkg = JSON.parse(readFileSync(resolve(dirname(cli), "..", "package.json"), "utf8"));
    return pkg.name === "npm" && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(String(pkg.version || "")) ? cli : null;
  } catch {
    return null;
  }
}

function nodeRuntimeLayout(nodeExecutable, platform) {
  if (typeof nodeExecutable !== "string" || !isAbsolute(nodeExecutable)) {
    throw new Error("node_executable_must_be_absolute");
  }
  const nodeDirectories = [];
  for (const candidate of [nodeExecutable, (() => {
    try { return realpathSync(nodeExecutable); } catch { return null; }
  })()]) {
    if (!candidate) continue;
    const directory = dirname(candidate);
    if (!nodeDirectories.includes(directory)) nodeDirectories.push(directory);
  }
  const trustedRoots = [];
  for (const directory of nodeDirectories) {
    // Official Windows distributions keep npm under the directory containing
    // node.exe. POSIX distributions keep it below the install root whose bin/
    // directory contains node. Never widen a Windows root to its parent (for
    // example from C:\\Program Files\\nodejs to all of C:\\Program Files).
    const root = platform === "win32" ? directory : dirname(directory);
    if (!trustedRoots.includes(root)) trustedRoots.push(root);
  }
  const candidates = [];
  for (const directory of nodeDirectories) {
    const candidate = platform === "win32"
      ? resolve(directory, "node_modules", "npm", "bin", "npm-cli.js")
      : resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return { candidates, trustedRoots };
}

function isInsideRoot(path, root) {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

export function nodeRuntimeNpmCliPaths(
  nodeExecutable = process.execPath,
  platform = process.platform,
) {
  return Object.freeze([...nodeRuntimeLayout(nodeExecutable, platform).candidates]);
}

/**
 * Find npm's JavaScript entry without executing npm, npm.cmd, a shell, or a
 * PATH lookup. npm lifecycle scripts declare npm_execpath. Official Node
 * distributions place npm beside node on Windows and under ../lib on POSIX.
 */
export function resolveNpmCliPath({
  environment = process.env,
  nodeExecutable = process.execPath,
  platform = process.platform,
} = {}) {
  const layout = nodeRuntimeLayout(nodeExecutable, platform);
  // The Node distribution's own npm wins over every ambient locator.
  for (const candidate of layout.candidates) {
    const cli = verifiedNpmCliPath(candidate);
    if (cli) return cli;
  }

  // npm lifecycle scripts expose their own JavaScript entry. It is accepted
  // only when its real path remains inside this Node runtime's install tree.
  const fallback = verifiedNpmCliPath(environment?.npm_execpath);
  if (fallback && layout.trustedRoots.some((root) => isInsideRoot(fallback, root))) return fallback;
  throw new Error("npm_cli_unavailable_for_node_runtime");
}

/** Build a direct Node invocation whose arguments never pass through a shell. */
export function buildNpmCliInvocation(cli, args, { nodeExecutable = process.execPath } = {}) {
  if (typeof nodeExecutable !== "string" || !isAbsolute(nodeExecutable)) {
    throw new Error("node_executable_must_be_absolute");
  }
  const verified = verifiedNpmCliPath(cli);
  if (!verified) throw new Error("npm_cli_locator_refused");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("npm_arguments_refused");
  }
  return Object.freeze({
    command: nodeExecutable,
    args: Object.freeze([verified, ...args]),
    shell: false,
  });
}

const CONTRACT_CHILD_ENV = Object.freeze({
  PATH: Object.freeze(["PATH", "Path"]),
  HOME: Object.freeze(["HOME"]),
  USERPROFILE: Object.freeze(["USERPROFILE"]),
  USERNAME: Object.freeze(["USERNAME"]),
  USERDOMAIN: Object.freeze(["USERDOMAIN"]),
  HOMEDRIVE: Object.freeze(["HOMEDRIVE"]),
  HOMEPATH: Object.freeze(["HOMEPATH"]),
  SYSTEMROOT: Object.freeze(["SystemRoot", "SYSTEMROOT"]),
  WINDIR: Object.freeze(["WINDIR"]),
  COMSPEC: Object.freeze(["ComSpec", "COMSPEC"]),
  PATHEXT: Object.freeze(["PATHEXT"]),
  TEMP: Object.freeze(["TEMP"]),
  TMP: Object.freeze(["TMP"]),
  TMPDIR: Object.freeze(["TMPDIR"]),
  APPDATA: Object.freeze(["APPDATA"]),
  LOCALAPPDATA: Object.freeze(["LOCALAPPDATA"]),
  LANG: Object.freeze(["LANG"]),
  LANGUAGE: Object.freeze(["LANGUAGE"]),
  LC_ALL: Object.freeze(["LC_ALL"]),
  CI: Object.freeze(["CI"]),
});

export function publicContractChildEnvironment(source = process.env) {
  const clean = {};
  for (const [canonical, aliases] of Object.entries(CONTRACT_CHILD_ENV)) {
    const alias = aliases.find((name) => typeof source?.[name] === "string" && source[name]);
    if (alias) clean[canonical] = source[alias];
  }
  return Object.freeze(clean);
}

export function npmInstallEnvironment(source = process.env, platform = process.platform) {
  const clean = { ...publicContractChildEnvironment(source) };
  clean.npm_config_yes = "true";
  // This public-contract install needs no registry access. Do not let a user or
  // runner npmrc inject credentials or alter the reviewed local archive install.
  clean.NPM_CONFIG_USERCONFIG = platform === "win32" ? "NUL" : "/dev/null";
  return Object.freeze(clean);
}

export function publicInstallArguments(prefix, archive) {
  if (typeof prefix !== "string" || !isPortableAbsolute(prefix) ||
      typeof archive !== "string" || !isPortableAbsolute(archive)) {
    throw new Error("public_install_paths_must_be_absolute");
  }
  return Object.freeze([
    "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
    "--prefix", prefix, archive,
  ]);
}

export function installedBrainPath(prefix, platform = process.platform) {
  if (typeof prefix !== "string" || !isPortableAbsolute(prefix)) {
    throw new Error("public_install_prefix_must_be_absolute");
  }
  return platform === "win32" ? win32.join(prefix, "brain.cmd") : posix.join(prefix, "bin", "brain");
}

/**
 * A generated .cmd shim is itself a batch program, so Windows must enter it
 * through cmd.exe. Restrict the wrapper path and arguments before constructing
 * the one fixed command line; windowsVerbatimArguments prevents Node from
 * applying executable-style quoting to a string intended for cmd.exe.
 */
export function buildWindowsBatchInvocation(comspec, wrapper, args = []) {
  if (typeof comspec !== "string" || !isPortableAbsolute(comspec) ||
      win32.basename(comspec).toLowerCase() !== "cmd.exe" || /["\r\n]/.test(comspec)) {
    throw new Error("windows_command_processor_refused");
  }
  if (typeof wrapper !== "string" || !isPortableAbsolute(wrapper) ||
      win32.extname(wrapper).toLowerCase() !== ".cmd" || /["%\^!&|<>\r\n]/.test(wrapper)) {
    throw new Error("windows_wrapper_path_refused");
  }
  if (!Array.isArray(args) || args.some((arg) =>
    typeof arg !== "string" || !/^(?:--?)?[a-z0-9][a-z0-9-]*$/i.test(arg))) {
    throw new Error("windows_batch_arguments_refused");
  }
  const commandLine = [`"${wrapper}"`, ...args].join(" ");
  return Object.freeze({
    command: comspec,
    args: Object.freeze([`/d /s /c "${commandLine}"`]),
    shell: false,
    windowsVerbatimArguments: true,
  });
}

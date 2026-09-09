import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, basename, dirname, resolve, win32 } from "node:path";

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

/**
 * Find npm's JavaScript entry without executing npm, npm.cmd, a shell, or a
 * PATH lookup. npm lifecycle scripts declare npm_execpath. Official Node
 * distributions place npm beside node on Windows and under ../lib on POSIX.
 */
export function resolveNpmCliPath({ environment = process.env, nodeExecutable = process.execPath } = {}) {
  if (typeof nodeExecutable !== "string" || !isAbsolute(nodeExecutable)) {
    throw new Error("node_executable_must_be_absolute");
  }

  const nodeDirectories = new Set([dirname(nodeExecutable)]);
  try { nodeDirectories.add(dirname(realpathSync(nodeExecutable))); } catch {}
  const candidates = [environment?.npm_execpath];
  for (const directory of nodeDirectories) {
    candidates.push(
      resolve(directory, "node_modules", "npm", "bin", "npm-cli.js"),
      resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    );
  }

  for (const candidate of new Set(candidates.filter(Boolean))) {
    const cli = verifiedNpmCliPath(candidate);
    if (cli) return cli;
  }
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
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || !/^--?[a-z0-9-]+$/i.test(arg))) {
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

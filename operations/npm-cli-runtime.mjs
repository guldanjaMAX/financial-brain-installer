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
    // Inspect the path the caller supplied before following it. A symlink to a
    // real npm-cli.js is still an attacker-controlled locator and must not be
    // laundered into a regular file by realpathSync().
    const supplied = lstatSync(candidate);
    if (!supplied.isFile() || supplied.isSymbolicLink()) return null;
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
  return { candidates, trustedRoots, nodeDirectories };
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
    if (cli && layout.trustedRoots.some((root) => isInsideRoot(cli, root))) return cli;
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

function assertPublicInstallPaths(prefix, archive) {
  if (typeof prefix !== "string" || !isPortableAbsolute(prefix) ||
      typeof archive !== "string" || !isPortableAbsolute(archive)) {
    throw new Error("public_install_paths_must_be_absolute");
  }
}

const PUBLIC_INSTALL_ARGS = Object.freeze([
  "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix",
]);

const FIELD_GUIDE_INSTALL_CONTRACTS = Object.freeze({
  macos: Object.freeze({
    executable: "npm",
    prefix: "$HOME/.npm-global",
  }),
  windows: Object.freeze({
    executable: "npm.cmd",
    prefix: "$env:LOCALAPPDATA\\FinancialBrain",
  }),
});

function tokenizeFieldGuideCommand(line) {
  const tokens = [];
  let token = null;
  let quoted = false;
  for (const character of line) {
    if (character === '"') {
      quoted = !quoted;
      if (token === null) token = "";
      continue;
    }
    if (/\s/.test(character) && !quoted) {
      if (token !== null) tokens.push(token);
      token = null;
      continue;
    }
    if (token === null) token = "";
    token += character;
  }
  if (quoted) throw new Error("public_install_command_has_unclosed_quote");
  if (token !== null) tokens.push(token);
  return tokens;
}

/**
 * Parse the one npm install command a downloaded platform field guide gives to
 * an owner. The runner never evaluates the guide as shell text. It accepts the
 * exact reviewed executable, flags, prefix expression, and archive reference,
 * so a public edit cannot silently leave CI testing a different command.
 */
export function parsePublicInstallCommand(fieldGuide, { guide, archiveName } = {}) {
  if (typeof fieldGuide !== "string" || !fieldGuide) {
    throw new Error("public_install_field_guide_missing");
  }
  const contract = FIELD_GUIDE_INSTALL_CONTRACTS[guide];
  if (!contract) throw new Error("public_install_field_guide_platform_refused");
  if (typeof archiveName !== "string" ||
      !/^brain-installer-\d+\.\d+\.\d+\.tgz$/.test(archiveName)) {
    throw new Error("public_install_archive_name_refused");
  }

  const lines = fieldGuide.split(/\r?\n/).map((line) => line.trim());
  const installLines = lines.filter((line) => /^(?:npm|npm\.cmd)\s+install(?:\s|$)/.test(line));
  if (installLines.length !== 1) {
    throw new Error(`public_install_command_count_${installLines.length}`);
  }

  const tokens = tokenizeFieldGuideCommand(installLines[0]);
  const archiveReference = guide === "windows" ? "$Archive" : `./${archiveName}`;
  const expected = [contract.executable, ...PUBLIC_INSTALL_ARGS, contract.prefix, archiveReference];
  if (tokens.length !== expected.length || tokens.some((token, index) => token !== expected[index])) {
    throw new Error("public_install_command_contract_drift");
  }

  if (guide === "windows") {
    const archiveAssignments = lines.filter((line) => /^\$Archive\s*=/.test(line));
    if (archiveAssignments.length !== 1) {
      throw new Error(`public_install_archive_assignment_count_${archiveAssignments.length}`);
    }
    const assignment = archiveAssignments[0].match(
      /^\$Archive\s*=\s*Join-Path\s+\(Get-Location\)\.Path\s+"([^"]+)"$/,
    );
    if (!assignment || assignment[1] !== archiveName) {
      throw new Error("public_install_archive_assignment_drift");
    }
  }

  return Object.freeze({
    executable: tokens[0],
    args: Object.freeze(tokens.slice(1)),
  });
}

/**
 * Rebind only the guide's owner prefix and verified archive to throwaway local
 * paths. Every npm mode flag comes from the parsed and validated public guide.
 */
export function publicInstallArgumentsFromGuide(
  fieldGuide,
  { guide, archiveName, prefix, archive } = {},
) {
  assertPublicInstallPaths(prefix, archive);
  const parsed = parsePublicInstallCommand(fieldGuide, { guide, archiveName });
  const prefixFlag = parsed.args.indexOf("--prefix");
  if (prefixFlag < 0 || prefixFlag !== parsed.args.lastIndexOf("--prefix")) {
    throw new Error("public_install_prefix_contract_drift");
  }
  return Object.freeze([
    ...parsed.args.slice(0, prefixFlag + 1),
    prefix,
    archive,
  ]);
}

function verifiedRegularCommandPath(candidate, expectedBasename) {
  if (typeof candidate !== "string" || !isPortableAbsolute(candidate)) return null;
  try {
    const supplied = lstatSync(candidate);
    if (!supplied.isFile() || supplied.isSymbolicLink()) return null;
    const command = realpathSync(candidate);
    const info = lstatSync(command);
    if (!info.isFile() || info.isSymbolicLink() ||
        basename(command).toLowerCase() !== expectedBasename.toLowerCase()) return null;
    return command;
  } catch {
    return null;
  }
}

/** Resolve npm.cmd beside the selected Windows Node runtime, never from PATH. */
export function resolveWindowsNpmCommandPath({
  nodeExecutable = process.execPath,
  platform = process.platform,
} = {}) {
  if (platform !== "win32") throw new Error("windows_npm_command_requires_windows");
  const layout = nodeRuntimeLayout(nodeExecutable, platform);
  for (const directory of layout.nodeDirectories) {
    const command = verifiedRegularCommandPath(resolve(directory, "npm.cmd"), "npm.cmd");
    if (command && layout.trustedRoots.some((root) => isInsideRoot(command, root))) return command;
  }
  throw new Error("npm_command_unavailable_for_node_runtime");
}

/** Resolve the built-in Windows PowerShell host without a PATH lookup. */
export function resolveWindowsPowerShellPath({
  environment = process.env,
  platform = process.platform,
} = {}) {
  if (platform !== "win32") throw new Error("windows_powershell_requires_windows");
  const systemRoot = environment?.SystemRoot || environment?.SYSTEMROOT;
  if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot)) {
    throw new Error("windows_system_root_unavailable");
  }
  const command = verifiedRegularCommandPath(
    win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
  );
  let trustedRoot = null;
  try { trustedRoot = realpathSync(systemRoot); } catch { /* handled below */ }
  if (!command || !trustedRoot || !isInsideRoot(command, trustedRoot)) {
    throw new Error("windows_powershell_unavailable");
  }
  return command;
}

function assertWindowsNpmInstallArguments(args) {
  if (!Array.isArray(args) || args.length !== PUBLIC_INSTALL_ARGS.length + 2 ||
      PUBLIC_INSTALL_ARGS.some((arg, index) => args[index] !== arg)) {
    throw new Error("windows_npm_install_arguments_refused");
  }
  const [prefix, archive] = args.slice(-2);
  assertPublicInstallPaths(prefix, archive);
  if ([prefix, archive].some((path) => /["%\^!&|<>()\r\n]/.test(path))) {
    throw new Error("windows_npm_install_path_refused");
  }
}

/**
 * Build the fixed PowerShell bridge used to exercise npm.cmd exactly as the
 * Windows field guide does. Dynamic values live in a private JSON file, not in
 * PowerShell source, and the bridge verifies PATH resolves npm.cmd to the
 * selected Node runtime before invoking it with an argument-array splat.
 */
export function buildWindowsNpmPowerShellInvocation({
  executable,
  args,
  expectedCommand,
  contractPath,
  helperPath,
  powershellPath,
} = {}) {
  if (executable !== "npm.cmd") throw new Error("windows_npm_executable_refused");
  assertWindowsNpmInstallArguments(args);
  const npmCommand = verifiedRegularCommandPath(expectedCommand, "npm.cmd");
  const helper = verifiedRegularCommandPath(helperPath, "invoke-public-npm-install.ps1");
  const powershell = verifiedRegularCommandPath(powershellPath, "powershell.exe");
  if (!npmCommand) throw new Error("windows_npm_command_refused");
  if (!helper) throw new Error("windows_npm_helper_refused");
  if (!powershell) throw new Error("windows_powershell_refused");
  if (typeof contractPath !== "string" || !isPortableAbsolute(contractPath) || /["\r\n]/.test(contractPath)) {
    throw new Error("windows_npm_contract_path_refused");
  }
  const contract = JSON.stringify({
    schema: 1,
    executable,
    expected_command: npmCommand,
    arguments: args,
  });
  return Object.freeze({
    command: powershell,
    args: Object.freeze([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper, contractPath,
    ]),
    shell: false,
    contract,
  });
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

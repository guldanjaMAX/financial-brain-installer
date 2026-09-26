/**
 * Render copyable local commands without ever using display text for execution.
 *
 * Execution stays structured as command plus argv. This module is only for the
 * owner-visible copy of that structure. POSIX and PowerShell both treat a
 * single-quoted value as literal; their embedded-quote escapes differ.
 */

function displayValue(value, label = "command argument") {
  const text = String(value ?? "");
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} is not safe to display as a copyable command`);
  }
  return text;
}

export function quotePosixArgument(value) {
  const text = displayValue(value);
  return `'${text.replaceAll("'", `'\"'\"'`)}'`;
}

export function quotePowerShellArgument(value) {
  const text = displayValue(value);
  return `'${text.replaceAll("'", "''")}'`;
}

export function renderCopyableCommand(command, args = [], {
  platformName = process.platform,
} = {}) {
  const values = [displayValue(command, "command"), ...args.map((value) => displayValue(value))];
  if (platformName === "win32") {
    return `& ${values.map(quotePowerShellArgument).join(" ")}`;
  }
  return values.map(quotePosixArgument).join(" ");
}

/**
 * Prefix a copyable command line with environment assignments for one shell.
 *
 * POSIX shells scope `NAME='value' command` to that one command. PowerShell,
 * which every Windows copy in this product targets, rejects that syntax, so
 * there the assignment is a separate `$env:` statement that lasts for the
 * rest of that terminal window only.
 */
export function renderCommandWithEnvironment(assignments, commandLine, {
  platformName = process.platform,
} = {}) {
  const line = displayValue(commandLine, "command line");
  const parts = Object.entries(assignments ?? {}).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error("environment variable name is not safe to display as a copyable command");
    }
    return platformName === "win32"
      ? `$env:${name}=${quotePowerShellArgument(value)}; `
      : `${name}=${quotePosixArgument(value)} `;
  });
  return `${parts.join("")}${line}`;
}

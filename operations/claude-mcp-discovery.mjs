import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Keep PATH precedence, with only the native Mac install as a fallback. */
export function discoverClaudeMcpCommand({
  environment,
  platform = process.platform,
  probe,
  stat = statSync,
  getuid = process.getuid,
}) {
  if (probe("claude").ok) return "claude";
  if (platform !== "darwin" || !isAbsolute(environment?.HOME || "") ||
      typeof getuid !== "function") return null;

  const command = join(environment.HOME, ".local", "bin", "claude");
  try {
    // The native install can be a link to its versioned executable. Check the
    // executable's type, owner and owner-execute bit before running its probe.
    const candidate = stat(command);
    if (!candidate.isFile() || candidate.uid !== getuid() ||
        (candidate.mode & 0o100) === 0) return null;
    return probe(command).ok ? command : null;
  } catch {
    return null;
  }
}

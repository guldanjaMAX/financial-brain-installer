import { mkdirSync } from "node:fs";
import { dirname, join, delimiter } from "node:path";

// HOME alone cannot isolate native credential stores. Pair this allowlist with
// cli-side-effect-tripwire.mjs and inject every external diagnostic dependency.
export function cliTestEnvironment(userRoot, overrides = {}, source = process.env) {
  const environment = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (source[key]) environment[key] = source[key];
  }
  const temporary = join(userRoot, "tmp");
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  return {
    ...environment,
    PATH: [dirname(process.execPath), ...(process.platform === "win32"
      ? [join(environment.SystemRoot || "C:\\Windows", "System32")]
      : ["/usr/bin", "/bin"])].join(delimiter),
    ...overrides,
    HOME: userRoot,
    USERPROFILE: userRoot,
    APPDATA: join(userRoot, "AppData", "Roaming"),
    LOCALAPPDATA: join(userRoot, "AppData", "Local"),
    XDG_CONFIG_HOME: join(userRoot, ".config"),
    XDG_CACHE_HOME: join(userRoot, ".cache"),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    BRAIN_TEST_USER_ROOT: userRoot,
    BRAIN_NO_WRANGLER_LOGIN: "1",
    // Lifecycle locks are machine-wide by default, independently of HOME.
    BRAIN_LIFECYCLE_LOCK_ROOT: join(userRoot, "machine-locks"),
  };
}

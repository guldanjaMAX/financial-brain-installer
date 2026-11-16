import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { readStableRegularFile } from "./package-bundle-verifier.mjs";

/** Hash the whole prior runtime, including old-only modules, before replacement. */
export function privateRuntimeInventory(root) {
  const rows = [];
  function walk(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), relative = prefix + name, info = lstatSync(path);
      if (info.isSymbolicLink()) {
        if (!realpathSync(path).startsWith(root + sep)) throw new Error("runtime link escapes its package");
        rows.push({ path: relative, link: readlinkSync(path) });
      } else if (info.isDirectory()) {
        rows.push({ path: relative, directory: true });
        walk(path, relative + "/");
      } else if (info.isFile() && info.nlink === 1) {
        const bytes = info.size === 0 ? Buffer.alloc(0) : readStableRegularFile(path, { root });
        rows.push({ path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      } else throw new Error("runtime contains an unsafe entry");
    }
  }
  walk(root);
  return JSON.stringify(rows);
}


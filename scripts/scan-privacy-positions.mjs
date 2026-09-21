import { lstatSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IDENTITY_INDEX,
  buildIdentityIndex,
  locateIdentityLines,
  locateIdentityPositions,
  scanIdentityText,
} from "./privacy-identity.mjs";

function optionsFrom(argv) {
  const options = { file: null, rulesJson: null, hashPrefixLength: 8 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--file") options.file = argv[++index] || null;
    // Synthetic-test seam only; this diagnostic is never a release gate.
    else if (arg === "--rules-json") options.rulesJson = argv[++index] || null;
    else if (arg === "--hash-prefix") options.hashPrefixLength = Number(argv[++index]);
    else if (arg === "--format" && argv[++index] === "position") continue;
    else throw new Error("invalid position-scan option");
  }
  if (!options.file) throw new Error("a local file is required");
  if (!Number.isInteger(options.hashPrefixLength) ||
      options.hashPrefixLength < 4 || options.hashPrefixLength > 16) {
    throw new Error("hash prefix length must be an integer from 4 through 16");
  }
  return options;
}

/** Scan one explicitly selected local file; the history report stays unchanged.
 *  Basename-only output avoids echoing private parent directories, so callers
 *  must distinguish same-named files by the input file they selected.
 */
export function main(argv = process.argv.slice(2), write = console.log, writeError = console.error) {
  try {
    const options = optionsFrom(argv);
    const index = options.rulesJson
      ? buildIdentityIndex(JSON.parse(readFileSync(resolve(options.rulesJson), "utf8")))
      : IDENTITY_INDEX;
    const path = resolve(options.file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    const content = readFileSync(path, "utf8");
    const findings = scanIdentityText(content, index);
    const located = locateIdentityLines(content, index, findings);
    if (findings.some((finding) =>
      !(located.get(`${finding.kind}:${finding.label}`) || []).length)) {
      throw new Error("a match spans lines and has no single position");
    }
    const positions = locateIdentityPositions(content, index, findings, {
      hashPrefixLength: options.hashPrefixLength,
    });
    const fileName = basename(path);
    const safeName = scanIdentityText(fileName, index).length ? "[redacted-file]" : fileName;
    for (const position of positions) {
      write(`${safeName}:${position.line}:${position.column} ${position.hashPrefix}`);
    }
    return 0;
  } catch {
    // Errors must not echo an input path, rule label, vocabulary value, or hash.
    writeError("position scan could not safely locate the selected file's findings");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

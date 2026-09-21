import { scan as scanCredentialShapes } from "../../worker/src/lib/secret-scan.js";

const READBACK_LABELS = new Set(["env_assignment", "private_key_header", "bearer_literal"]);
const LONG_RUN = /[A-Za-z0-9._-]{24,}/gu;
const SCANNER_PREVIEW = /^(?:(.{4})\.\.\.|\*+)\[len=(\d+)\]$/u;

// The shared scanner deliberately exposes only masked previews, not values.
function scannerMask(preview) {
  const match = SCANNER_PREVIEW.exec(preview);
  if (!match || !match[1]) {
    throw new Error("The shared credential scanner did not provide a usable masked preview");
  }
  return `${match[1]}:${match[2]}`;
}

function runMask(value) {
  return `${value.slice(0, 4)}:${value.length}`;
}

// The run alphabet excludes path separators. Inspect the whole surrounding
// value so a long directory or filename segment is not mistaken for a token.
function pathShapedContext(line, start, end) {
  const boundary = /[\s"'`=,{}\[\]()]/u;
  let left = start;
  let right = end;
  while (left > 0 && !boundary.test(line[left - 1])) left--;
  while (right < line.length && !boundary.test(line[right])) right++;
  const context = line.slice(left, right);
  if (/^[A-Za-z]:/u.test(context) || /^[\\/]/u.test(context) || /[\\/]/u.test(context)) {
    return true;
  }
  // A quoted path may contain spaces. The immediate word around a later long
  // filename segment is then not enough to see its earlier drive and slashes.
  for (let open = start - 1; open >= 0; open--) {
    const quote = line[open];
    if (quote !== '"' && quote !== "'") continue;
    const close = line.indexOf(quote, end);
    if (close < 0) break;
    const quoted = line.slice(open + 1, close);
    return /^[A-Za-z]:/u.test(quoted) || /^[\\/]/u.test(quoted) || /[\\/]/u.test(quoted);
  }
  return false;
}

/** Return only masked, line-numbered secret-value findings from mcp-config output. */
export function scanReadbackOutput(text) {
  if (typeof text !== "string" || text.length === 0) return [];

  const findings = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const scanned = scanCredentialShapes(line).findings;
    const recognized = new Set(scanned.map((finding) => {
      const match = SCANNER_PREVIEW.exec(finding.preview);
      return match?.[1] ? `${match[1]}:${match[2]}` : null;
    }));

    for (const finding of scanned) {
      if (!READBACK_LABELS.has(finding.label)) continue;
      findings.push({ line: index + 1, kind: finding.label, masked: scannerMask(finding.preview) });
    }

    LONG_RUN.lastIndex = 0;
    let match;
    while ((match = LONG_RUN.exec(line)) !== null) {
      const masked = runMask(match[0]);
      // Other shared-scanner labels are intentionally out of scope, including
      // when their value also meets this generic length rule.
      if (recognized.has(masked) || pathShapedContext(line, match.index, LONG_RUN.lastIndex)) continue;
      findings.push({ line: index + 1, kind: "long_token", masked });
    }
  }
  return findings;
}

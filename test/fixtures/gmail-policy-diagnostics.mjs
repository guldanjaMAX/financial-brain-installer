// Both children can exit 1 for review or an earlier filesystem failure. Keep
// their stopping stages visible without echoing private stdout or state JSON.
const filesystemCode = /\b(EPERM|EACCES|EBUSY|ENOENT|ENOTDIR|EISDIR|EIO|EMFILE|ENFILE|ENOSPC|EROFS)\b/;
const filesystemOperation = /\b(EPERM|EACCES|EBUSY|ENOENT|ENOTDIR|EISDIR|EIO|EMFILE|ENFILE|ENOSPC|EROFS):[^\r\n,]{0,120},\s*(open|read|write|rename|chmod|unlink|rmdir|mkdir|stat|lstat)\b/;
const observed = value => value ? "observed" : "not_observed";

function summarize(stage, result) {
  const output = typeof result?.output === "string" ? result.output : "";
  const exit = Number.isInteger(result?.code) && result.code >= 0 && result.code <= 255
    ? result.code : "unknown";
  const code = filesystemCode.exec(output);
  const operation = filesystemOperation.exec(output);
  const filesystem = operation ? `${operation[1]}/${operation[2]}`
    : code ? `${code[1]}/unknown` : "not_observed";
  return `${stage}: exit=${exit}; review=${observed(/stored document\(s\) would be removed/.test(output))}; ` +
    `approval=${observed(/--approve-removals [0-9a-f]{64}\b/.test(output))}; filesystem=${filesystem}`;
}

export function gmailPolicyRunDiagnostics({ first, retry }) {
  return [summarize("first", first), summarize("retry", retry)].join("\n");
}

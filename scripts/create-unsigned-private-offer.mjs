#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateOffer, refusePrivateOffer } from "../operations/private-update-offer.mjs";
import { readStableRegularFile } from "../operations/package-bundle-verifier.mjs";

/** Author public metadata only. The separate stdin signer owns all key handling. */
export function runCreateUnsignedPrivateOffer(argv, { now = Date.now(), onCheck = () => {} } = {}) {
  try {
    onCheck("arguments");
    const flags = {};
    const required = ["manifest", "package", "package-url", "to-version", "reason", "out"];
    const allowed = new Set([...required, "expires-in-days"]);
    if (!Array.isArray(argv)) refusePrivateOffer("PRIVATE_OFFER_SIGN");
    for (let index = 0; index < argv.length; index += 2) {
      const name = typeof argv[index] === "string" ? argv[index].slice(2) : "";
      if (!argv[index].startsWith("--") || !allowed.has(name) || Object.hasOwn(flags, name) ||
          typeof argv[index + 1] !== "string" || !argv[index + 1] || argv[index + 1].startsWith("--")) {
        refusePrivateOffer("PRIVATE_OFFER_SIGN");
      }
      flags[name] = argv[index + 1];
    }
    if (required.some(name => !flags[name])) refusePrivateOffer("PRIVATE_OFFER_SIGN");
    onCheck("offer");
    const unsigned = createPrivateOffer({
      manifest: JSON.parse(readFileSync(flags.manifest, "utf8")),
      toVersion: flags["to-version"], packageBytes: readStableRegularFile(flags.package),
      packageUrl: flags["package-url"], reason: flags.reason,
    }, { now, days: flags["expires-in-days"] === undefined ? 14 : Number(flags["expires-in-days"]) });
    onCheck("write");
    writeFileSync(flags.out, JSON.stringify(unsigned, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return unsigned;
  } catch { refusePrivateOffer("PRIVATE_OFFER_SIGN"); }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { runCreateUnsignedPrivateOffer(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}

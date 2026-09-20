#!/usr/bin/env node

import { rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "dist");

// Tailwind scans the project before Vite empties its output directory. A prior
// app.js can therefore introduce classes that were never present in source and
// make the second build differ from a clean-checkout build. Keep the target
// exact and local before removing this ignored generated directory.
if (dirname(DIST) !== HERE || basename(DIST) !== "dist") {
  throw new Error("frontend dist cleanup target is invalid");
}
rmSync(DIST, { recursive: true, force: true });

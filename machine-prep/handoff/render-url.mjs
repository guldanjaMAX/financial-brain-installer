#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [promptPath] = process.argv.slice(2);
if (!promptPath) {
  console.error("Usage: render-url.mjs PROMPT_FILE");
  process.exit(2);
}

const prompt = readFileSync(promptPath, "utf8").replace(/\r?\n$/, "");
if (!prompt || prompt.length > 13_000) {
  console.error("REFUSED handoff prompt must contain 1 to 13000 characters");
  process.exit(2);
}

process.stdout.write(`claude://code/new?q=${encodeURIComponent(prompt)}\n`);

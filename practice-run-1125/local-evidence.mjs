import fs from 'node:fs';
import path from 'node:path';
import { safeDir, plain, read, writeNew } from './safe-files.mjs';
export const LOCAL = 'LOCAL-NEVER-SHARE';
export const WARNING = 'LOCAL EVIDENCE ONLY. NEVER SHARE THIS FOLDER OR ITS CONTENTS.\n';
export function localRoot(dir = process.cwd()) {
  const base = safeDir(dir);
  const local = path.basename(base) === LOCAL ? base : path.join(base, LOCAL);
  try { safeDir(local, true); } catch (error) { if (error.code !== 'EEXIST') throw error; safeDir(local); }
  const marker = path.join(local, 'NEVER-SHARE.txt');
  if (!plain(marker, { absent: true })) {
    try { writeNew(marker, WARNING); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (read(marker) !== WARNING) throw new Error('Local evidence marker is missing or changed.');
  return local;
}
export function runRoot(dir = process.cwd()) {
  const local = localRoot(dir);
  return path.dirname(local);
}

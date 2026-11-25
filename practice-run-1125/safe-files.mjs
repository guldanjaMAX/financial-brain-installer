import fs from 'node:fs';
import path from 'node:path';
export function plain(file, { absent = false, directory = false } = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('Please use ordinary files and folders, without links.');
    return stat;
  } catch (error) { if (absent && error.code === 'ENOENT') return null; throw error; }
}
export function safeDir(dir, create = false) {
  const full = path.resolve(dir);
  const parts = full.split(path.sep).filter(Boolean);
  let current = path.parse(full).root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!plain(current, { absent: true, directory: true })) {
      if (!create) throw new Error('The run folder is missing.');
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  return full;
}
export function read(file) { plain(file); return fs.readFileSync(file, 'utf8'); }
export function writeNew(file, text) {
  safeDir(path.dirname(file));
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
}
export function replace(file, text) {
  const old = plain(file, { absent: true });
  if (old) fs.writeFileSync(file, text, { flag: 'w', mode: 0o600 });
  else writeNew(file, text);
}
export function rowId(value) { return /^(?:A[0-8]|[1-9]|[12][0-9]|3[0-3])$/.test(value || ''); }
export function fail(message, code = 1) { console.error(message); process.exitCode = code; }
export function mainError() { fail('The local check could not finish safely. Keep the files and ask the test driver to inspect them.'); }

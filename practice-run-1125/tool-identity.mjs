import fs from 'node:fs';

// Resolve beside this reviewed kit, never in the editable run folder or cwd.
// A standalone copy must retain the pinned tool's parent package.json.
const packageFile = new URL('../package.json', import.meta.url);
export function toolVersion() {
  const tool = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  if (tool.name !== 'brain-installer' || typeof tool.version !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$/.test(tool.version)) {
    const error = new Error('Use the reviewed kit beside its pinned tool package.');
    error.code = 'SUMMARY_TOOL_IDENTITY';
    throw error;
  }
  return tool.version;
}

import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const roots = ['src', 'scripts', 'test', 'public'];
const failures = [];

for (const root of roots) {
  for (const filePath of await listJsFiles(path.resolve(root))) {
    try {
      await execFileAsync(process.execPath, ['--check', filePath]);
      process.stdout.write('.');
    } catch (error) {
      failures.push({ filePath, error });
      process.stdout.write('F');
    }
  }
}

process.stdout.write('\n');

if (failures.length) {
  for (const failure of failures) {
    console.error(`\n${path.relative(process.cwd(), failure.filePath)}`);
    console.error(failure.error);
  }
  process.exit(1);
}

console.log('Syntax check passed.');

async function listJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsFiles(fullPath)));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      files.push(fullPath);
    }
  }

  return files;
}

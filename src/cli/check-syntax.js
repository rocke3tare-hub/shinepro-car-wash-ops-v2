// Syntax-check every JavaScript file in src/, public/ and test/ (no dependencies).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const files = [];
const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
};
for (const dir of ['src', 'public', 'test']) walk(path.join(ROOT, dir));
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed += 1; console.error(result.stderr); }
}
console.log(`${files.length - failed}/${files.length} files passed the syntax check.`);
process.exit(failed ? 1 : 0);

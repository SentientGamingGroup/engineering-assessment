// Candidate test runner: node submission/test.mjs (from the repository root).
// Runs every tests/**/*.test.mjs file serially (system tests spawn real processes).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./tests/', import.meta.url));
const files = readdirSync(root, { recursive: true })
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join(root, name));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

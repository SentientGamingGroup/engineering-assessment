// Candidate test runner: executes everything under submission/tests/ with the
// built-in node:test runner and propagates the exit code for CI. Test files are
// enumerated explicitly; `node --test <dir>` is not portable across Node versions.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = fileURLToPath(new URL('./tests', import.meta.url));
const files = (await readdir(testsDir))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join(testsDir, name));
if (files.length === 0) {
  console.error('No test files found under submission/tests/.');
  process.exit(1);
}
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('error', error => {
  console.error('Could not launch the test runner', error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});

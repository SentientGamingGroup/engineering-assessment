// Candidate test runner: Go service unit tests, client state tests and the
// end-to-end crash/concurrency test. Exits non-zero if any suite fails.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const suites = [
  ['Go round service', 'go', ['test', '-race', '-count=1', './...'], `${here}roundsvc`],
  ['Client state/timeline', process.execPath, ['--test', 'client/state.test.mjs'], here],
  ['Crash/concurrency (end-to-end)', process.execPath, ['--test', 'crash.test.mjs'], here],
];
let failed = 0;
for (const [name, command, args, cwd] of suites) {
  console.log(`\n=== ${name}`);
  const { status, error } = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (status !== 0) { failed++; console.error(`FAILED: ${name}${error ? ` (${error.message})` : ''}`); }
}
console.log(failed ? `\n${failed} suite(s) failed.` : '\nAll candidate suites passed.');
process.exitCode = failed ? 1 : 0;

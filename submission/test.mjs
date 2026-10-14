// Runs the candidate tests: `go test` for the round service, then Node's built-in runner:
//   service-go/*_test.go         round service: single owner of DATA_DIR
//   tests/round-state.test.mjs   client state: transitions, stale/duplicate events, scoring, refresh
//   tests/presentation.test.mjs  client timeline: ordering, Pause/Skip/cancel/replay
//   tests/system.test.mjs        start.mjs end to end: concurrency, crash recovery, reconnects
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const goDir = fileURLToPath(new URL('./service-go/', import.meta.url));
const go = spawnSync('go', ['test', './...'], { cwd: goDir, stdio: 'inherit' });
const dir = fileURLToPath(new URL('./tests/', import.meta.url));
const files = readdirSync(dir).filter(name => name.endsWith('.test.mjs')).sort().map(name => dir + name);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exitCode = go.status === 0 && result.status === 0 ? 0 : 1;

// Builds (when stale) and supervises the Go round service, resolving once it
// answers gRPC health checks on grpcPort.
//
// GO_SERVICE=external skips building/spawning so the service can be run under a
// Go debugger separately on GRPC_PORT.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { call } from '../lib/grpc.mjs';

const goDir = fileURLToPath(new URL('./service-go/', import.meta.url));
const binary = fileURLToPath(new URL(`./build/beacon-service${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));

// Newest build input: Go sources, go.mod/go.sum and vendored modules. Runtime output
// (e.g. a data/ dir from running the service under a debugger) must not force rebuilds.
const isBuildInput = name => name.endsWith('.go') || ['go.mod', 'go.sum', 'modules.txt'].includes(name);
const newestMtime = dir => readdirSync(dir, { withFileTypes: true }).reduce((newest, entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'data' ? newest : Math.max(newest, newestMtime(path));
  return isBuildInput(entry.name) ? Math.max(newest, statSync(path).mtimeMs) : newest;
}, 0);

function ensureBinary() {
  const built = existsSync(binary) ? statSync(binary).mtimeMs : 0;
  if (built && newestMtime(goDir) <= built) return;
  // Vendored modules build offline; without vendor/ Go downloads per go.sum.
  const mod = existsSync(join(goDir, 'vendor', 'modules.txt')) ? '-mod=vendor' : '-mod=readonly';
  // -modcacherw: Go makes downloaded modules read-only by default, which breaks deleting a
  // throwaway GOPATH afterwards (the acceptance harness removes its temp dir on close).
  const result = spawnSync('go', ['build', mod, '-modcacherw', '-trimpath', '-o', binary, '.'], { cwd: goDir, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`go build failed: ${result.error?.message ?? `exit code ${result.status}`}`);
  }
}

async function waitForHealth(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await call(client, 'health', {}, 500)).ok) return; }
    catch (error) { if (Date.now() > deadline) throw new Error(`round service not healthy: ${error.message}`); }
    await delay(100);
  }
}

export async function startGoService(client, { grpcPort, dataDir, roundDelayMs }) {
  if (process.env.GO_SERVICE === 'external') {
    console.log(`Waiting for an external round service on 127.0.0.1:${grpcPort}…`);
    await waitForHealth(client, 300_000); // a cold debug build under Delve can be slow
    return { close: async () => {} };
  }

  ensureBinary();
  let closing = false;
  // stdin stays piped: the service exits on EOF if this launcher dies abruptly.
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      GRPC_PORT: String(grpcPort),
      DATA_DIR: dataDir,
      ROUND_DELAY_MS: String(roundDelayMs),
      BEACON_PARENT_PIPE: '1',
    },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const reason = `round service exited (${signal ?? `code ${code}`})`;
      if (!closing) { console.error(reason); process.exit(1); }
      resolve();
    });
  });
  exited.catch(() => {}); // surfaced via the startup race; later spawn errors are moot

  try {
    await Promise.race([exited, waitForHealth(client, 30_000)]);
  } catch (error) {
    closing = true;
    child.kill('SIGKILL');
    throw error;
  }

  return {
    async close() {
      if (closing) return;
      closing = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

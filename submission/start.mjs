// Launcher: build (or reuse) the Go round service, supervise it, then start the
// Node HTTP/WebSocket gateway once gRPC Health answers.
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient, call } from '../lib/grpc.mjs';
import { createGateway } from './gateway.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const sourceDir = join(here, 'roundsvc');
const port = Number(process.env.PORT || 4400);
const grpcPort = Number(process.env.GRPC_PORT || 4402);

const fail = message => { console.error(`Beacon Relay failed to start: ${message}`); process.exit(1); };

// The binary is keyed by a hash of the Go sources, so restarts skip compilation
// and a source edit can never run a stale binary.
async function buildService() {
  const files = ['go.mod', 'go.sum'];
  for (const dir of ['.', 'pb']) {
    for (const name of await readdir(join(sourceDir, dir))) {
      if (name.endsWith('.go') && !name.endsWith('_test.go')) files.push(join(dir, name));
    }
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update(await readFile(join(sourceDir, file)));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binary = join(here, 'build', `roundsvc-${hash.digest('hex').slice(0, 16)}${suffix}`);
  if (await stat(binary).then(() => true, () => false)) return binary;
  await mkdir(join(here, 'build'), { recursive: true });
  const temporary = `${binary}.${process.pid}.tmp${suffix}`;
  try {
    await promisify(execFile)('go', ['build', '-o', temporary, '.'], { cwd: sourceDir, maxBuffer: 1 << 20 });
  } catch (error) {
    fail(`go build failed\n${error.stderr || error.message}`);
  }
  await rename(temporary, binary); // atomic: a concurrent start never runs a half-written file
  return binary;
}

const binary = await buildService();
// stdin is a pipe the service watches: if this launcher dies, the service exits too.
const child = spawn(binary, [], { env: process.env, stdio: ['pipe', 'inherit', 'inherit'] });
let stopping = false;
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
child.once('error', error => fail(`could not launch round service: ${error.message}`));
exited.then(({ code, signal }) => {
  if (!stopping) fail(`round service exited (code ${code}, signal ${signal})`);
});

const client = createClient(grpcPort);
for (let deadline = Date.now() + 30000; ; await delay(100)) {
  try { if ((await call(client, 'health', {}, 500)).ok) break; } catch {}
  if (Date.now() > deadline) { child.kill('SIGKILL'); fail('round service health check timed out'); }
}

const gateway = createGateway(client);
gateway.once('error', error => { child.kill('SIGTERM'); fail(`gateway: ${error.message}`); });
await new Promise(resolve => gateway.listen(port, '127.0.0.1', resolve));
console.log(`Beacon Relay: http://127.0.0.1:${gateway.address().port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    stopping = true;
    gateway.stopStream();
    gateway.closeAllConnections();
    gateway.close();
    client.close();
    child.kill('SIGTERM'); // forward shutdown; the service drains in-flight RPCs
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    process.exit(0);
  });
}

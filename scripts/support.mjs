import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { createClient, call } from '../lib/grpc.mjs';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function request(base, path, { method = 'GET', body, headers = {}, timeout = 2000 } = {}) {
  const response = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  return { status: response.status, body: await response.json() };
}
export async function waitFor(fn, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(25);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function createSystem({ entry = join(repositoryRoot, 'submission/start.mjs'), roundDelayMs = 800 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sentient-assessment-'));
  const dataDir = join(directory, 'service');
  const homeDir = join(directory, 'home');
  const goCache = join(directory, 'go-cache');
  const goPath = join(directory, 'go-path');
  await Promise.all([dataDir, homeDir, goCache, goPath].map(path => mkdir(path, { recursive: true })));
  const port = await freePort();
  let grpcPort = await freePort();
  while (grpcPort === port) grpcPort = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const client = createClient(grpcPort);
  let child;
  let output = '';
  let spawnError;
  const sockets = new Set();
  const allow = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LANG']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allow.has(key.toUpperCase())));
  Object.assign(env, {
    PORT: String(port), GRPC_PORT: String(grpcPort), DATA_DIR: dataDir,
    ROUND_DELAY_MS: String(roundDelayMs), GRPC_TIMEOUT_MS: '300',
    HOME: homeDir, USERPROFILE: homeDir, GOCACHE: goCache, GOPATH: goPath, GOTOOLCHAIN: 'local',
  });
  const stop = async (crash = false) => {
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopping = child;
    const exited = new Promise(resolve => stopping.once('exit', resolve));
    if (process.platform === 'win32') {
      try { await promisify(execFile)('taskkill', ['/PID', String(stopping.pid), '/T', '/F']); }
      catch { if (stopping.exitCode === null && stopping.signalCode === null) throw new Error('Could not stop service tree'); }
    } else {
      try { process.kill(-stopping.pid, crash ? 'SIGKILL' : 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await Promise.race([exited, delay(2000)]);
    if (stopping.exitCode === null && stopping.signalCode === null) {
      process.kill(-stopping.pid, 'SIGKILL'); await exited;
    }
  };
  const start = async () => {
    output = ''; spawnError = undefined;
    child = spawn(process.execPath, [resolve(entry)], {
      cwd: repositoryRoot, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', error => { spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', bytes => { output = (output + bytes.toString()).slice(-6000); });
    }
    try {
      await waitFor(async () => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Service exited');
        const health = await request(apiUrl, '/health', { timeout: 500 });
        return health.status === 200 && health.body.ok === true;
      }, 'service startup', 60000);
    } catch (error) {
      await stop(true); throw new Error(`${error.message}\nService output: ${output}`);
    }
  };
  const stream = async (after = 0) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/stream?after=${after}`);
    const messages = [];
    let closeCode;
    let socketError;
    sockets.add(socket);
    socket.on('message', bytes => {
      try { messages.push(JSON.parse(bytes.toString())); } catch { socketError = new Error('Invalid WS JSON'); }
    });
    socket.on('error', error => { socketError = error; });
    socket.on('close', code => { closeCode = code; sockets.delete(socket); });
    await Promise.race([
      new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }),
      delay(2000).then(() => { throw new Error('WS upgrade timed out'); }),
    ]);
    return {
      socket, messages,
      get closeCode() { return closeCode; },
      events: () => { if (socketError) throw socketError; return messages.filter(m => m.type === 'event').map(m => m.event); },
      close: () => socket.terminate(),
    };
  };
  const close = async () => {
    await stop(true); client.close();
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('sentient-assessment-'));
    await rm(directory, { recursive: true, force: true });
  };
  return {
    start, stop, close, stream, dataDir, apiUrl, grpcPort, roundDelayMs,
    api: (path, options) => request(apiUrl, path, options),
    rpc: (method, body, timeout = 1500) => call(client, method, body, timeout),
  };
}

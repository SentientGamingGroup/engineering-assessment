import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clamp01,
  easeInOut,
  mixPoint,
  frameDelta,
  timelineStage,
} from './client/timeline.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('client timeline has safe, predictable transitions', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(2), 1);

  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);

  assert.deepEqual(
    mixPoint({ x: 0, y: 10 }, { x: 20, y: 30 }, 0.5),
    { x: 10, y: 20 },
  );

  assert.equal(frameDelta(null, 100), 0);
  assert.equal(frameDelta(100, 110), 10);
  assert.equal(frameDelta(100, 500), 100);

  assert.equal(timelineStage(0, 100, 500, false), 'approach');
  assert.equal(timelineStage(250, 100, 500, false), 'travel');

  // Never reveal a result just because the animation finished.
  assert.equal(timelineStage(600, 100, 500, false), 'waiting');
  assert.equal(timelineStage(600, 100, 500, true), 'reveal');
});

async function freePort() {
  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });

  return port;
}

function launchServer(root, dataDir, httpPort, grpcPort) {
  const child = spawn(
    process.execPath,
    ['submission/start.mjs'],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(httpPort),
        GRPC_PORT: String(grpcPort),
        DATA_DIR: dataDir,
        ROUND_DELAY_MS: '5000',
        GRPC_TIMEOUT_MS: '1500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const logs = { text: '' };

  child.stdout.on('data', chunk => {
    logs.text += chunk.toString();
  });

  child.stderr.on('data', chunk => {
    logs.text += chunk.toString();
  });

  return { child, logs };
}

async function waitForServer(processInfo, baseUrl) {
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    const { child, logs } = processInfo;

    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server stopped unexpectedly:\n${logs.text}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health`);

      if (response.ok && (await response.json()).ok) {
        return;
      }
    } catch {
      // The listener may not be ready yet.
    }

    await sleep(100);
  }

  throw new Error(
    `Server did not become ready in time:\n${processInfo.logs.text}`,
  );
}

async function stopAbruptly(processInfo) {
  if (!processInfo) return;

  const { child } = processInfo;

  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Server process did not terminate')),
      5000,
    );

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    // Force termination: don't let the server's shutdown handler run.
    child.kill('SIGKILL');
  });
}

test(
  'concurrent duplicate requests and forced restart preserve a pending round',
  { timeout: 30000 },
  async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const dataDir = await mkdtemp(join(tmpdir(), 'beacon-relay-test-'));

    const httpPort = await freePort();
    let grpcPort = await freePort();

    while (grpcPort === httpPort) {
      grpcPort = await freePort();
    }

    const baseUrl = `http://127.0.0.1:${httpPort}`;
    const request = {
      requestId: 'recovery_test_001',
      playerId: 'recovery_player',
      choice: 1,
    };

    let server;

    try {
      server = launchServer(root, dataDir, httpPort, grpcPort);
      await waitForServer(server, baseUrl);

      // Send the same request 20 times concurrently.
      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          fetch(`${baseUrl}/rounds`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
          }),
        ),
      );

      const bodies = await Promise.all(
        responses.map(response => response.json()),
      );

      assert.ok(
        responses.every(response => response.status === 202),
        `Expected successful requests. Responses: ${JSON.stringify(bodies)}`,
      );

      const original = bodies[0];

      assert.equal(original.status, 'accepted');
      assert.ok(original.roundId);

      for (const round of bodies) {
        assert.equal(round.roundId, original.roundId);
        assert.equal(round.createdAt, original.createdAt);
        assert.equal(round.requestId, request.requestId);
      }

      // Stop the server before the five-second completion delay.
      await stopAbruptly(server);
      server = null;

      // Restart against exactly the same data directory and ports.
      server = launchServer(root, dataDir, httpPort, grpcPort);
      await waitForServer(server, baseUrl);

      // Recovery should complete the original round automatically.
      let recovered;
      const deadline = Date.now() + 10000;

      while (Date.now() < deadline) {
        const response = await fetch(
          `${baseUrl}/rounds/${original.roundId}`,
        );

        assert.equal(response.status, 200);
        recovered = await response.json();

        if (recovered.status === 'completed') break;

        await sleep(100);
      }

      assert.equal(recovered.status, 'completed');
      assert.equal(recovered.roundId, original.roundId);
      assert.equal(recovered.createdAt, original.createdAt);
      assert.equal(recovered.requestId, original.requestId);
      assert.equal(recovered.playerId, original.playerId);
      assert.equal(recovered.choice, original.choice);

      const expectedTarget =
        createHash('sha256')
          .update(original.roundId, 'utf8')
          .digest()[0] % 3;

      assert.equal(recovered.target, expectedTarget);
      assert.equal(
        recovered.score,
        recovered.choice === recovered.target ? 1 : 0,
      );

      // Only one accepted event and one completion event should exist.
      const historyResponse = await fetch(
        `${baseUrl}/events?after=0&limit=100`,
      );

      const history = await historyResponse.json();

      assert.equal(history.events.length, 2);
      assert.equal(history.events[0].sequence, 1);
      assert.equal(history.events[0].type, 'round.accepted');
      assert.equal(history.events[1].sequence, 2);
      assert.equal(history.events[1].type, 'round.completed');
      assert.equal(history.nextCursor, 2);

      assert.equal(
        history.events[0].round.roundId,
        original.roundId,
      );

      assert.equal(
        history.events[1].round.roundId,
        original.roundId,
      );

      assert.equal(
        history.events[1].round.completedAt,
        recovered.completedAt,
      );
    } finally {
      await stopAbruptly(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
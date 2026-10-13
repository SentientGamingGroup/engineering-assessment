import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { attachStream } from '../stream.mjs';
import { createSystem, waitFor } from '../../scripts/support.mjs';

test('WebSocket crosses multiple replay pages and live completion without duplicates', async () => {
  const system = await createSystem({ roundDelayMs: 150 });
  try {
    await system.start();
    for (let i = 0; i < 55; i++)
      await system.rpc('startRound', {
        requestId: `replay_${i}`,
        playerId: `player_${i}`,
        choice: i % 3,
      });
    await waitFor(
      async () =>
        (await system.rpc('listEvents', { after: 100 })).events?.length === 10,
      'history over one page',
    );
    const connecting = system.stream(0);
    await system.rpc('startRound', {
      requestId: 'live_boundary',
      playerId: 'live_boundary',
      choice: 0,
    });
    const feed = await connecting;
    await waitFor(() => feed.events().length === 112, 'replay/live boundary');
    assert.deepEqual(
      feed.events().map((e) => e.sequence),
      Array.from({ length: 112 }, (_, i) => i + 1),
    );
    feed.close();
    const resumed = await system.stream(109);
    await waitFor(() => resumed.events().length === 3, 'cursor suffix');
    assert.deepEqual(
      resumed.events().map((e) => e.sequence),
      [110, 111, 112],
    );
    resumed.close();
  } finally {
    await system.close();
  }
});

async function fixture(invoke, run, options = {}) {
  const server = createServer();
  const stop = attachStream(server, invoke);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/stream`,
    options,
  );
  socket.on('error', () => {});
  try {
    await run(socket);
  } finally {
    socket.terminate();
    stop();
    await new Promise((resolve) => server.close(resolve));
  }
}
test('outgoing queue is bounded and slow connections close with 1013', async () => {
  await fixture(
    async () => ({
      events: [{ sequence: 1, payload: 'x'.repeat(256 * 1024) }],
    }),
    async (socket) => {
      const code = await new Promise((resolve) =>
        socket.once('close', resolve),
      );
      assert.equal(code, 1013);
    },
  );
});
test(
  'heartbeat terminates a real peer that does not answer pings within 60 seconds',
  { timeout: 50000 },
  async () => {
    const started = Date.now();
    await fixture(
      async () => ({ events: [] }),
      async (socket) => {
        let pings = 0;
        socket.on('ping', () => pings++);
        await new Promise((resolve) => socket.once('close', resolve));
        assert.ok(pings >= 1);
        assert.ok(Date.now() - started < 60000);
      },
      { autoPong: false },
    );
  },
);
test('temporary upstream failure retains cursor; closing cancels future polling', async () => {
  let count = 0;
  await fixture(
    async (_method, { after }) => {
      count++;
      assert.equal(after, count <= 2 ? 0 : 1);
      if (count === 1) throw new Error('temporary upstream failure');
      return {
        events:
          count === 2
            ? [{ sequence: 1, type: 'round.accepted', round: {} }]
            : [],
      };
    },
    async (socket) => {
      const frame = await new Promise((resolve) =>
        socket.once('message', (bytes) => resolve(JSON.parse(bytes))),
      );
      assert.equal(frame.event.sequence, 1);
      await new Promise((resolve) => {
        socket.once('close', resolve);
        socket.close();
      });
      await delay(100);
      const stoppedAt = count;
      await delay(200);
      assert.equal(count, stoppedAt);
    },
  );
});

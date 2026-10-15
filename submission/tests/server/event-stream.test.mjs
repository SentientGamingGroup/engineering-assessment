// WebSocket feed: ordering across the backfill/live boundary, upstream failures,
// slow consumers and heartbeats. Uses a fake ListEvents so timing is controllable.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { waitFor } from '../../../scripts/support.mjs';
import { attachStream, LIMITS } from '../../server/gateway/event-stream.mjs';

function fakeLog() {
  const events = [];
  const add = (n = 1, size = 0) => {
    for (let i = 0; i < n; i++) {
      const sequence = events.length + 1;
      events.push({ sequence, type: 'round.accepted', round: { roundId: `r${sequence}`, pad: 'x'.repeat(size) } });
    }
  };
  return { events, add };
}
async function serve(t, invoke, limits = {}) {
  const server = createServer();
  const stop = attachStream(server, invoke, { ...LIMITS, pollMs: 10, retryMs: 20, ...limits });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { stop(); server.closeAllConnections(); server.close(); });
  const open = (after, options) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/stream?after=${after}`, options);
    const seen = [];
    socket.on('message', data => seen.push(JSON.parse(data).event.sequence));
    socket.on('error', () => {});
    const closed = new Promise(resolve => socket.on('close', code => resolve(code)));
    t.after(() => socket.terminate());
    return { socket, seen, closed };
  };
  open.server = stop.wss;
  return open;
}

test('events committed during backfill are delivered exactly once, in order', async t => {
  const log = fakeLog();
  log.add(250); // more than two pages of history
  let calls = 0;
  const invoke = async (_method, { after, limit }) => {
    if (++calls === 2) log.add(5); // new events land mid-backfill
    const page = log.events.slice(after, after + limit);
    return { events: page, nextCursor: page.at(-1)?.sequence ?? after };
  };
  const open = await serve(t, invoke);
  const client = open(10);
  await waitFor(() => client.seen.length === 245, 'backfill + mid-backfill events');
  log.add(3);
  await waitFor(() => client.seen.length === 248, 'live events');
  assert.deepEqual(client.seen, Array.from({ length: 248 }, (_, i) => i + 11));
});

test('upstream deadline errors keep the cursor and recover without gaps', async t => {
  const log = fakeLog();
  log.add(4);
  let failures = 3;
  const invoke = async (_method, { after, limit }) => {
    if (failures-- > 0) throw Object.assign(new Error('deadline'), { code: 4 });
    const page = log.events.slice(after, after + limit);
    return { events: page, nextCursor: page.at(-1)?.sequence ?? after };
  };
  const client = (await serve(t, invoke))(0);
  await waitFor(() => client.seen.length === 4, 'recovered delivery');
  assert.deepEqual(client.seen, [1, 2, 3, 4]);
});

test('a consumer whose queued output would exceed the cap is closed with 1013', async t => {
  const log = fakeLog();
  log.add(50, 4000);
  const invoke = async (_m, { after, limit }) => {
    const page = log.events.slice(after, after + limit);
    return { events: page, nextCursor: page.at(-1)?.sequence ?? after };
  };
  // Tiny cap so the test is deterministic without a real slow TCP peer.
  const client = (await serve(t, invoke, { maxQueuedBytes: 3000, resumeBelowBytes: 1000 }))(0);
  assert.equal(await client.closed, 1013);
});

test('a real peer that stops reading is closed with 1013 while queued output stays bounded', async t => {
  const log = fakeLog();
  log.add(3000, 3000); // ~9 MB of history: far more than socket buffers can absorb
  const invoke = async (_m, { after, limit }) => {
    const page = log.events.slice(after, after + limit);
    return { events: page, nextCursor: page.at(-1)?.sequence ?? after };
  };
  let maxQueued = 0;
  const open = await serve(t, invoke, { slowConsumerMs: 300 }); // real 256 KiB / 64 KiB limits
  const client = open(0);
  await new Promise(resolve => client.socket.once('open', resolve));
  client.socket._socket.pause(); // stop reading from TCP, like a stalled browser tab
  const sampler = setInterval(() => {
    for (const peer of open.server.clients ?? []) maxQueued = Math.max(maxQueued, peer.bufferedAmount);
  }, 5);
  t.after(() => clearInterval(sampler));
  await delay(800);
  client.socket._socket.resume(); // read the backlog and the close frame
  assert.equal(await client.closed, 1013);
  assert.ok(client.seen.length < 3000, 'peer was cut off, not fed the whole history');
  assert.ok(maxQueued <= LIMITS.maxQueuedBytes, `queued ${maxQueued} bytes`);
});

test('a peer that stops answering pings is terminated by the heartbeat', async t => {
  const invoke = async (_m, { after }) => ({ events: [], nextCursor: after });
  const client = (await serve(t, invoke, { heartbeatMs: 40 }))(0, { autoPong: false });
  const code = await Promise.race([client.closed, delay(1000).then(() => 'timeout')]);
  assert.equal(code, 1006); // terminated, not a clean close
});

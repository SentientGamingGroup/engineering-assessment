// Realtime boundary tests that the acceptance checker leaves to code review:
// slow-consumer backpressure (1013), heartbeat termination of a silent peer,
// and a gateway gRPC deadline that hides acceptance (retry → one round).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createClient, listenGrpc } from '../../lib/grpc.mjs';
import { attachStream } from '../stream.mjs';
import { createService } from '../service.mjs';
import { createGateway } from '../gateway.mjs';

const listen = server => new Promise(resolve =>
  server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closed = socket => new Promise(resolve =>
  socket.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
const opened = socket => new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

// An endless upstream of large events: the feed always has more to send.
function endlessFeed() {
  const padding = 'x'.repeat(3000);
  return async (_method, { after }) => ({
    events: Array.from({ length: 100 }, (_, i) => ({
      sequence: after + i + 1,
      type: 'round.accepted',
      round: { roundId: `r${after + i + 1}`, requestId: padding, playerId: 'p', choice: 0, status: 'accepted', createdAt: new Date().toISOString() },
    })),
    nextCursor: after + 100,
  });
}

test('slow consumer: a peer that stops reading is closed with 1013 and output stays bounded', { timeout: 15000 }, async () => {
  const server = createServer();
  const stop = attachStream(server, endlessFeed());
  const port = await listen(server);
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/stream?after=0`);
    await opened(socket);
    socket._socket.pause(); // stop reading: TCP buffers fill, then ws buffers
    await delay(1500);
    const done = closed(socket);
    socket._socket.resume(); // drain so the close frame can be read
    const { code, reason } = await done;
    assert.equal(code, 1013);
    assert.equal(reason, 'SLOW_CONSUMER');
  } finally {
    stop();
    await new Promise(resolve => server.close(resolve));
  }
});

test('heartbeat: a peer that never answers pings is terminated; a responsive one stays open', { timeout: 15000 }, async () => {
  const server = createServer();
  const quiet = async (_method, { after }) => ({ events: [], nextCursor: after });
  const stop = attachStream(server, quiet, { heartbeatMs: 100 });
  const port = await listen(server);
  try {
    const silent = new WebSocket(`ws://127.0.0.1:${port}/stream?after=0`, { autoPong: false });
    const healthy = new WebSocket(`ws://127.0.0.1:${port}/stream?after=0`);
    await Promise.all([opened(silent), opened(healthy)]);
    const started = Date.now();
    const { code } = await closed(silent);
    assert.equal(code, 1006, 'terminated without a close handshake');
    assert.ok(Date.now() - started < 1000, 'silent peer dropped within ~2 heartbeat intervals');
    await delay(500); // several more intervals
    assert.equal(healthy.readyState, WebSocket.OPEN, 'pong-answering peer is kept');
    healthy.close();
  } finally {
    stop();
    await new Promise(resolve => server.close(resolve));
  }
});

test('gateway deadline: a slow StartRound returns 504, and retrying the same requestId yields the one original round', { timeout: 15000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'beacon-deadline-'));
  const service = await createService({ dataDir, roundDelayMs: 60000 });
  // The round is accepted durably, but the reply is delayed past the gateway deadline.
  let slowCalls = 1;
  const handlers = {
    ...service.handlers,
    startRound: (call, callback) => service.handlers.startRound(call, (error, result) => {
      if (slowCalls-- > 0) setTimeout(() => callback(error, result), 400);
      else callback(error, result);
    }),
  };
  const rpc = await listenGrpc(handlers, 0);
  const client = createClient(rpc.boundPort);
  const previous = process.env.GRPC_TIMEOUT_MS;
  process.env.GRPC_TIMEOUT_MS = '150';
  const gateway = createGateway(client);
  if (previous === undefined) delete process.env.GRPC_TIMEOUT_MS; else process.env.GRPC_TIMEOUT_MS = previous;
  const port = await listen(gateway);
  const post = body => fetch(`http://127.0.0.1:${port}/rounds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const intent = { requestId: 'deadline_req', playerId: 'deadline_player', choice: 1 };
    const first = await post(intent);
    assert.equal(first.status, 504);
    assert.equal((await first.json()).error.code, 'UPSTREAM_TIMEOUT');
    await delay(400); // the hidden acceptance has landed server-side

    const retry = await post(intent);
    assert.equal(retry.status, 202);
    const round = await retry.json();
    assert.equal(round.requestId, 'deadline_req');

    const { events } = await (await fetch(`http://127.0.0.1:${port}/events`)).json();
    assert.equal(events.length, 1, 'the timeout did not create a second round');
    assert.equal(events[0].round.roundId, round.roundId);
  } finally {
    gateway.stopStream();
    gateway.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve));
    client.close();
    rpc.forceShutdown();
    service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// In-memory upstream with the real ListEvents paging rules; `fail` injects outages.
function memoryFeed(count) {
  const events = [];
  const add = n => {
    for (let i = 0; i < n; i++) {
      const sequence = events.length + 1;
      events.push({ sequence, type: 'round.accepted', round: { roundId: `m${sequence}` } });
    }
  };
  add(count);
  const feed = { add, failures: 0, calls: 0 };
  feed.invoke = async (_method, { after, limit }) => {
    feed.calls += 1;
    if (feed.failures > 0) { feed.failures -= 1; throw Object.assign(new Error('down'), { code: 14 }); }
    const page = events.filter(e => e.sequence > after).slice(0, limit);
    return { events: page, nextCursor: page.at(-1)?.sequence ?? after };
  };
  return feed;
}
const collect = socket => {
  const seen = [];
  socket.on('message', data => seen.push(JSON.parse(data).event.sequence));
  return seen;
};
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await delay(20); }
};

test('replay crosses several 100-event pages, then continues live with no gap or duplicate', { timeout: 15000 }, async () => {
  const feed = memoryFeed(250);
  const server = createServer();
  const stop = attachStream(server, feed.invoke);
  const port = await listen(server);
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/stream?after=37`);
    const seen = collect(socket);
    await opened(socket);
    await until(() => seen.length === 250 - 37);
    feed.add(5); // live events arriving after the backlog
    await until(() => seen.length === 250 - 37 + 5);
    assert.deepEqual(seen, Array.from({ length: 218 }, (_, i) => 38 + i));
    socket.close();
  } finally {
    stop();
    await new Promise(resolve => server.close(resolve));
  }
});

test('an upstream outage keeps the connection and cursor: delivery resumes without gaps', { timeout: 15000 }, async () => {
  const feed = memoryFeed(3);
  const server = createServer();
  const stop = attachStream(server, feed.invoke);
  const port = await listen(server);
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/stream?after=0`);
    const seen = collect(socket);
    await opened(socket);
    await until(() => seen.length === 3);
    feed.failures = 4; // gRPC unavailable for several polls
    feed.add(2);
    const callsBefore = feed.calls;
    await until(() => feed.calls >= callsBefore + 4);
    assert.equal(socket.readyState, WebSocket.OPEN, 'outage does not drop the client');
    await until(() => seen.length === 5);
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    socket.close();
  } finally {
    stop();
    await new Promise(resolve => server.close(resolve));
  }
});

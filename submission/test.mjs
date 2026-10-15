// Candidate tests. Run with `node submission/test.mjs` (or `node --test`).
// These drive the real system through the supplied harness: a spawned service,
// a genuine gRPC client, HTTP and WebSocket. Timings use a short round delay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createSystem, waitFor, repositoryRoot } from '../scripts/support.mjs';
import { grpc } from '../lib/grpc.mjs';
import { join } from 'node:path';

const intent = (requestId, playerId = requestId, choice = 0) => ({ requestId, playerId, choice });
const withSystem = async (fn, roundDelayMs = 150) => {
  const s = await createSystem({ roundDelayMs });
  try { await s.start(); await fn(s); } finally { await s.close(); }
};
const completed = (s, id) => waitFor(async () => {
  const r = await s.rpc('getRound', { roundId: id });
  return r.status === 'completed' && r;
}, 'completion');

// Duplicate requests share one round and complete exactly once; a replay after
// completion returns the same round and never appends a second pair of events.
test('duplicate requests complete once and replay cleanly', () => withSystem(async s => {
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    i % 2 ? s.rpc('startRound', intent('dup', 'p')) : s.api('/rounds', { method: 'POST', body: intent('dup', 'p') }).then(r => r.body)));
  const ids = new Set(results.map(r => r.roundId));
  assert.equal(ids.size, 1, 'all duplicates resolve to one round');
  const id = [...ids][0];
  const done = await completed(s, id);
  assert.equal(done.score, done.choice === done.target ? 1 : 0);
  // Replaying the same request id after completion returns the same round.
  const replay = await s.api('/rounds', { method: 'POST', body: intent('dup', 'p') });
  assert.equal(replay.status, 202);
  assert.equal(replay.body.roundId, id);
  const events = (await s.api('/events?after=0&limit=100')).body.events;
  assert.equal(events.filter(e => e.round.roundId === id).length, 2, 'exactly accepted + completed');
}));

// A client that disconnects and reconnects with its last cursor receives only
// the events it missed, with no gap and no duplicate across the boundary.
test('reconnect with cursor replays the gap exactly', () => withSystem(async s => {
  const feed = await s.stream(0);
  const a = await s.api('/rounds', { method: 'POST', body: intent('r1') });
  await completed(s, a.body.roundId);
  await waitFor(() => feed.events().length === 2, 'first pair');
  const cursor = feed.events().at(-1).sequence;
  feed.close();
  const b = await s.api('/rounds', { method: 'POST', body: intent('r2') });
  await completed(s, b.body.roundId);
  const resumed = await s.stream(cursor);
  await waitFor(() => resumed.events().length === 2, 'missed pair');
  assert.deepEqual(resumed.events().map(e => e.sequence), [cursor + 1, cursor + 2]);
  resumed.close();
}));

// Pending rounds never leak an outcome; completed rounds expose a consistent one.
test('round snapshots hide pending outcomes and validate inputs', () => withSystem(async s => {
  const r = await s.api('/rounds', { method: 'POST', body: intent('state', 'sp', 2) });
  const pending = r.body;
  assert.equal(pending.status, 'accepted');
  assert.ok(!('target' in pending) && !('score' in pending) && !('completedAt' in pending));
  const done = await completed(s, pending.roundId);
  assert.equal(done.target, (await import('node:crypto')).createHash('sha256').update(done.roundId).digest()[0] % 3);
  for (const bad of [{}, intent('', 'x'), intent('x', 'x', 3), { ...intent('x'), extra: 1 }]) {
    assert.equal((await s.api('/rounds', { method: 'POST', body: bad })).status, 400);
  }
  await assert.rejects(s.rpc('getRound', { roundId: 'nope' }), e => e.code === grpc.status.NOT_FOUND);
  assert.equal((await s.api('/events?after=0&limit=100')).body.events.length, 2, 'rejections create no state');
}));

// An abrupt SIGKILL during a pending round must not lose work: on restart the
// round finishes with its original createdAt and history is preserved.
test('crash recovery finishes pending work and preserves history', () => withSystem(async s => {
  const before = await s.api('/rounds', { method: 'POST', body: intent('keep') });
  await completed(s, before.body.roundId);
  const pending = await s.api('/rounds', { method: 'POST', body: intent('crash') });
  const createdAt = pending.body.createdAt;
  await s.stop(true);                 // SIGKILL before completion
  await delay(s.roundDelayMs + 50);
  await s.start();
  const recovered = await completed(s, pending.body.roundId);
  assert.equal(recovered.createdAt, createdAt, 'createdAt stable across restart');
  const events = (await s.api('/events?after=0&limit=100')).body.events;
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1), 'contiguous sequence');
  assert.equal(events.filter(e => e.round.roundId === before.body.roundId).length, 2, 'prior result preserved');
}));

// Independent players proceed concurrently; every round yields exactly one
// accepted + completed pair and the global sequence stays contiguous.
test('concurrent distinct players keep a contiguous event log', () => withSystem(async s => {
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    s.api('/rounds', { method: 'POST', body: intent('w' + i, 'wp' + i, i % 3) }).then(r => r.body)));
  assert.equal(new Set(many.map(r => r.roundId)).size, 10);
  await Promise.all(many.map(r => completed(s, r.roundId)));
  const events = (await s.api('/events?after=0&limit=100')).body.events;
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
  for (const r of many) assert.equal(events.filter(e => e.round.roundId === r.roundId).length, 2);
}));

// Client contract: the served UI exposes the controls, choices and ARIA the
// timeline depends on. (Interactive behavior is evidenced manually in DEMO.md.)
test('served client exposes the required controls and choices', async () => {
  const dir = join(repositoryRoot, 'submission/client');
  const html = await readFile(join(dir, 'index.html'), 'utf8');
  for (const id of ['play', 'pause', 'skip', 'replay', 'new', 'result', 'score', 'connection']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} present`);
  }
  for (const choice of [0, 1, 2]) assert.match(html, new RegExp(`data-choice="${choice}"`));
  assert.match(html, /aria-pressed/);
  const app = await readFile(join(dir, 'app.mjs'), 'utf8');
  assert.match(app, /\/stream\?after=/, 'reconnects with a cursor');
  assert.match(app, /localStorage|store\./, 'persists state across refresh');
});

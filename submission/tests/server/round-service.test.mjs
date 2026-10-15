// RoundService over a real gRPC channel, in-process, with a temp DATA_DIR.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { call, createClient, grpc, listenGrpc } from '../../../lib/grpc.mjs';
import { createService } from '../../server/service/round-service.mjs';
import { targetFor } from '../../server/service/round-rules.mjs';

const DELAY = 150;
async function boot(dataDir, roundDelayMs = DELAY) {
  const service = await createService({ dataDir, roundDelayMs });
  const server = await listenGrpc(service.handlers, 0);
  const client = createClient(server.boundPort);
  const rpc = (method, body) => call(client, method, body, 1000);
  const stop = () => { client.close(); server.forceShutdown(); service.close(); };
  return { rpc, stop };
}
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const eventsOf = async rpc => (await rpc('listEvents', { after: 0, limit: 100 })).events ?? [];
const waitCompleted = async (rpc, roundId) => {
  for (let i = 0; i < 100; i++) {
    const round = await rpc('getRound', { roundId });
    if (round.status === 'completed') return round;
    await delay(20);
  }
  throw new Error('round did not complete');
};

test('20 concurrent duplicates create exactly one round and one accepted event', async t => {
  const { rpc, stop } = await boot(tempDir(t));
  t.after(stop);
  const intent = { requestId: 'dup', playerId: 'p1', choice: 2 };
  const replies = await Promise.all(Array.from({ length: 20 }, () => rpc('startRound', intent)));
  assert.equal(new Set(replies.map(r => r.roundId)).size, 1);
  const events = await eventsOf(rpc);
  assert.deepEqual(events.map(e => e.type), ['round.accepted']);
  await assert.rejects(rpc('startRound', { ...intent, choice: 1 }),
    e => e.code === grpc.status.ALREADY_EXISTS && e.details === 'IDEMPOTENCY_CONFLICT');
});

test('one pending round per player; other players proceed; duplicates resolve before the guard', async t => {
  const { rpc, stop } = await boot(tempDir(t));
  t.after(stop);
  const first = await rpc('startRound', { requestId: 'a1', playerId: 'p1', choice: 0 });
  await assert.rejects(rpc('startRound', { requestId: 'a2', playerId: 'p1', choice: 0 }),
    e => e.code === grpc.status.FAILED_PRECONDITION && e.details === 'ROUND_IN_PROGRESS');
  // Same requestId while pending is a replay, not a busy-player error.
  assert.equal((await rpc('startRound', { requestId: 'a1', playerId: 'p1', choice: 0 })).roundId, first.roundId);
  const others = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    rpc('startRound', { requestId: `b${i}`, playerId: `q${i}`, choice: i % 3 })));
  assert.equal(new Set(others.map(r => r.roundId)).size, 10);
});

test('completes once, not before the delay, with the public target rule and no early disclosure', async t => {
  const { rpc, stop } = await boot(tempDir(t));
  t.after(stop);
  const accepted = await rpc('startRound', { requestId: 'r1', playerId: 'p1' }); // omitted choice = 0
  assert.equal(accepted.choice, 0);
  assert.ok(!('target' in accepted) && !('score' in accepted) && !('completedAt' in accepted));
  const done = await waitCompleted(rpc, accepted.roundId);
  assert.ok(Date.parse(done.completedAt) - Date.parse(done.createdAt) >= DELAY);
  assert.equal(done.target, targetFor(done.roundId));
  assert.equal(done.score, done.choice === done.target ? 1 : 0);
  await delay(DELAY * 2);
  const events = await eventsOf(rpc);
  assert.deepEqual(events.map(e => [e.sequence, e.type]), [[1, 'round.accepted'], [2, 'round.completed']]);
  assert.equal(events[0].round.status, 'accepted'); // snapshot at the event, not the latest state
});

test('restart: pending rounds finish, completed rounds never complete again, history is identical', async t => {
  const dir = tempDir(t);
  const first = await boot(dir);
  const done = await first.rpc('startRound', { requestId: 'done', playerId: 'p1', choice: 1 });
  await waitCompleted(first.rpc, done.roundId);
  const pending = await first.rpc('startRound', { requestId: 'pend', playerId: 'p2', choice: 2 });
  const before = await eventsOf(first.rpc);
  first.stop(); // timers cleared: simulates the process dying with a pending round
  await delay(DELAY + 50); // the round becomes overdue while down

  const second = await boot(dir);
  t.after(second.stop);
  const recovered = await waitCompleted(second.rpc, pending.roundId);
  assert.equal(recovered.createdAt, pending.createdAt);
  const after = await eventsOf(second.rpc);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.length, before.length + 1);
  assert.equal(after.filter(e => e.round.roundId === done.roundId && e.type === 'round.completed').length, 1);
  assert.equal((await second.rpc('startRound', { requestId: 'pend', playerId: 'p2', choice: 2 })).roundId, pending.roundId);
});

test('a torn final log line (crash mid-write) is discarded; earlier corruption is refused', async t => {
  const dir = tempDir(t);
  const first = await boot(dir);
  await first.rpc('startRound', { requestId: 'x', playerId: 'p1', choice: 0 });
  first.stop();
  appendFileSync(join(dir, 'events.jsonl'), '{"sequence":2,"type":"round.compl');
  const second = await boot(dir);
  assert.equal((await eventsOf(second.rpc)).length >= 1, true);
  second.stop();
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n');
  assert.ok(lines.every(line => !line || JSON.parse(line)));

  appendFileSync(join(dir, 'events.jsonl'), 'garbage\n{"sequence":99}\n');
  await assert.rejects(createService({ dataDir: dir, roundDelayMs: DELAY }), /Corrupt event log/);
});

test('single owner: a second live service on the same DATA_DIR is refused; a crashed owner\'s lock is taken over', async t => {
  const dir = tempDir(t);
  const first = await boot(dir);
  t.after(first.stop);
  await assert.rejects(createService({ dataDir: dir, roundDelayMs: DELAY }), /already owned/);
  first.stop();
  writeFileSync(join(dir, 'owner.lock'), '999999'); // PID of a process that no longer exists
  const second = await boot(dir);
  second.stop();
});

test('validation errors use exact codes and create no state', async t => {
  const { rpc, stop } = await boot(tempDir(t));
  t.after(stop);
  for (const body of [{}, { requestId: 'x' }, { requestId: 'x', playerId: 'bad id' },
    { requestId: 'x', playerId: 'p', choice: 3 }, { requestId: 'y'.repeat(65), playerId: 'p' }]) {
    await assert.rejects(rpc('startRound', body), e => e.code === grpc.status.INVALID_ARGUMENT && e.details === 'INVALID_REQUEST');
  }
  await assert.rejects(rpc('listEvents', { limit: 101 }), e => e.details === 'INVALID_CURSOR');
  await assert.rejects(rpc('getRound', { roundId: 'nope' }), e => e.code === grpc.status.NOT_FOUND);
  await assert.rejects(rpc('getRound', {}), e => e.code === grpc.status.INVALID_ARGUMENT);
  assert.deepEqual(await eventsOf(rpc), []);
  assert.equal((await rpc('listEvents', { after: 7, limit: 0 })).nextCursor, 7);
});

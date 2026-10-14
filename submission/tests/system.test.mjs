// Whole system (node submission/start.mjs: Node gateway + Go round service) over the
// real HTTP, WebSocket and gRPC interfaces: concurrency, crash recovery without duplicate
// completion, and reconnecting without gaps. Uses the supplied harness helpers (read-only).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystem, waitFor } from '../../scripts/support.mjs';
import { RoundState } from '../client/RoundState.ts';

const DELAY = 600;
let s;
before(async () => {
  s = await createSystem({ roundDelayMs: DELAY });
  await s.start();
});
after(async () => { await s?.close(); });

const start = (requestId, playerId = requestId, choice = 0) =>
  s.api('/rounds', { method: 'POST', body: { requestId, playerId, choice } });
const history = async () => (await s.api('/events?after=0&limit=100')).body.events;
const completedRound = id => waitFor(async () => {
  const round = await s.rpc('getRound', { roundId: id });
  return round.status === 'completed' && round;
}, `completion of ${id}`);
const countOf = (events, roundId, type) => events.filter(e => e.round.roundId === roundId && e.type === type).length;

test('20 concurrent duplicates create one round; 10 players proceed independently; one pending round per player', async () => {
  const dupes = await Promise.all(Array.from({ length: 20 }, () => start('dup_req', 'dup_player', 1)));
  assert.ok(dupes.every(r => r.status === 202));
  assert.equal(new Set(dupes.map(r => r.body.roundId)).size, 1);

  const players = await Promise.all(Array.from({ length: 10 }, (_, i) => start(`multi_${i}`, `player_${i}`, i % 3)));
  assert.ok(players.every(r => r.status === 202));
  assert.equal(new Set(players.map(r => r.body.roundId)).size, 10);
 
  const busy = await start('dup_req_2', 'dup_player', 1);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'ROUND_IN_PROGRESS');

  const ids = [dupes[0].body.roundId, ...players.map(r => r.body.roundId)];
  await Promise.all(ids.map(completedRound));
  const events = await history();
  for (const id of ids) {
    assert.equal(countOf(events, id, 'round.accepted'), 1, `${id} accepted once`);
    assert.equal(countOf(events, id, 'round.completed'), 1, `${id} completed once`);
  }
});

test('abrupt kill: a pending round completes exactly once after restart; finished rounds never complete again', async () => {
  const done = await start('crash_done', 'crash_p1', 2);
  await completedRound(done.body.roundId);
  const pending = await start('crash_pending', 'crash_p2', 0);
  assert.equal(pending.body.status, 'accepted');
  const before = await history();

  await s.stop(true); // SIGKILL the whole process tree mid-round
  await s.start();

  const recovered = await completedRound(pending.body.roundId);
  assert.equal(recovered.roundId, pending.body.roundId);
  assert.equal(recovered.createdAt, pending.body.createdAt, 'identity and timestamps survive');
  await new Promise(resolve => setTimeout(resolve, DELAY * 2)); // room for any wrong re-completion
  const events = await history();
  assert.deepEqual(events.slice(0, before.length), before, 'history before the crash is unchanged');
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1), 'no gaps or repeats');
  for (const id of [done.body.roundId, pending.body.roundId]) {
    assert.equal(countOf(events, id, 'round.completed'), 1, `${id} completed exactly once`);
  }

  const again = await start('crash_pending', 'crash_p2', 0);
  assert.equal(again.status, 202);
  assert.deepEqual(again.body, recovered, 'a retry of the same request returns the original result');
});

test('reconnecting with the last applied cursor resumes without gaps or duplicates', async () => {
  const head = (await history()).at(-1)?.sequence ?? 0;
  const first = await s.stream(head);
  const a = await start('reconnect_a', 'reconnect_p1', 1);
  await waitFor(() => first.events().some(e => e.round.roundId === a.body.roundId && e.type === 'round.completed'), 'live completion');
  const seen = first.events();
  first.close();

  // While disconnected, more happens.
  const b = await start('reconnect_b', 'reconnect_p2', 2);
  await completedRound(b.body.roundId);

  const cursor = seen.at(-1).sequence;
  const second = await s.stream(cursor);
  await waitFor(() => second.events().some(e => e.round.roundId === b.body.roundId && e.type === 'round.completed'), 'backfill');
  const all = [...seen, ...second.events()];
  assert.deepEqual(all.map(e => e.sequence), all.map((_, i) => head + 1 + i), 'contiguous across the reconnect');
  second.close();

  // The client state applies the same feed: every event once, cursor at the head.
  const client = RoundState.restore({ playerId: 'reconnect_p1', cursor: head, results: {} }, p => `${p}_x`);
  for (const e of [...all, ...second.events()]) client.applyEvent(e); // includes redelivered events
  assert.equal(client.cursor, all.at(-1).sequence);
});

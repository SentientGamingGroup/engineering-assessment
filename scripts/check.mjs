import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { grpc } from '../lib/grpc.mjs';
import { createSystem, waitFor } from './support.mjs';

const targetFor = id => createHash('sha256').update(id).digest()[0] % 3;
export async function runChecks({ entry, starter = false } = {}) {
  const s = await createSystem({ entry });
  let passed = 0;
  const pass = label => { passed++; console.log(`PASS ${label}`); };
  const intent = (requestId, playerId = requestId, choice = 0) => ({ requestId, playerId, choice });
  const submit = payload => s.api('/rounds', { method: 'POST', body: payload });
  const history = async after => (await s.api(`/events?after=${after}&limit=100`)).body;
  const complete = id => waitFor(async () => {
    const r = await s.rpc('getRound', { roundId: id });
    return r.status === 'completed' && r;
  }, 'server completion');
  const valid = round => {
    assert.match(round.roundId, /^[A-Za-z0-9_-]{1,128}$/);
    assert.ok(round.createdAt.endsWith('Z') && Number.isFinite(Date.parse(round.createdAt)));
    if (round.status === 'accepted') {
      assert.ok(!('target' in round)); assert.ok(!('score' in round)); assert.ok(!('completedAt' in round));
    } else {
      assert.equal(round.status, 'completed');
      assert.equal(round.target, targetFor(round.roundId));
      assert.equal(round.score, round.choice === round.target ? 1 : 0);
      assert.ok(round.completedAt.endsWith('Z'));
      assert.ok(Date.parse(round.completedAt) - Date.parse(round.createdAt) >= s.roundDelayMs);
    }
  };
  try {
    await s.start();
    assert.equal((await s.rpc('health', {})).ok, true);
    const page = await fetch(s.apiUrl + '/');
    assert.equal(page.status, 200); assert.match(await page.text(), /<html/i);
    const socket = await s.stream();
    socket.close();
    pass('HTTP page, genuine gRPC health and WebSocket upgrade');
    if (starter) return passed;

    const before = Date.now();
    const first = await submit(intent('first', 'player_1'));
    assert.equal(first.status, 202, 'StartRound is intentionally unimplemented in the starter');
    valid(first.body); assert.equal(first.body.status, 'accepted');
    assert.ok(Date.now() - before < 1000);
    const id = first.body.roundId;
    const duplicates = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      i % 2 ? s.rpc('startRound', intent('first', 'player_1')) : submit(intent('first', 'player_1')).then(r => {
        assert.equal(r.status, 202); return r.body;
      })));
    assert.ok(duplicates.every(r => r.roundId === id));
    const early = await s.rpc('getRound', { roundId: id }); valid(early);
    const conflict = await submit(intent('first', 'player_1', 1));
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
    const busy = await submit(intent('other', 'player_1'));
    assert.equal(busy.status, 409); assert.equal(busy.body.error.code, 'ROUND_IN_PROGRESS');
    pass('HTTP/gRPC share identity, concurrent deduplication and player guard');

    // No client read/WS is connected while the service's completion becomes due.
    await delay(s.roundDelayMs + 2100);
    const completed = await complete(id); valid(completed);
    assert.ok(Date.parse(completed.completedAt) <= Date.parse(completed.createdAt) + s.roundDelayMs + 2000,
      'completion must run on time without a connected/read-requesting client');
    assert.equal((await submit(intent('first', 'player_1'))).body.roundId, id);
    assert.equal((await s.rpc('getRound', { roundId: id })).completedAt, completed.completedAt);
    pass('authoritative result, no premature disclosure and autonomous completion');

    const events = (await history(0)).events;
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.type), ['round.accepted', 'round.completed']);
    assert.deepEqual(events.map(e => e.sequence), [1, 2]);
    assert.equal(events[0].round.status, 'accepted'); valid(events[0].round);
    assert.deepEqual(events[1].round, completed);
    const p1 = (await s.api('/events?after=0&limit=1')).body;
    const p2 = (await s.rpc('listEvents', { after: p1.nextCursor, limit: 1 }));
    assert.equal(p2.events[0].sequence, 2);
    assert.equal((await history(2)).nextCursor, 2);
    assert.deepEqual((await history(2)).events, []);
    pass('immutable snapshots, durable ordered events and cursor pagination');

    for (const body of [{}, intent('', 'x'), intent('x', '', 0), intent('x', 'x', 3),
      { ...intent('x'), extra: true }, { ...intent('x'), choice: 0.5 }]) {
      assert.equal((await submit(body)).status, 400);
    }
    assert.equal((await submit({ ...intent('big'), padding: 'x'.repeat(9000) })).status, 413);
    assert.equal((await s.api('/rounds', { method: 'POST', body: intent('wrong'), headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await s.api('/rounds/missing')).status, 404);
    assert.equal((await s.api('/unknown')).status, 404);
    assert.equal((await s.api('/health', { method: 'POST', body: {} })).status, 405);
    for (const query of ['after=-1', 'after=abc', 'after=1.2', 'limit=0', 'limit=101']) {
      const r = await s.api('/events?' + query);
      assert.equal(r.status, 400); assert.equal(r.body.error.code, 'INVALID_CURSOR');
    }
    await assert.rejects(s.rpc('startRound', intent('grpc_bad', 'p', 4)), e => e.code === grpc.status.INVALID_ARGUMENT);
    await assert.rejects(s.rpc('getRound', { roundId: 'missing' }), e => e.code === grpc.status.NOT_FOUND);
    await assert.rejects(s.rpc('startRound', intent('first', 'player_1', 2)), e => e.code === grpc.status.ALREADY_EXISTS);
    assert.equal((await history(0)).events.length, 2);
    pass('HTTP/gRPC validation and errors create no extra state');

    const feed = await s.stream(0);
    await waitFor(() => feed.events().length === 2, 'WS historical events');
    assert.deepEqual(feed.events(), events);
    const live = await submit(intent('live'));
    await complete(live.body.roundId);
    await waitFor(() => feed.events().length === 4, 'WS live events');
    assert.deepEqual(feed.events().map(e => e.sequence), [1, 2, 3, 4]);
    const cursor = feed.events().at(-1).sequence;
    feed.close();
    const offline = await submit(intent('offline'));
    await complete(offline.body.roundId);
    const resumed = await s.stream(cursor);
    await waitFor(() => resumed.events().length === 2, 'WS disconnected interval replay');
    assert.deepEqual(resumed.events().map(e => e.sequence), [5, 6]);
    resumed.close();
    pass('WS backlog, live delivery and reconnect without gaps/duplicates');

    const invalidSocket = await s.stream('-1');
    await waitFor(() => invalidSocket.closeCode === 1008, 'invalid cursor close');
    const oversized = await s.stream(6);
    oversized.socket.send('x'.repeat(4097));
    await waitFor(() => oversized.closeCode === 1009, 'oversize frame close');
    pass('WS invalid cursors and bounded incoming messages');

    const stableHistory = (await history(0)).events;
    const pending = await submit(intent('restart'));
    assert.equal(pending.status, 202); assert.equal(pending.body.status, 'accepted'); valid(pending.body);
    await s.stop(true);
    await delay(s.roundDelayMs + 50);
    await s.start();
    const recovered = await complete(pending.body.roundId); valid(recovered);
    assert.equal(recovered.createdAt, pending.body.createdAt);
    assert.equal((await submit(intent('restart'))).body.roundId, recovered.roundId);
    assert.deepEqual(await s.rpc('getRound', { roundId: id }), completed);
    const recoveredHistory = (await history(0)).events;
    assert.deepEqual(recoveredHistory.slice(0, stableHistory.length), stableHistory);
    assert.equal(recoveredHistory.filter(e => e.round.roundId === recovered.roundId).length, 2);
    const afterRestart = await s.stream(6);
    await waitFor(() => afterRestart.events().length === 2, 'restart WS replay');
    afterRestart.close();
    pass('abrupt restart recovers pending work and preserves results/history');

    const raceFeedPromise = s.stream(0);
    const distinct = await Promise.all(Array.from({ length: 10 }, (_, i) => submit(intent('batch_' + i, 'batch_player_' + i, i % 3))));
    const raceFeed = await raceFeedPromise;
    assert.ok(distinct.every(r => r.status === 202));
    assert.equal(new Set(distinct.map(r => r.body.roundId)).size, 10);
    await Promise.all(distinct.map(async r => valid(await complete(r.body.roundId))));
    const final = (await history(0)).events;
    assert.deepEqual(final.map(e => e.sequence), final.map((_, i) => i + 1));
    for (const r of distinct) assert.equal(final.filter(e => e.round.roundId === r.body.roundId).length, 2);
    await waitFor(() => raceFeed.events().length === final.length, 'WS catch-up/live boundary');
    assert.deepEqual(raceFeed.events(), final);
    raceFeed.close();
    pass('independent players and WS catch-up/live boundary preserve all events');
    return passed;
  } finally { await s.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runChecks({ starter: process.argv.includes('--starter') }).then(n => {
    console.log(`${n} acceptance groups passed.`);
  }).catch(error => { console.error(error.stack); process.exitCode = 1; });
}

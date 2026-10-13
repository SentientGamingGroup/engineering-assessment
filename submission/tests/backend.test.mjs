// Backend failure-mode tests. Reuses the maintainers' process harness
// (scripts/support.mjs, unchanged): real child process, real HTTP/gRPC/WS,
// SIGKILL for crashes — the same conditions scripts/check.mjs exercises.
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSystem, waitFor } from '../../scripts/support.mjs';

const intent = (requestId, playerId, choice) => ({ requestId, playerId, choice });
const completed = (s, roundId) => waitFor(async () => {
  const round = await s.rpc('getRound', { roundId });
  return round.status === 'completed' && round;
}, `completion of ${roundId}`);

test('crash/concurrency: concurrent duplicates make one round; SIGKILL recovery completes it exactly once', async () => {
  const s = await createSystem({});
  try {
    await s.start();
    // 20 concurrent duplicates, alternating HTTP and raw gRPC.
    const payload = intent('dup_intent', 'crash_player', 1);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => i % 2
      ? s.rpc('startRound', payload)
      : s.api('/rounds', { method: 'POST', body: payload }).then(r => {
          assert.equal(r.status, 202);
          return r.body;
        })));
    const ids = new Set(results.map(round => round.roundId));
    assert.equal(ids.size, 1, 'concurrent duplicates must share one round');
    const [roundId] = ids;
    const { createdAt } = results[0];

    // Abrupt termination, overdue while down, then recovery with the same DATA_DIR.
    await s.stop(true);
    await delay(s.roundDelayMs + 100);
    await s.start();
    const recovered = await completed(s, roundId);
    assert.equal(recovered.createdAt, createdAt, 'identity/timestamps survive the crash');
    assert.ok(Date.parse(recovered.completedAt) - Date.parse(recovered.createdAt) >= s.roundDelayMs);

    // Duplicate completion guard: another crash cycle must not complete it again.
    await s.stop(true);
    await s.start();
    assert.deepEqual(await s.rpc('getRound', { roundId }), recovered, 'completed rounds are immutable');
    const { events } = (await s.api('/events?after=0&limit=100')).body;
    assert.equal(events.filter(e => e.round.roundId === roundId && e.type === 'round.completed').length, 1);
    assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1), 'no sequence gaps or repeats');
    // Same requestId after completion still resolves to the original round.
    assert.equal((await s.api('/rounds', { method: 'POST', body: payload })).body.roundId, roundId);
  } finally { await s.close(); }
});

test('reconnect: resuming after the last applied cursor replays the missed interval without gaps or duplicates', async () => {
  const s = await createSystem({});
  try {
    await s.start();
    const first = await s.api('/rounds', { method: 'POST', body: intent('ws_a', 'ws_p1', 0) });
    assert.equal(first.status, 202);
    const feed = await s.stream(0);
    await completed(s, first.body.roundId);
    await waitFor(() => feed.events().length === 2, 'backfill plus live completion');
    const cursor = feed.events().at(-1).sequence;
    feed.close();

    // Events produced while disconnected.
    const second = await s.api('/rounds', { method: 'POST', body: intent('ws_b', 'ws_p2', 1) });
    await completed(s, second.body.roundId);

    const resumed = await s.stream(cursor);
    await waitFor(() => resumed.events().length === 2, 'disconnected interval replay');
    assert.deepEqual(resumed.events().map(e => e.sequence), [cursor + 1, cursor + 2]);
    assert.ok(resumed.events().every(e => e.round.roundId === second.body.roundId));
    resumed.close();
  } finally { await s.close(); }
});

test('crash: a torn final log line is cut off so later appends and restarts stay readable', async () => {
  const s = await createSystem({});
  try {
    await s.start();
    const first = await s.api('/rounds', { method: 'POST', body: intent('torn_a', 'torn_p', 0) });
    await completed(s, first.body.roundId);
    await s.stop(true);
    // Simulate SIGKILL mid-append: an unacknowledged, half-written event.
    await appendFile(join(s.dataDir, 'events.jsonl'), '{"sequence":3,"type":"round.acc');
    await s.start();
    const second = await s.api('/rounds', { method: 'POST', body: intent('torn_b', 'torn_p', 1) });
    assert.equal(second.status, 202);
    await completed(s, second.body.roundId);
    // A second restart must not see the fragment as mid-file corruption.
    await s.stop(true);
    await s.start();
    const { events } = (await s.api('/events?after=0&limit=100')).body;
    assert.deepEqual(events.map(e => e.sequence), [1, 2, 3, 4]);
    assert.equal((await s.api(`/rounds/${second.body.roundId}`)).body.status, 'completed');
  } finally { await s.close(); }
});

test('validation: a malformed round-id escape is a 404, not a server error', async () => {
  const s = await createSystem({});
  try {
    await s.start();
    const response = await fetch(`${s.apiUrl}/rounds/%E0`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'ROUND_NOT_FOUND');
  } finally { await s.close(); }
});

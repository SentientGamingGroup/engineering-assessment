// End-to-end crash/concurrency test against the real launcher, gateway and Go
// service, using the supplied harness (temporary ports and DATA_DIR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystem, waitFor } from '../scripts/support.mjs';

test('SIGKILL with pending rounds: every round completes exactly once, feed has no gaps', { timeout: 120000 }, async () => {
  const s = await createSystem({ roundDelayMs: 1500 });
  try {
    await s.start();
    const submit = body => s.api('/rounds', { method: 'POST', body });
    // 10 players race, each also sending a duplicate of its own request.
    const intents = Array.from({ length: 10 }, (_, i) => ({ requestId: `crash_${i}`, playerId: `crash_p${i}`, choice: i % 3 }));
    const replies = await Promise.all(intents.flatMap(intent => [submit(intent), submit(intent)]));
    assert.ok(replies.every(r => r.status === 202));
    const ids = new Set(replies.map(r => r.body.roundId));
    assert.equal(ids.size, 10, 'duplicates must not create extra rounds');

    await s.stop(true); // SIGKILL while every round is still pending
    await s.start();

    // The same requestIds still resolve to the same rounds after the crash.
    const again = await Promise.all(intents.map(submit));
    assert.deepEqual(new Set(again.map(r => r.body.roundId)), ids);

    const feed = await s.stream(0);
    await waitFor(() => feed.events().length === 20, 'all accepted+completed events over WS', 15000);
    const events = feed.events();
    assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1), 'no gaps or repeats');
    for (const id of ids) {
      const types = events.filter(e => e.round.roundId === id).map(e => e.type);
      assert.deepEqual(types, ['round.accepted', 'round.completed'], `exactly one completion for ${id}`);
    }
    // Reconnect from a mid-history cursor resumes exactly where it left off.
    const resumed = await s.stream(7);
    await waitFor(() => resumed.events().length === 13, 'resume from cursor 7');
    assert.deepEqual(resumed.events(), events.slice(7));
  } finally {
    await s.close();
  }
});

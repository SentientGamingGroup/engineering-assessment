// Whole system via start.mjs: real process, real ports, SIGKILL crashes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystem, waitFor } from '../../../scripts/support.mjs';

const intent = (requestId, playerId = requestId, choice = 0) => ({ requestId, playerId, choice });

test('SIGKILL right after acceptance: same round completes once after restart; WS resumes without gaps', async t => {
  const s = await createSystem({ roundDelayMs: 600 });
  t.after(() => s.close());
  await s.start();
  const feed = await s.stream(0);
  const accepted = await s.api('/rounds', { method: 'POST', body: intent('crash', 'p1', 1) });
  assert.equal(accepted.status, 202);
  await waitFor(() => feed.events().length === 1, 'accepted event over WS');
  const cursor = feed.events().at(-1).sequence;
  await s.stop(true); // abrupt: no shutdown hooks run

  // Retrying the same intent while the service is down is an unknown outcome, not a new round.
  await s.start();
  const retry = await s.api('/rounds', { method: 'POST', body: intent('crash', 'p1', 1) });
  assert.equal(retry.body.roundId, accepted.body.roundId);
  assert.equal(retry.body.createdAt, accepted.body.createdAt);

  const resumed = await s.stream(cursor);
  await waitFor(() => resumed.events().length === 1, 'completion after restart');
  const [completed] = resumed.events();
  assert.equal(completed.sequence, cursor + 1);
  assert.equal(completed.type, 'round.completed');
  assert.equal(completed.round.roundId, accepted.body.roundId);

  // Another crash after completion must not complete it again.
  await s.stop(true);
  await s.start();
  const history = (await s.api('/events?after=0')).body.events;
  assert.deepEqual(history.map(e => e.type), ['round.accepted', 'round.completed']);
});

test('HTTP edge cases: malformed vs unknown round IDs, oversize body, duplicate + conflict over HTTP', async t => {
  const s = await createSystem({ roundDelayMs: 300 });
  t.after(() => s.close());
  await s.start();
  assert.equal((await s.api('/rounds/%E0%A4%A')).status, 400); // undecodable
  assert.equal((await s.api('/rounds/a%20b')).body.error.code, 'INVALID_REQUEST'); // decodes to an invalid ID
  assert.equal((await s.api('/rounds/unknown_round')).body.error.code, 'ROUND_NOT_FOUND');
  assert.equal((await s.api('/rounds', { method: 'POST', body: { ...intent('big'), pad: 'x'.repeat(10_000) } })).status, 413);
  const a = await s.api('/rounds', { method: 'POST', body: intent('h1', 'hp') });
  const b = await s.api('/rounds', { method: 'POST', body: intent('h1', 'hp') });
  assert.equal(a.body.roundId, b.body.roundId);
  const conflict = await s.api('/rounds', { method: 'POST', body: intent('h1', 'other') });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await s.api('/events')).body.events.length, 1);
});

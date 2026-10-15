// Shared validators: the same rules back HTTP and gRPC, with the contract's differences.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isStartRoundBody, normalizeListEvents, normalizeStartRound, parseCursor, parseEventsQuery,
} from '../../server/common/validation.mjs';

test('HTTP body needs exactly requestId, playerId and an explicit integer choice', () => {
  assert.ok(isStartRoundBody({ requestId: 'a', playerId: 'b', choice: 2 }));
  for (const body of [null, [], {}, { requestId: 'a', playerId: 'b' }, { requestId: 'a', playerId: 'b', choice: 3 },
    { requestId: 'a', playerId: 'b', choice: 0.5 }, { requestId: 'a', playerId: 'b', choice: 0, extra: 1 },
    { requestId: '', playerId: 'b', choice: 0 }, { requestId: 'a b', playerId: 'b', choice: 0 }]) {
    assert.equal(isStartRoundBody(body), false, JSON.stringify(body));
  }
});

test('gRPC start: omitted choice means 0; IDs are still required', () => {
  assert.deepEqual(normalizeStartRound({ requestId: 'a', playerId: 'b' }), { requestId: 'a', playerId: 'b', choice: 0 });
  assert.equal(normalizeStartRound({ requestId: 'a' }), null);
  assert.equal(normalizeStartRound({ requestId: 'a', playerId: 'b', choice: 4 }), null);
});

test('cursors: gRPC limit 0 = default, HTTP limit 0 = invalid, uint32 bounds', () => {
  assert.deepEqual(normalizeListEvents({ after: 5, limit: 0 }), { after: 5, limit: 100 });
  assert.equal(normalizeListEvents({ limit: 101 }), null);
  const q = value => parseEventsQuery(new URLSearchParams(value));
  assert.deepEqual(q(''), { after: 0, limit: 100 });
  for (const bad of ['limit=0', 'limit=101', 'after=-1', 'after=1.2', 'after=abc', 'after=4294967296']) assert.equal(q(bad), null, bad);
  assert.equal(parseCursor('4294967295'), 4294967295);
  assert.equal(parseCursor('-1'), null);
  assert.equal(parseCursor(), 0);
});

// Exact contract edges (docs/API.md) against the real process: HTTP body and
// media-type boundaries, validation that creates no state, gRPC defaults and
// status details, zero-valued fields on the wire, and the player guard.
import assert from 'node:assert/strict';
import test from 'node:test';
import { grpc } from '../../lib/grpc.mjs';
import { createSystem, waitFor } from '../../scripts/support.mjs';

const intent = (requestId, playerId, choice) => ({ requestId, playerId, choice });
const raw = (s, path, { method = 'POST', body, type = 'application/json' } = {}) =>
  fetch(s.apiUrl + path, { method, headers: type ? { 'Content-Type': type } : {}, body })
    .then(async r => ({ status: r.status, body: await r.json() }));
// Pad valid JSON with trailing whitespace to an exact byte length.
const padded = (payload, bytes) => {
  const json = JSON.stringify(payload);
  return json + ' '.repeat(bytes - Buffer.byteLength(json));
};
const allEvents = async s => (await s.api('/events?after=0&limit=100')).body.events;

test('HTTP: exact 8192-byte limit, charset media type, and invalid input that creates no state', async () => {
  const s = await createSystem({});
  try {
    await s.start();
    const atLimit = await raw(s, '/rounds', {
      body: padded(intent('edge_ok', 'edge_p1', 1), 8192), type: 'application/json; charset=utf-8',
    });
    assert.equal(atLimit.status, 202, '8192 bytes with a charset parameter is accepted');
    const overLimit = await raw(s, '/rounds', { body: padded(intent('edge_big', 'edge_p2', 1), 8193) });
    assert.equal(overLimit.status, 413);
    assert.equal(overLimit.body.error.code, 'BODY_TOO_LARGE');

    const invalid = [
      '{"requestId":"a","playerId":"b","choice":"1"}',
      '{"requestId":"a","playerId":"b","choice":true}',
      '{"requestId":"a","playerId":"b","choice":null}',
      '{"requestId":"a","playerId":"b","choice":-1}',
      '{"requestId":"a","playerId":"b"}',
      `{"requestId":"${'a'.repeat(65)}","playerId":"b","choice":0}`,
      '{"requestId":"a!","playerId":"b","choice":0}',
      '{"requestId":1,"playerId":"b","choice":0}',
      '[]', 'null', '"text"', '{not json',
    ];
    for (const body of invalid) {
      const r = await raw(s, '/rounds', { body });
      assert.equal(r.status, 400, body);
      assert.equal(r.body.error.code, 'INVALID_REQUEST', body);
    }
    assert.equal((await raw(s, '/rounds', { body: '{}', type: null })).status, 415);
    assert.equal((await raw(s, '/rounds', { body: '{}', type: 'text/json' })).status, 415);

    assert.equal((await s.api('/rounds')).status, 405);
    assert.equal((await s.api('/events', { method: 'POST', body: {} })).status, 405);
    assert.equal((await s.api('/rounds/x', { method: 'DELETE' })).body.error.code, 'METHOD_NOT_ALLOWED');

    // Only the one valid round exists; nothing above created state.
    const events = await allEvents(s);
    assert.equal(events.filter(e => e.type === 'round.accepted').length, 1);
    assert.equal(events[0].round.requestId, 'edge_ok');

    // Cursor edges: an empty page echoes the cursor (including zero); uint32 overflow is invalid.
    assert.deepEqual((await s.api('/events?after=999')).body, { events: [], nextCursor: 999 });
    assert.equal((await s.api('/events?after=4294967296')).body.error.code, 'INVALID_CURSOR');
    assert.equal((await s.api('/events?limit=')).body.error.code, 'INVALID_CURSOR');
  } finally { await s.close(); }
});

test('gRPC: omitted choice and limit use protobuf defaults; errors carry exact status and details', async () => {
  const s = await createSystem({});
  try {
    await s.start();
    // Omitted choice is protobuf's default 0 (valid) and stays visible as 0 over HTTP.
    const round = await s.rpc('startRound', { requestId: 'g_default', playerId: 'g_p1' });
    const viaHttp = (await s.api(`/rounds/${round.roundId}`)).body;
    assert.equal(viaHttp.choice, 0);
    assert.deepEqual(Object.keys(viaHttp).sort(),
      ['choice', 'createdAt', 'playerId', 'requestId', 'roundId', 'status']);

    // limit=0 means the default page; >100 is invalid.
    assert.equal((await s.rpc('listEvents', { after: 0, limit: 0 })).events.length, 1);
    const rejects = (method, body, code, details) => assert.rejects(s.rpc(method, body),
      e => e.code === code && e.details === details);
    await rejects('listEvents', { after: 0, limit: 101 }, grpc.status.INVALID_ARGUMENT, 'INVALID_CURSOR');
    await rejects('startRound', { requestId: 'g_x', playerId: '' }, grpc.status.INVALID_ARGUMENT, 'INVALID_REQUEST');
    await rejects('startRound', { requestId: 'g_x', playerId: 'p', choice: 3 }, grpc.status.INVALID_ARGUMENT, 'INVALID_REQUEST');
    await rejects('getRound', { roundId: 'nope' }, grpc.status.NOT_FOUND, 'ROUND_NOT_FOUND');
    await rejects('startRound', { requestId: 'g_default', playerId: 'g_p1', choice: 2 }, grpc.status.ALREADY_EXISTS, 'IDEMPOTENCY_CONFLICT');
    await rejects('startRound', { requestId: 'g_other', playerId: 'g_p1', choice: 1 }, grpc.status.FAILED_PRECONDITION, 'ROUND_IN_PROGRESS');

    // Completed rounds keep zero-valued target/score fields on both interfaces.
    const done = await waitFor(async () => {
      const r = await s.rpc('getRound', { roundId: round.roundId });
      return r.status === 'completed' && r;
    }, 'completion');
    const doneHttp = (await s.api(`/rounds/${round.roundId}`)).body;
    for (const r of [done, doneHttp]) {
      assert.ok(Number.isInteger(r.target) && Number.isInteger(r.score), 'target/score present even when 0');
      assert.equal(r.score, r.choice === r.target ? 1 : 0);
    }
  } finally { await s.close(); }
});

test('player guard: requestId is resolved before the guard; 10 players proceed independently', async () => {
  const s = await createSystem({});
  try {
    await s.start();
    const first = await s.api('/rounds', { method: 'POST', body: intent('guard_a', 'guard_p', 2) });
    assert.equal(first.status, 202);
    // The busy player retrying its OWN request gets the original round, not ROUND_IN_PROGRESS.
    const retry = await s.api('/rounds', { method: 'POST', body: intent('guard_a', 'guard_p', 2) });
    assert.equal(retry.status, 202);
    assert.equal(retry.body.roundId, first.body.roundId);
    const busy = await s.api('/rounds', { method: 'POST', body: intent('guard_b', 'guard_p', 2) });
    assert.equal(busy.body.error.code, 'ROUND_IN_PROGRESS');

    const players = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      s.api('/rounds', { method: 'POST', body: intent(`multi_${i}`, `multi_p${i}`, i % 3) })));
    assert.ok(players.every(r => r.status === 202));
    assert.equal(new Set(players.map(r => r.body.roundId)).size, 10);

    // Once the busy player's round completes, it may start another.
    await waitFor(async () => (await s.rpc('getRound', { roundId: first.body.roundId })).status === 'completed', 'guard completion');
    assert.equal((await s.api('/rounds', { method: 'POST', body: intent('guard_c', 'guard_p', 0) })).status, 202);
  } finally { await s.close(); }
});

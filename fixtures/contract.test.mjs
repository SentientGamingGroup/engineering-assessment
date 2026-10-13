// Maintainer checks for wire bindings/scaffolding, not candidate domain behavior.
import assert from 'node:assert/strict';
import test from 'node:test';
import { grpc, listenGrpc, createClient, call } from '../lib/grpc.mjs';
import { createGateway } from '../submission/gateway.mjs';
import { request } from '../scripts/support.mjs';

async function fixture(handlers, run) {
  const server = await listenGrpc({
    health: (_c, cb) => cb(null, { ok: true }), ...handlers,
  }, 0);
  const client = createClient(server.boundPort);
  try { await run(client); } finally { client.close(); server.forceShutdown(); }
}
test('real gRPC health and unimplemented domain methods', async () => fixture({}, async client => {
  assert.deepEqual(await call(client, 'health', {}), { ok: true });
  await assert.rejects(call(client, 'startRound', {}), e => e.code === grpc.status.UNIMPLEMENTED);
}));
test('wire preserves zero result fields and omits pending result fields', async () => fixture({
  getRound: (c, cb) => cb(null, c.request.roundId === 'completed'
    ? { roundId: 'completed', status: 'completed', choice: 0, target: 0, score: 0 }
    : { roundId: 'pending', status: 'accepted', choice: 0 }),
}, async client => {
  const pending = await call(client, 'getRound', { roundId: 'pending' });
  assert.equal(pending.choice, 0); assert.ok(!('target' in pending)); assert.ok(!('score' in pending));
  const completed = await call(client, 'getRound', { roundId: 'completed' });
  assert.equal(completed.target, 0); assert.equal(completed.score, 0);
}));
test('gRPC call helper imposes a deadline', async () => fixture({
  getRound: (_c, cb) => { const timer = setTimeout(() => cb(null, { roundId: 'late' }), 150); timer.unref(); },
}, async client => {
  await assert.rejects(call(client, 'getRound', { roundId: 'late' }, 25),
    e => e.code === grpc.status.DEADLINE_EXCEEDED);
}));
test('HTTP gateway maps conflicts and validates before gRPC', async () => fixture({
  startRound: (_c, cb) => cb({ code: grpc.status.ALREADY_EXISTS, details: 'IDEMPOTENCY_CONFLICT' }),
}, async client => {
  const gateway = createGateway(client);
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  try {
    const conflict = await request(base, '/rounds', { method: 'POST', body: { requestId: 'a', playerId: 'b', choice: 0 } });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await request(base, '/rounds', { method: 'POST', body: { choice: 0 } })).status, 400);
    assert.equal((await request(base, '/events?limit=0')).status, 400);
  } finally { gateway.stopStream(); gateway.closeAllConnections(); await new Promise(r => gateway.close(r)); }
}));

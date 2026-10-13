import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystem } from '../../scripts/support.mjs';
import { grpc } from '../../lib/grpc.mjs';

test('HTTP rejects malformed input without state changes and enforces the exact byte limit', async () => {
  const system = await createSystem({ roundDelayMs: 100 });
  try {
    await system.start();
    for (const body of [
      '{',
      'null',
      '42',
      '[]',
      '{"requestId":"a","playerId":"b"}',
      '{"requestId":"a","playerId":"b","choice":true}',
    ]) {
      const response = await fetch(system.apiUrl + '/rounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: { code: 'INVALID_REQUEST' },
      });
    }
    for (const path of ['/rounds/%ZZ', '/rounds/%20']) {
      const response = await system.api(path);
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'INVALID_REQUEST');
    }
    for (const payload of [
      { requestId: 'bad', playerId: '', choice: 0 },
      { requestId: 'bad', playerId: 'p', choice: 3 },
    ]) {
      await assert.rejects(
        system.rpc('startRound', payload),
        (error) =>
          error.code === grpc.status.INVALID_ARGUMENT &&
          error.details === 'INVALID_REQUEST',
      );
    }
    await assert.rejects(
      system.rpc('listEvents', { limit: 101 }),
      (error) =>
        error.code === grpc.status.INVALID_ARGUMENT &&
        error.details === 'INVALID_CURSOR',
    );
    assert.deepEqual((await system.rpc('listEvents', {})).events ?? [], []);
    const json = JSON.stringify({
      requestId: 'boundary',
      playerId: 'boundary',
      choice: 0,
    });
    for (const [size, status] of [
      [8193, 413],
      [8192, 202],
    ]) {
      const response = await fetch(system.apiUrl + '/rounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: json.padEnd(size, ' '),
      });
      assert.equal(response.status, status);
      if (status === 202) {
        const round = await response.json();
        assert.equal(round.choice, 0);
        assert.equal(round.status, 'accepted');
        assert.equal('target' in round, false);
        assert.equal('score' in round, false);
      }
    }
    const defaults = await system.rpc('startRound', {
      requestId: 'grpc_default',
      playerId: 'grpc_default',
      target: 2,
      score: 1,
    });
    assert.equal(defaults.choice, 0);
    assert.equal('target' in defaults, false);
    assert.equal('score' in defaults, false);
  } finally {
    await system.close();
  }
});

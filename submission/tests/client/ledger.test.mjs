// Score ledger: unique completed rounds only.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as S from '../../client/core/ledger.mjs';

test('score counts unique completed rounds; redelivery, replays and stale events cannot inflate it', () => {
  const me = 'p1';
  const completed = (sequence, roundId, score, playerId = me) =>
    ({ sequence, type: 'round.completed', round: { roundId, playerId, score, status: 'completed' } });
  let ledger = S.createLedger();
  for (const e of [completed(1, 'a', 1), completed(2, 'b', 0), completed(3, 'c', 1, 'someone-else')]) {
    ledger = S.applyEvent(ledger, e, me).ledger;
  }
  assert.equal(S.scoreOf(ledger), 1);
  // Reconnect backfill redelivers old events: ignored by cursor.
  const again = S.applyEvent(ledger, completed(1, 'a', 1), me);
  assert.equal(again.applied, false);
  // The same round reported by HTTP reconciliation is not double counted.
  ledger = S.recordCompleted(ledger, { roundId: 'a', playerId: me, score: 1, status: 'completed' }, me);
  assert.equal(S.scoreOf(ledger), 1);
  assert.equal(S.scoreOf(ledger, 'a'), 0, 'current round point hidden until revealed');
  assert.equal(ledger.cursor, 3);
  ledger = S.recordCompleted(ledger, { roundId: 'd', playerId: me, score: 1, status: 'completed' }, me);
  assert.deepEqual(S.statsOf(ledger), { score: 2, rounds: 3, streak: 1 });
});

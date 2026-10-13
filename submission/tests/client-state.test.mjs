// Client state-machine tests: pure module, no DOM or network needed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame } from '../client/state.mjs';

const ME = 'player_me';
const accepted = (over = {}) => ({
  roundId: 'r1', requestId: 'q1', playerId: ME, choice: 1,
  status: 'accepted', createdAt: 'T0', ...over,
});
const done = (over = {}) => ({ ...accepted(over), status: 'completed', target: 1, score: 1, completedAt: 'T1', ...over });
const event = (sequence, type, round) => ({ sequence, type, round });

test('double-click guard: a second play() while pending returns null', () => {
  const g = createGame({ playerId: ME });
  assert.equal(g.play('q1'), 'q1');
  assert.equal(g.play('q2'), null);
  assert.equal(g.snapshot().requestId, 'q1');
});

test('completion event reveals the round and scores it exactly once across redelivery', () => {
  const g = createGame({ playerId: ME });
  g.play('q1');
  assert.ok(g.applyEvent(event(1, 'round.accepted', accepted())));
  assert.ok(g.applyEvent(event(2, 'round.completed', done())));
  assert.equal(g.snapshot().phase, 'animating');
  assert.equal(g.snapshot().score, 1);
  // same sequence (cursor guard) and a redelivered copy under a new sequence
  assert.equal(g.applyEvent(event(2, 'round.completed', done())), false);
  assert.ok(g.applyEvent(event(3, 'round.completed', done())));
  assert.equal(g.snapshot().score, 1, 'redelivery must not re-score');
});

test('a non-matching completed round reveals but scores zero', () => {
  const g = createGame({ playerId: ME });
  g.play('q1');
  g.applyEvent(event(1, 'round.accepted', accepted()));
  // choice 1 vs target 2: the server scored it 0
  g.applyEvent(event(2, 'round.completed', done({ target: 2, score: 0 })));
  assert.equal(g.snapshot().phase, 'animating', 'miss still reveals');
  assert.equal(g.snapshot().score, 0, 'miss must not score');
  // a later matching round still counts exactly once
  g.revealed();
  g.newRound();
  g.play('q2');
  g.applyEvent(event(3, 'round.accepted', accepted({ roundId: 'r2', requestId: 'q2' })));
  g.applyEvent(event(4, 'round.completed', done({ roundId: 'r2', requestId: 'q2' })));
  assert.equal(g.snapshot().score, 1);
});

test('replay re-presents the recorded result with no score change', () => {
  const g = createGame({ playerId: ME });
  g.play('q1');
  g.applyEvent(event(1, 'round.accepted', accepted()));
  g.applyEvent(event(2, 'round.completed', done()));
  g.revealed();
  assert.ok(g.replay());
  const s = g.snapshot();
  assert.equal(s.phase, 'animating');
  assert.equal(s.replaying, true);
  assert.equal(s.round.roundId, 'r1');
  g.revealed();
  assert.equal(g.snapshot().score, 1);
});

test('new round returns to idle but never erases score or history', () => {
  const g = createGame({ playerId: ME });
  g.play('q1');
  g.applyEvent(event(1, 'round.accepted', accepted()));
  g.applyEvent(event(2, 'round.completed', done()));
  g.revealed();
  assert.ok(g.newRound());
  const s = g.snapshot();
  assert.equal(s.phase, 'idle');
  assert.equal(s.score, 1);
  assert.ok(s.lastResult);
  assert.equal(s.requestId, null);
});

test('stale replies and stale events cannot replace a newer round', () => {
  const g = createGame({ playerId: ME });
  g.play('q1');
  g.applyEvent(event(1, 'round.accepted', accepted()));
  g.applyEvent(event(2, 'round.completed', done()));
  g.revealed();
  g.newRound();
  g.play('q9');
  // late HTTP reply for the previous intent
  assert.equal(g.reconcile(done({ requestId: 'q1' })), false);
  assert.equal(g.snapshot().phase, 'pending');
  // late accepted event for the previous intent (new sequence, old requestId)
  assert.ok(g.applyEvent(event(3, 'round.accepted', accepted({ roundId: 'r_old', requestId: 'q1' }))));
  assert.equal(g.snapshot().roundId, null, 'old intent must not adopt a round');
});

test('other players only advance the cursor, never the score or phase', () => {
  const g = createGame({ playerId: ME });
  assert.ok(g.applyEvent(event(1, 'round.completed', done({ playerId: 'other', roundId: 'rx', requestId: 'qx' }))));
  const s = g.snapshot();
  assert.equal(s.score, 0);
  assert.equal(s.phase, 'idle');
  assert.equal(s.lastAppliedCursor, 1);
});

test('refresh mid-pending: persisted intent survives and reconciles to a reveal', () => {
  const g = createGame({ playerId: ME });
  g.play('q1');
  g.applyEvent(event(1, 'round.accepted', accepted()));
  const g2 = createGame({ playerId: ME, saved: g.persistable() });
  const s = g2.snapshot();
  assert.equal(s.phase, 'pending');
  assert.equal(s.requestId, 'q1');
  assert.equal(s.lastAppliedCursor, 1);
  assert.ok(g2.reconcile(done()));
  assert.equal(g2.snapshot().phase, 'animating');
  assert.equal(g2.snapshot().score, 1);
});

test('persisted score set survives refresh: reconciling an already-scored round does not re-count', () => {
  const g = createGame({ playerId: ME });
  g.play('q1');
  g.applyEvent(event(1, 'round.completed', done()));
  g.revealed();
  const g2 = createGame({ playerId: ME, saved: g.persistable() });
  assert.equal(g2.snapshot().score, 1);
  // backfill redelivers the same completion under its original sequence: filtered by cursor
  assert.equal(g2.applyEvent(event(1, 'round.completed', done())), false);
  assert.equal(g2.snapshot().score, 1);
});

test('corrupt persisted state falls back to a clean idle game', () => {
  const g = createGame({
    playerId: ME,
    saved: {
      phase: 'revealed',
      lastResult: { bogus: true },     // truthy garbage must not restore "revealed"
      choice: 99,
      score: 'many',
      lastAppliedCursor: -5,           // would make the server close the WS with 1008
      scored: 'not-an-array',
      requestId: 42,
    },
  });
  const s = g.snapshot();
  assert.equal(s.phase, 'idle');
  assert.equal(s.choice, 0);
  assert.equal(s.score, 0);
  assert.equal(s.lastAppliedCursor, 0);
  assert.equal(s.lastResult, null);
  assert.equal(s.requestId, null);
  // and an oversized cursor is equally rejected
  const g2 = createGame({ playerId: ME, saved: { lastAppliedCursor: 4294967296 } });
  assert.equal(g2.snapshot().lastAppliedCursor, 0);
});

test('state-transition errors are rejected', () => {
  const g = createGame({ playerId: ME });
  assert.equal(g.select(5), false, 'out-of-range choice');
  assert.equal(g.replay(), false, 'replay with no recorded result');
  assert.equal(g.revealed(), false, 'reveal outside animating');
  assert.equal(g.requestSkip(), false, 'skip from idle');
  g.play('q1');
  assert.equal(g.select(2), false, 'selection locked while pending');
  assert.equal(g.newRound(), false, 'new round cannot abandon a pending round');
  assert.equal(g.replay(), false, 'replay while pending');
  assert.ok(g.abandon(), 'abandon is the only pending exit without a server result');
  assert.equal(g.snapshot().phase, 'idle');
});

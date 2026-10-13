import assert from 'node:assert/strict';
import test from 'node:test';
import { GameState, TRAVEL_MS } from '../client/model.mjs';
import { AnimationLoop } from '../client/timeline.mjs';

const accepted = (requestId = 'intent_1', playerId = 'player_1') => ({
  roundId: `round_${requestId}`,
  requestId,
  playerId,
  choice: 0,
  status: 'accepted',
  createdAt: '2026-01-01T00:00:00.000Z',
});
const completed = (requestId = 'intent_1') => ({
  ...accepted(requestId),
  status: 'completed',
  target: 0,
  score: 1,
  completedAt: '2026-01-01T00:00:01.200Z',
});
const game = () => new GameState(null, 'player_1');

test('a miss reveals the server target and records a completed round worth zero points', () => {
  const state = game();
  state.begin('intent_1');
  state.applyRound({ ...completed(), target: 2, score: 0 });
  state.tick(TRAVEL_MS);
  assert.equal(state.phase, 'revealed');
  assert.equal(state.round.target, 2);
  assert.equal(state.score, 0);
  assert.equal(state.ledger.size, 1);
  state.replay();
  state.tick(TRAVEL_MS);
  assert.equal(state.score, 0);
  assert.equal(state.ledger.size, 1);
});

test('double clicks retain one intent and selection is locked while unresolved', () => {
  const state = game();
  assert.equal(state.begin('intent_1'), true);
  assert.equal(state.begin('intent_2'), false);
  assert.equal(state.select(2), false);
  assert.equal(state.intent.requestId, 'intent_1');
  assert.equal(state.newRound(), false);
  assert.equal(state.replay(), false);
});
test('pause and pending skip never create an outcome or block server completion', () => {
  const state = game();
  state.begin('intent_1');
  state.applyRound(accepted());
  state.pause();
  state.tick(100000);
  assert.equal(state.round.status, 'accepted');
  assert.equal('target' in state.round, false);
  state.applyRound(completed());
  state.tick(100000);
  assert.equal(state.phase, 'travel');
  assert.equal(state.elapsed, 0);
  assert.equal(state.score, 1);
  state.pause();
  state.tick(TRAVEL_MS);
  assert.equal(state.phase, 'revealed');
  const skipped = game();
  skipped.begin('intent_1');
  skipped.skip();
  assert.equal(skipped.round, null);
  assert.equal(skipped.phase, 'submitting');
  skipped.applyRound(accepted());
  assert.equal(skipped.phase, 'waiting');
  skipped.applyRound(completed());
  assert.equal(skipped.phase, 'revealed');
});
test('duplicate completion and replay cannot increment score or restart a timeline', () => {
  const state = game();
  state.begin('intent_1');
  state.applyRound(completed());
  state.tick(1000);
  state.applyRound(completed());
  assert.equal(state.elapsed, 1000);
  state.tick(TRAVEL_MS);
  assert.equal(state.phase, 'revealed');
  for (let i = 0; i < 3; i++) {
    assert.equal(state.replay(), true);
    state.applyRound(completed());
    state.tick(TRAVEL_MS);
    assert.equal(state.score, 1);
    assert.equal(state.ledger.size, 1);
    assert.equal(state.intent.requestId, 'intent_1');
  }
  state.newRound();
  assert.equal(state.score, 1);
  assert.equal(state.phase, 'select');
});
test('stale accepted/completed replies cannot overwrite a newer round', () => {
  const state = game();
  state.begin('intent_1');
  state.applyRound(completed());
  state.skip();
  state.newRound();
  state.begin('intent_2');
  state.applyRound(accepted('intent_2'));
  state.applyRound(completed('intent_1'));
  state.applyRound(accepted('intent_1'));
  assert.equal(state.round.requestId, 'intent_2');
  assert.equal(state.phase, 'waiting');
  state.applyRound(completed('intent_2'));
  state.applyRound(accepted('intent_2'));
  assert.equal(state.round.status, 'completed');
  assert.equal(state.score, 2);
});
test('global cursor includes other players, ignores duplicates, and detects gaps', () => {
  const state = game();
  state.begin('intent_1');
  state.applyEvent({
    sequence: 1,
    type: 'round.accepted',
    round: accepted('other', 'player_2'),
  });
  state.applyEvent({
    sequence: 2,
    type: 'round.completed',
    round: completed(),
  });
  assert.equal(state.cursor, 2);
  assert.equal(state.score, 1);
  assert.equal(state.applyEvent({ sequence: 2, round: completed() }), false);
  assert.throws(
    () => state.applyEvent({ sequence: 4, round: completed() }),
    /EVENT_GAP/,
  );
  assert.equal(state.cursor, 2);
});
test('refresh preserves pending identity/cursor and the completed-round score ledger', () => {
  const state = game();
  state.begin('intent_1');
  state.applyEvent({ sequence: 1, type: 'round.accepted', round: accepted() });
  const restored = new GameState(
    JSON.parse(JSON.stringify(state.snapshot())),
    'different_player',
  );
  assert.equal(restored.playerId, 'player_1');
  assert.equal(restored.intent.requestId, 'intent_1');
  assert.equal(restored.round.roundId, accepted().roundId);
  assert.equal(restored.cursor, 1);
  restored.applyEvent({
    sequence: 2,
    type: 'round.completed',
    round: completed(),
  });
  const again = new GameState(restored.snapshot(), 'different_player');
  assert.equal(again.phase, 'revealed');
  assert.equal(again.score, 1);
  again.newRound();
  assert.equal(again.score, 1);
  const missingLedger = new GameState(
    { ...again.snapshot(), ledger: null },
    'different_player',
  );
  assert.equal(missingLedger.cursor, 0);
});
test('timeline is independent of frame rate and reduced motion keeps the outcome', () => {
  for (const fps of [30, 60, 144]) {
    const state = game();
    state.begin('intent_1');
    state.applyRound(completed());
    const frames = (fps * TRAVEL_MS) / 1000;
    for (let i = 0; i < Math.ceil(frames) + 1; i++) state.tick(1000 / fps);
    assert.equal(state.phase, 'revealed');
    assert.equal(state.round.target, 0);
  }
  const state = game();
  state.reducedMotion = true;
  state.begin('intent_1');
  state.applyRound(completed());
  state.tick(180);
  assert.equal(state.phase, 'revealed');
  assert.equal(state.score, 1);
});
test('animation owner allows one RAF chain, cleans up, and resumes without a time jump', () => {
  let next = 0;
  const pending = new Map(),
    deltas = [];
  const loop = new AnimationLoop(
    (delta) => {
      deltas.push(delta);
    },
    (callback) => {
      pending.set(++next, callback);
      return next;
    },
    (key) => pending.delete(key),
  );
  function frame(time) {
    const [key, callback] = pending.entries().next().value;
    pending.delete(key);
    callback(time);
  }
  loop.start();
  loop.start();
  assert.equal(pending.size, 1);
  frame(100);
  frame(116);
  assert.deepEqual(deltas, [0, 16]);
  assert.equal(pending.size, 1);
  loop.stop();
  assert.equal(pending.size, 0);
  loop.start();
  frame(50000);
  assert.equal(deltas.at(-1), 0);
  assert.equal(pending.size, 1);
  loop.stop();
  assert.equal(pending.size, 0);
});

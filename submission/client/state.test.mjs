import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, controls, restore, persisted, tick } from './state.mjs';

const ME = 'player_me';
const accepted = { roundId: 'r1', requestId: 'req1', playerId: ME, choice: 2, status: 'accepted', createdAt: 't0' };
const completed = { ...accepted, status: 'completed', target: 2, score: 1, completedAt: 't1' };
const ev = (sequence, type, round) => ({ type: 'event', event: { sequence, type, round } });
const run = (state, ...actions) => actions.reduce(reduce, state);

function playing() {
  return run(initialState(ME), { type: 'select', choice: 2 }, { type: 'play', requestId: 'req1' });
}

test('full timeline: play -> pending -> revealing -> revealed -> replay -> new round', () => {
  let s = playing();
  assert.equal(s.phase, 'submitting');
  s = run(s, { type: 'accepted', round: accepted }, ev(1, 'round.accepted', accepted));
  assert.equal(s.phase, 'pending');
  s = reduce(s, ev(2, 'round.completed', completed));
  assert.equal(s.phase, 'revealing');
  assert.equal(s.score, 1);
  s = reduce(s, { type: 'revealDone' });
  assert.equal(s.phase, 'revealed');
  s = run(s, { type: 'replay' }, { type: 'revealDone' });
  assert.equal(s.phase, 'revealed');
  assert.equal(s.score, 1, 'replay must not change the score');
  s = reduce(s, { type: 'newRound' });
  assert.equal(s.phase, 'idle');
  assert.equal(s.intent, null);
});

test('double click on Play cannot start a second intent', () => {
  const s = run(playing(), { type: 'play', requestId: 'req2' });
  assert.equal(s.intent.requestId, 'req1');
});

test('completion redelivery after reconnect never scores twice', () => {
  let s = run(playing(), ev(1, 'round.accepted', accepted), ev(2, 'round.completed', completed));
  s = run(s, ev(2, 'round.completed', completed), ev(1, 'round.accepted', accepted));
  assert.equal(s.score, 1);
  assert.equal(s.cursor, 2);
  // Same completion under a new sequence (should never happen) is still counted once.
  s = reduce(s, ev(3, 'round.completed', completed));
  assert.equal(s.score, 1);
});

test('late HTTP reply for an old round cannot replace the current one', () => {
  let s = run(playing(), ev(1, 'round.accepted', accepted), ev(2, 'round.completed', completed),
    { type: 'revealDone' }, { type: 'newRound' }, { type: 'play', requestId: 'req2' });
  const before = s;
  s = reduce(s, { type: 'accepted', round: accepted }); // stale reply for req1
  assert.equal(s, before);
  // A late "accepted" snapshot also cannot roll a completed round backwards.
  let t = run(playing(), { type: 'accepted', round: completed });
  t = reduce(t, { type: 'snapshot', round: accepted });
  assert.equal(t.round.status, 'completed');
});

test('skip while pending waits for the server, then reveals instantly', () => {
  let s = run(playing(), { type: 'accepted', round: accepted }, { type: 'skip' });
  assert.equal(s.phase, 'pending', 'skip must not invent a result');
  s = reduce(s, ev(2, 'round.completed', completed));
  assert.equal(s.phase, 'revealed');
});

test('other players count toward nothing; their events still advance the cursor', () => {
  const theirs = { ...completed, roundId: 'r9', requestId: 'x', playerId: 'someone' };
  const s = reduce(playing(), ev(5, 'round.completed', theirs));
  assert.equal(s.score, 0);
  assert.equal(s.cursor, 5);
  assert.equal(s.phase, 'submitting');
});

test('choice 0 omitted by proto3 is restored', () => {
  const zero = { ...completed, choice: undefined, target: 0 };
  const s = run(initialState(ME), { type: 'play', requestId: 'req1' }, { type: 'accepted', round: zero });
  assert.equal(s.round.choice, 0);
});

test('refresh mid-round resumes the same intent and reconciles', () => {
  const s = run(playing(), { type: 'accepted', round: accepted });
  const restored = restore(JSON.parse(JSON.stringify(persisted(s))), ME);
  assert.equal(restored.phase, 'submitting');
  assert.equal(restored.intent.requestId, 'req1', 'same requestId so the server dedups');
  assert.equal(restored.round.roundId, 'r1', 'round is retained across refresh');
});

test('controls and pause are presentation-only and state-appropriate', () => {
  assert.deepEqual(controls(initialState(ME)), { select: true, play: true, pause: false, skip: false, replay: false, newRound: false });
  const s = run(playing(), { type: 'accepted', round: accepted }, { type: 'pause' });
  assert.equal(s.paused, true);
  assert.equal(controls(s).play, false);
  assert.equal(tick(1000, 16, true), 1000, 'paused clock does not advance');
  assert.equal(tick(1000, 60000, false), 1100, 'background-tab gap is clamped');
});

test('a miss scores 0 and stays 0 across replay, redelivery and refresh', () => {
  const missed = { ...completed, target: 0, score: 0 }; // chose 2, server target 0
  let s = run(playing(), { type: 'accepted', round: accepted }, ev(1, 'round.accepted', accepted),
    ev(2, 'round.completed', missed), { type: 'revealDone' });
  assert.equal(s.score, 0, 'a completed miss must not add a point');
  s = run(s, { type: 'replay' }, { type: 'revealDone' }, ev(2, 'round.completed', missed));
  assert.equal(s.score, 0);
  s = restore(JSON.parse(JSON.stringify(persisted(s))), ME);
  assert.equal(s.phase, 'revealed');
  assert.equal(s.score, 0);
  // Then a win on the next round adds exactly the server-awarded point.
  const win = { ...completed, roundId: 'r2', requestId: 'req2', choice: 1, target: 1, score: 1 };
  s = run(s, { type: 'newRound' }, { type: 'select', choice: 1 }, { type: 'play', requestId: 'req2' },
    ev(3, 'round.accepted', { ...win, status: 'accepted' }), ev(4, 'round.completed', win));
  assert.equal(s.score, 1);
});

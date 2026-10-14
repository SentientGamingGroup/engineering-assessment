// Client state (RoundState): transitions, stale/duplicate/gapped events, late replies,
// redelivery scoring, refresh restore and the per-intent idempotency key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoundState } from '../client/RoundState.ts';

const ids = () => { let n = 0; return prefix => `${prefix}_${++n}`; };
const fresh = () => RoundState.restore(null, ids());
const snapshot = (state, round, status, extra = {}) => ({
  roundId: round, requestId: state.round.requestId, playerId: state.playerId, choice: state.round.choice,
  status, createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const completed = (state, round, target) => snapshot(state, round, 'completed', {
  target, score: state.round.choice === target ? 1 : 0, completedAt: '2026-01-01T00:00:01.000Z',
});
const event = (sequence, round) => ({ sequence, type: `round.${round.status}`, round });

test('a round walks idle -> submitting -> pending -> completed -> idle', () => {
  const s = fresh();
  assert.equal(s.phase, 'idle');
  assert.ok(s.select(2));
  assert.ok(s.play());
  assert.equal(s.phase, 'submitting');
  assert.ok(s.applyRound(snapshot(s, 'R1', 'accepted')));
  assert.equal(s.phase, 'pending');
  assert.ok(s.applyRound(completed(s, 'R1', 2)));
  assert.equal(s.phase, 'completed');
  assert.equal(s.score, 1);
  assert.ok(s.newRound());
  assert.equal(s.phase, 'idle');
  assert.equal(s.score, 1, 'a visual reset keeps the score');
});

test('illegal transitions are ignored', () => {
  const s = fresh();
  assert.equal(s.newRound(), false, 'New Round while idle');
  s.play();
  const key = s.round.requestId;
  assert.equal(s.play(), false, 'second Play while submitting (double click)');
  assert.equal(s.round.requestId, key);
  assert.equal(s.select(1), false, 'selection is frozen once played');
  assert.equal(s.rejected('someone_else', 'ROUND_IN_PROGRESS'), false, 'rejection for another request');
  s.applyRound(snapshot(s, 'R1', 'accepted'));
  assert.equal(s.newRound(), false, 'New Round while pending');
  assert.equal(s.rejected(key, 'INVALID_REQUEST'), false, 'late rejection once accepted');
  assert.equal(s.phase, 'pending');
});

test('only the next event sequence is applied: duplicates, stale and gapped events are ignored', () => {
  const s = fresh();
  s.play();
  const accepted = snapshot(s, 'R1', 'accepted');
  assert.equal(s.applyEvent(event(2, accepted)), false, 'gap: 2 before 1');
  assert.equal(s.cursor, 0);
  assert.ok(s.applyEvent(event(1, accepted)));
  assert.equal(s.applyEvent(event(1, accepted)), false, 'duplicate');
  assert.equal(s.cursor, 1);
  assert.ok(s.applyEvent(event(2, completed(s, 'R1', 0))));
  assert.equal(s.cursor, 2);
  assert.equal(s.phase, 'completed');
});

test('redelivered completions never score twice', () => {
  const s = fresh();
  s.select(1);
  s.play();
  const done = completed(s, 'R1', 1);
  s.applyRound(snapshot(s, 'R1', 'accepted'));
  s.applyEvent(event(1, snapshot(s, 'R1', 'accepted')));
  s.applyEvent(event(2, done));
  s.applyRound(done); // a late GET/POST reply with the same completion
  s.applyEvent(event(2, done)); // redelivered after a reconnect
  assert.equal(s.score, 1);
  s.resync(); // re-read the whole history from 0
  s.applyEvent(event(1, snapshot(s, 'R1', 'accepted')));
  s.applyEvent(event(2, done));
  assert.equal(s.score, 1, 'replaying history rebuilds, not adds');
});

test('late replies cannot replace a newer round; completed snapshots are immutable', () => {
  const s = fresh();
  s.play();
  const old = completed(s, 'R1', 0);
  const oldAccepted = snapshot(s, 'R1', 'accepted');
  s.applyRound(old);
  assert.equal(s.applyRound(oldAccepted), false, 'a late "accepted" cannot reopen a completed round');
  s.newRound();
  s.play();
  assert.equal(s.applyRound(oldAccepted), false, 'a late reply for the old round is not ours');
  assert.equal(s.phase, 'submitting');
  assert.notEqual(s.round.requestId, old.requestId);
});

test("other players' events advance the cursor but never our score or round", () => {
  const s = fresh();
  s.play();
  const theirs = { ...completed(s, 'X1', s.round.choice), playerId: 'p_other', requestId: 'req_other' };
  assert.ok(s.applyEvent(event(1, theirs)));
  assert.equal(s.cursor, 1);
  assert.equal(s.score, 0);
  assert.equal(s.phase, 'submitting');
});

test('refresh restores player, intent, round and cursor; malformed storage is distrusted', () => {
  const s = fresh();
  s.select(2);
  s.play();
  s.applyEvent(event(1, snapshot(s, 'R1', 'accepted')));
  const saved = JSON.parse(JSON.stringify(s));
  const back = RoundState.restore(saved, ids());
  assert.deepEqual(back.toJSON(), s.toJSON());
  assert.equal(back.phase, 'pending');

  const junk = RoundState.restore({ playerId: 'bad id!', choice: 7, cursor: -3, results: [], round: { requestId: '' } }, ids());
  assert.match(junk.playerId, /^p_/);
  assert.equal(junk.choice, 0);
  assert.equal(junk.cursor, 0, 'no trustworthy results: re-read history from 0');
  assert.equal(junk.round, null);
});

test('the idempotency key belongs to the intent: shared by every trigger, rotated only when it ends', () => {
  const s = fresh();
  const key = s.toJSON().intentKey;
  s.play();
  assert.equal(s.round.requestId, key, 'the key existed before the click');
  assert.equal(s.toJSON().intentKey, key, 'Play does not rotate it');

  // Two independent triggers acting on the same saved intent (no shared guard) send the same key.
  const a = RoundState.restore({ playerId: 'p1', intentKey: 'req_X' }, ids());
  const b = RoundState.restore({ playerId: 'p1', intentKey: 'req_X' }, ids());
  a.play(); b.play();
  assert.equal(a.round.requestId, b.round.requestId);

  s.rejected(key, 'ROUND_IN_PROGRESS');
  assert.notEqual(s.toJSON().intentKey, key, 'a final rejection ends the intent');
  const k2 = s.toJSON().intentKey;
  s.play();
  s.applyRound(completed(s, 'R2', 0));
  assert.equal(s.toJSON().intentKey, k2, 'kept through completion');
  s.newRound();
  assert.notEqual(s.toJSON().intentKey, k2, 'New Round ends the intent');
});

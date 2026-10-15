// Control table and user-facing text.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as S from '../../client/core/controls.mjs';
import { coreText, describeResult, stageNote } from '../../client/core/messages.mjs';

test('controls: conflicting actions are never enabled together', () => {
  for (const phase of ['idle', 'starting', 'playing', 'replaying', 'revealed']) {
    const c = S.controlsFor({ phase, hasResult: true });
    if (c.play) assert.ok(!c.pause && !c.skip && !c.replay && !c.newRound, phase);
    if (c.replay) assert.ok(!c.play && !c.pause && !c.select, phase);
    if (c.pause) assert.ok(!c.play && !c.select && !c.newRound, phase);
  }
  assert.equal(S.controlsFor({ phase: 'playing', paused: true }).pauseLabel, 'Resume');
});

test('messages: result text is shared by reveal/replay/restore and never shown before completion', () => {
  const round = { roundId: 'r', choice: 1, target: 2, score: 0, status: 'completed' };
  assert.deepEqual(describeResult(round), { text: 'You chose Amber. The signal landed on Violet. Miss — 0 points.', tone: 'miss' });
  assert.match(describeResult({ ...round, target: 1, score: 1 }, { replay: true }).text, /^Replay — .*Match! \+1 point\. \(Score unchanged\.\)$/);
  const pending = { ...round, status: 'accepted' };
  const waiting = coreText({ phase: 'playing', sample: { phase: 'travel', waiting: true }, round: pending, choice: 1 });
  assert.equal(waiting.title, 'RELAYING…');
  assert.equal(coreText({ phase: 'revealed', round }).title, 'MISS');
  assert.equal(stageNote({ sample: { phase: 'travel', waiting: true }, online: false }), 'Connection lost — your round continues on the server');
  assert.equal(stageNote({ note: 'Server slow', sample: null }), 'Server slow');
});

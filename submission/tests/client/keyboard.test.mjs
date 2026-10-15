// Keyboard shortcuts work page-wide (Safari does not focus buttons on click/Tab).
import assert from 'node:assert/strict';
import test from 'node:test';
import { keyAction } from '../../client/core/keyboard.mjs';

test('keyboard: choose, play, pause, skip, replay and new round without needing focus', () => {
  assert.deepEqual(keyAction('2', 'idle'), { type: 'select', choice: 1 });
  assert.deepEqual(keyAction('ArrowRight', 'idle'), { type: 'move', delta: 1 });
  assert.deepEqual(keyAction('ArrowUp', 'idle'), { type: 'move', delta: -1 });
  assert.deepEqual(keyAction('Enter', 'idle'), { type: 'play' });
  assert.deepEqual(keyAction('Enter', 'idle', 'beacon'), { type: 'play' }, 'Enter on a focused beacon plays it');
  assert.deepEqual(keyAction('Enter', 'revealed'), { type: 'newRound' });
  assert.deepEqual(keyAction(' ', 'playing'), { type: 'pause' });
  assert.deepEqual(keyAction('P', 'playing'), { type: 'pause' });
  assert.deepEqual(keyAction('s', 'starting'), { type: 'skip' });
  assert.deepEqual(keyAction('r', 'revealed'), { type: 'replay' });
  assert.deepEqual(keyAction('n', 'revealed'), { type: 'newRound' });
});

test('keyboard: never double-activates a focused button and ignores unrelated keys', () => {
  assert.equal(keyAction('Enter', 'idle', 'button'), null);
  assert.equal(keyAction(' ', 'playing', 'button'), null);
  assert.equal(keyAction(' ', 'idle', 'beacon'), null);
  assert.equal(keyAction('Enter', 'playing'), null, 'Enter cannot start a second round mid-animation');
  assert.equal(keyAction('x', 'idle'), null);
  assert.equal(keyAction('Tab', 'idle'), null);
});

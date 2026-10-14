// Client timeline (Presentation): ordering, Pause/Resume, Skip, cancel and replay, with
// fake motions that finish when the test says so (no browser needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Presentation } from '../client/Presentation.ts';

/** A fake Web Animation: pause/play/finish/cancel behave the same way. */
function fakeStage() {
  const made = [];
  const log = [];
  const motion = name => {
    let resolve, reject;
    const m = {
      name, state: 'running',
      finished: new Promise((res, rej) => { resolve = res; reject = rej; }),
      pause() { if (m.state === 'running') m.state = 'paused'; },
      play() { if (m.state === 'paused') m.state = 'running'; },
      finish() { if (m.state !== 'done' && m.state !== 'cancelled') { m.state = 'done'; resolve(); } },
      cancel() { if (m.state !== 'done' && m.state !== 'cancelled') { m.state = 'cancelled'; reject(new Error('cancelled')); } },
    };
    m.finished.catch(() => {});
    made.push(m);
    return m;
  };
  const stage = {
    showPulse: choice => log.push(`show ${choice}`),
    hidePulse: () => log.push('hide'),
    morph: () => motion('morph'),
    delay: () => motion('delay'),
    flight: target => { log.push(`fly ${target}`); return motion('flight'); },
    land: (target, choice) => { log.push(`land ${target}${target === choice ? ' match' : ' miss'}`); return [motion('crown')]; },
    uncrown: () => [motion('uncrown')],
  };
  const last = name => made.filter(m => m.name === name).at(-1);
  return { stage, log, last };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('a live round: drop, wait for the server (never invent a result), fly, land, then reveal', async () => {
  const { stage, log, last } = fakeStage();
  const p = new Presentation(stage, () => {});
  const outcome = deferred();
  let revealed = 0;
  p.playRound(0, outcome.promise, () => revealed++);
  await settle();
  last('morph').finish();
  await settle();
  assert.equal(last('flight'), undefined, 'no flight before the server result');
  assert.equal(revealed, 0);
  outcome.resolve(2);
  await settle();
  assert.equal(revealed, 0, 'not revealed mid-flight');
  last('flight').finish();
  await settle();
  assert.equal(revealed, 1);
  assert.deepEqual(log, ['hide', 'show 0', 'fly 2', 'hide', 'land 2 miss']);
  assert.equal(p.running, false);
});

test('Pause holds the presentation (including steps that start while paused); Resume continues', async () => {
  const { stage, last } = fakeStage();
  const p = new Presentation(stage, () => {});
  const outcome = deferred();
  let revealed = 0;
  p.playRound(1, outcome.promise, () => revealed++);
  await settle();
  p.pause();
  assert.equal(last('morph').state, 'paused');
  last('morph').finish();
  outcome.resolve(1); // the server keeps going while paused
  await settle();
  assert.equal(last('flight').state, 'paused', 'a step started while paused starts paused');
  assert.equal(revealed, 0);
  p.resume();
  assert.equal(last('flight').state, 'running');
  last('flight').finish();
  await settle();
  assert.equal(revealed, 1);
});

test('Skip before the result waits for it, then reveals instantly; Skip never changes the outcome', async () => {
  const { stage, log, last } = fakeStage();
  const p = new Presentation(stage, () => {});
  const outcome = deferred();
  let revealed = 0;
  p.playRound(0, outcome.promise, () => revealed++);
  await settle();
  p.skip();
  await settle();
  assert.equal(last('morph').state, 'done');
  assert.equal(revealed, 0, 'no result yet, nothing invented');
  outcome.resolve(0);
  await settle(); await settle();
  assert.equal(last('flight').state, 'done', 'the flight is finished immediately');
  assert.equal(last('crown').state, 'done');
  assert.equal(revealed, 1);
  assert.ok(log.includes('land 0 match'), 'lands on the server target');
});

test('cancel (New Round, rejected round) stops the sequence without revealing', async () => {
  const { stage, last } = fakeStage();
  const p = new Presentation(stage, () => {});
  const outcome = deferred();
  let revealed = 0;
  p.playRound(2, outcome.promise, () => revealed++);
  await settle();
  p.cancel();
  outcome.resolve(1);
  await settle(); await settle();
  assert.equal(last('morph').state, 'cancelled');
  assert.equal(last('flight'), undefined);
  assert.equal(revealed, 0);
  assert.equal(p.running, false);
});

test('a newer replay replaces the running one; only the newest reveals', async () => {
  const { stage, last } = fakeStage();
  const p = new Presentation(stage, () => {});
  const reveals = [];
  p.replay(0, 1, () => reveals.push('first'));
  await settle();
  const first = last('morph');
  p.replay(0, 1, () => reveals.push('second'));
  await settle();
  assert.equal(first.state, 'cancelled', 'old animations are cleaned up before replacing them');
  last('morph').finish(); await settle();
  last('delay').finish(); await settle();
  last('flight').finish(); await settle();
  assert.deepEqual(reveals, ['second']);
});

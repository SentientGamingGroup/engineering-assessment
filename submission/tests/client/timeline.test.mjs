// Animation timeline: never invents results, lands exactly, smooth and frame-rate independent.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as S from '../../client/core/timeline.mjs';

const run = (tl, ms, step = 16) => { for (let t = 0; t < ms; t += step) tl = S.advance(tl, step); return tl; };

test('timeline waits for the server indefinitely and never invents a result', () => {
  let tl = S.createTimeline({ choice: 1 });
  tl = run(tl, 20_000);
  const s = S.sample(tl);
  assert.equal(s.phase, 'travel');
  assert.equal(s.waiting, true);
  tl = S.setResult(tl, 2);
  let waited = 0;
  while (S.sample(tl).phase === 'travel') { tl = S.advance(tl, 16); waited += 16; }
  assert.equal(S.sample(tl).phase, 'land');
  assert.ok(waited <= 700, `keeps orbiting at most 1/3 lap to line up (${waited}ms)`);
  tl = run(tl, 5000);
  assert.equal(S.sample(tl).phase, 'done');
  assert.equal(S.setResult(tl, 0).target, 2, 'a later result cannot replace the first');
});

test('pulse orbits a circle and lands exactly on the server target, smoothly, never reversing', () => {
  for (const choice of [0, 1, 2]) for (const target of [0, 1, 2]) for (const arrival of [0, 700, 1300, 2900]) {
    let tl = S.createTimeline({ choice });
    let prev = null;
    let prevStep = null;
    for (let t = 0; S.sample(tl).phase !== 'done'; t += 16) {
      if (t >= arrival) tl = S.setResult(tl, target);
      tl = S.advance(tl, 16);
      const s = S.sample(tl);
      if (s.phase === 'reveal' || s.phase === 'done') break;
      if (prev !== null) {
        const step = s.angle - prev;
        assert.ok(step >= -1e-9, 'never moves backwards');
        if (prevStep !== null) assert.ok(Math.abs(step - prevStep) < 0.002, 'no speed jumps between frames');
        prevStep = step;
      }
      prev = s.angle;
    }
    const end = S.sample(S.advance(tl, 16));
    const landed = ((end.angle % 1) + 1) % 1;
    assert.ok(Math.abs(landed - S.BEACON_ANGLES[target]) < 1e-9, `choice ${choice} → target ${target}`);
  }
});

test('main presentation after the server result stays within the brief: about 2–3 s', () => {
  const durations = [];
  for (const choice of [0, 1, 2]) for (const target of [0, 1, 2]) for (let arrival = 1200; arrival < 3200; arrival += 160) {
    let tl = S.createTimeline({ choice });
    let t = 0;
    while (t < arrival) { tl = S.advance(tl, 16); t += 16; }
    tl = S.setResult(tl, target);
    let after = 0;
    while (S.sample(tl).phase !== 'done') { tl = S.advance(tl, 16); after += 16; }
    durations.push(after);
  }
  const avg = durations.reduce((a, b) => a + b) / durations.length;
  const bounds = S.presentationBounds();
  assert.ok(Math.min(...durations) >= 1800 - 20, `min ${Math.min(...durations)}`);
  assert.ok(Math.max(...durations) <= 3000 + 20, `max ${Math.max(...durations)}`);
  assert.ok(Math.max(...durations) <= bounds.max + 20 && Math.min(...durations) >= bounds.min - 20);
  assert.ok(avg >= 2000 && avg <= 3000, `average ${avg}`);
  assert.ok(S.presentationBounds(true).max < bounds.min, 'reduced motion is shorter');
});

test('timeline is frame-rate independent', () => {
  const finishAt = step => {
    let tl = S.createTimeline({ choice: 0, target: 1 });
    let elapsed = 0;
    while (S.sample(tl).phase !== 'done') { tl = S.advance(tl, step); elapsed += step; }
    return elapsed;
  };
  assert.ok(Math.abs(finishAt(1000 / 144) - finishAt(1000 / 30)) <= 2 * (1000 / 30));
});

test('pause freezes presentation; huge frame gaps (background tab) are clamped', () => {
  let tl = run(S.createTimeline({ choice: 0, target: 0 }), 300);
  const paused = S.pause(tl);
  assert.equal(S.advance(paused, 5000).t, paused.t);
  tl = S.advance(S.resume(paused), 60_000);
  assert.ok(tl.t - paused.t <= 100);
});

test('skip before the result waits for it, then reveals immediately', () => {
  let tl = S.skip(run(S.createTimeline({ choice: 0 }), 200));
  tl = run(tl, 3000);
  assert.equal(S.sample(tl).phase, 'travel', 'skip cannot reveal what the server has not decided');
  tl = S.advance(S.setResult(tl, 1), 16);
  assert.equal(S.sample(tl).phase, 'done');
  const known = S.skip(S.createTimeline({ choice: 0, target: 2 }));
  assert.equal(S.sample(known).phase, 'done');
});

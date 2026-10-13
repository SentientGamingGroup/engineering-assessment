// Timeline lifecycle tests with stubbed rAF/DOM: completion, pause freezing
// presentation time, skip, cancel and the single-active-run guarantee.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTimeline } from '../client/timeline.mjs';

let frameMs = 16; // simulated display refresh interval
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), frameMs);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const element = (x, y) => ({
  offsetLeft: x, offsetTop: y, offsetWidth: 20, offsetHeight: 20,
  style: {},
  classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } },
});
const fixture = () => {
  const stage = { dataset: {}, classList: { toggle() {} } };
  const pulse = element(100, 10);
  const beacons = [element(10, 100), element(100, 100), element(190, 100)];
  const calls = { done: 0 };
  const timeline = createTimeline({ stage, pulse, beacons, onDone: () => { calls.done += 1; } });
  return { stage, pulse, beacons, calls, timeline };
};
const until = async (fn, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await delay(20);
  }
  return false;
};

test('quick run completes at the target with the match effect', async () => {
  const { stage, pulse, beacons, calls, timeline } = fixture();
  timeline.playReveal({ targetIndex: 2, match: true, quick: true });
  assert.ok(await until(() => calls.done === 1));
  assert.equal(stage.dataset.result, 'match');
  assert.ok(beacons[2].classList.set.has('lit'));
  assert.ok(pulse.style.transform.includes('translate'));
  assert.equal(timeline.active(), false);
});

test('pause freezes presentation time; resume completes with the miss effect', async () => {
  const { stage, calls, timeline } = fixture();
  timeline.playReveal({ targetIndex: 0, match: false });
  await delay(100);
  timeline.pause();
  await delay(2500); // longer than the full 2.2s duration: must NOT complete while paused
  assert.equal(calls.done, 0);
  assert.ok(timeline.active());
  timeline.resume();
  assert.ok(await until(() => calls.done === 1));
  assert.equal(stage.dataset.result, 'miss');
});

test('skip jumps straight to the recorded outcome', async () => {
  const { stage, calls, timeline } = fixture();
  timeline.playReveal({ targetIndex: 1, match: true });
  await delay(50);
  timeline.skip();
  assert.equal(calls.done, 1);
  assert.equal(stage.dataset.result, 'match');
  assert.equal(timeline.active(), false);
});

test('cancel clears the scene without firing onDone', async () => {
  const { stage, pulse, calls, timeline } = fixture();
  timeline.playReveal({ targetIndex: 1, match: true });
  timeline.cancel();
  await delay(300);
  assert.equal(calls.done, 0);
  assert.equal(stage.dataset.result, undefined);
  assert.equal(pulse.style.transform, '');
});

test('starting a new run replaces the old one: a single active timeline', async () => {
  const { beacons, calls, timeline } = fixture();
  timeline.playReveal({ targetIndex: 0, match: false });
  await delay(50);
  timeline.playReveal({ targetIndex: 2, match: true, quick: true });
  assert.ok(await until(() => calls.done === 1));
  await delay(200); // the replaced run must never fire a second onDone
  assert.equal(calls.done, 1);
  assert.ok(beacons[2].classList.set.has('lit'));
  assert.equal(beacons[0].classList.set.has('lit'), false);
});

test('showResult renders the landed outcome statically after a refresh', () => {
  const { stage, pulse, beacons, calls, timeline } = fixture();
  timeline.showResult({ targetIndex: 1, match: false });
  assert.equal(stage.dataset.result, 'miss');
  assert.ok(beacons[1].classList.set.has('lit'));
  assert.equal(pulse.style.opacity, '0');
  assert.equal(calls.done, 0, 'no reveal transition is replayed');
  assert.equal(timeline.active(), false);
});

test('frame-rate independent: 20 fps and 120 fps finish the same 2.2 s run at the same time', async () => {
  const durations = [];
  for (const rate of [50, 8]) {
    frameMs = rate;
    const { calls, timeline } = fixture();
    const started = performance.now();
    timeline.playReveal({ targetIndex: 0, match: true });
    assert.ok(await until(() => calls.done === 1));
    durations.push(performance.now() - started);
  }
  frameMs = 16;
  for (const ms of durations) assert.ok(ms >= 2200 && ms < 2400, `duration ${ms}`);
  assert.ok(Math.abs(durations[0] - durations[1]) < 120, `fps changed the timing: ${durations}`);
});

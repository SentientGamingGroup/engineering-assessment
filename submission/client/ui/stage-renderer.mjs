// Draws the stage for one timeline sample: a true circular orbit, beacons placed on
// it, the pulse with a comet tail, and reveal effects. DOM + CSS transforms, no state.
import { easeInOut, easeOut, easeOutBack } from '../core/easing.mjs';
import { BEACON_ANGLES, MOTION, sample as sampleAt } from '../core/timeline.mjs';

const TRAIL_LENGTH = 9;
const TRAIL_SPACING_MS = 32;
const SPARK_COUNT = 18;
const SPARK_COLOURS = ['#7ff7e3', '#ffcf68', '#c39bff', '#5dc8ff', '#5ff5a6'];

export function createStageRenderer(stage, { onResize } = {}) {
  const beacons = [...stage.querySelectorAll('.beacon')];
  const pulse = stage.querySelector('.pulse');
  const fx = stage.querySelector('.fx');
  const make = (className, count) => Array.from({ length: count },
    () => fx.appendChild(Object.assign(document.createElement('div'), { className })));
  const trails = make('trail', TRAIL_LENGTH); // the pulse sampled slightly in the past
  const [ring] = make('ring', 1);
  const sparks = make('spark', SPARK_COUNT);
  sparks.forEach((spark, i) => spark.style.setProperty('--c', SPARK_COLOURS[i % SPARK_COLOURS.length]));

  // ---- geometry: one circle centred in the stage; beacons sit on it at BEACON_ANGLES
  let layout;
  const pointAt = laps => ({
    x: layout.cx + layout.r * Math.sin(laps * 2 * Math.PI),
    y: layout.cy - layout.r * Math.cos(laps * 2 * Math.PI),
  });
  function measure() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const orb = beacons[0].offsetWidth || 84;
    const r = Math.max(60, Math.min(width / 2 - orb / 2 - 18, height / 2 - orb / 2 - 26));
    layout = { cx: width / 2, cy: height / 2 - 4, r };
    stage.style.setProperty('--cx', layout.cx);
    stage.style.setProperty('--cy', layout.cy);
    stage.style.setProperty('--r', r);
    beacons.forEach((beacon, i) => {
      const p = pointAt(BEACON_ANGLES[i]);
      beacon.style.left = `${p.x}px`;
      beacon.style.top = `${p.y}px`;
    });
  }
  new ResizeObserver(() => { measure(); onResize?.(); }).observe(stage);

  const lerp = (a, b, p) => ({ x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p });
  const centre = () => ({ x: layout.cx, y: layout.cy });
  function pulseAt(tl, s) {
    if (s.angle !== null) return pointAt(s.angle);
    // Reduced motion: no orbit — the pulse waits at the core and glides to the target.
    if (s.phase === 'land') return lerp(centre(), pointAt(BEACON_ANGLES[tl.target]), easeInOut(s.p));
    return centre();
  }
  const place = (el, p, scale, opacity) => {
    el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) scale(${scale})`;
    el.style.opacity = opacity;
  };
  const hide = els => els.forEach(el => { el.style.opacity = 0; });

  function drawReveal(tl, s, round) {
    const at = pointAt(BEACON_ANGLES[tl.target]);
    const p = s.p;
    place(pulse, at, 1 + 1.5 * easeOut(p), 1 - p);
    place(ring, at, 0.25 + easeOut(p) * (tl.reduced ? 0.5 : 1.6), s.phase === 'done' ? 0 : (1 - p) * 0.9);
    hide(trails);
    const celebrate = round?.score === 1 && !tl.reduced && s.phase !== 'done';
    sparks.forEach((spark, i) => {
      if (!celebrate) { spark.style.opacity = 0; return; }
      const angle = (i / sparks.length) * Math.PI * 2 + (i % 2) * 0.2;
      const dist = (40 + (i % 3) * 22) * easeOut(p);
      place(spark, { x: at.x + Math.cos(angle) * dist, y: at.y + Math.sin(angle) * dist + 30 * p * p }, 1 - 0.6 * p, 1 - p);
    });
  }

  function drawFlight(tl, s) {
    const breathing = s.phase === 'travel' && s.waiting ? 1 + 0.12 * Math.sin(tl.t / 160) : 1;
    const scale = s.phase === 'charge' ? 0.2 + 0.8 * easeOutBack(s.p) : breathing;
    place(pulse, pulseAt(tl, s), scale, s.phase === 'charge' ? Math.min(1, s.p * 2) : 1);
    ring.style.opacity = 0;
    hide(sparks);
    trails.forEach((trail, i) => {
      const past = { ...tl, t: tl.t - (i + 1) * TRAIL_SPACING_MS };
      if (tl.reduced || past.t < MOTION.normal.charge) { trail.style.opacity = 0; return; }
      const k = 1 - i / trails.length;
      place(trail, pulseAt(past, sampleAt(past)), 0.35 + 0.6 * k, 0.55 * k * k);
    });
  }

  return {
    measure,
    draw(tl, s, round) {
      if (!layout) measure();
      stage.dataset.timeline = s.phase;
      if (s.phase === 'reveal' || s.phase === 'done') {
        this.showReveal(round);
        drawReveal(tl, s, round);
      } else {
        drawFlight(tl, s);
      }
    },
    showReveal(round) {
      if (round?.status !== 'completed') return;
      stage.classList.toggle('hit', round.score === 1);
      stage.classList.toggle('miss', round.score !== 1);
      beacons.forEach((beacon, i) => {
        beacon.classList.toggle('target', i === round.target);
        beacon.classList.toggle('chosen', i === round.choice);
      });
    },
    clear() {
      stage.classList.remove('hit', 'miss');
      beacons.forEach(beacon => beacon.classList.remove('target', 'chosen'));
      hide([pulse, ring, ...trails, ...sparks]);
      stage.dataset.timeline = 'idle';
    },
  };
}

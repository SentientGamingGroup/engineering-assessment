// Reveal timeline: one requestAnimationFrame loop, elapsed-time driven so the
// motion is frame-rate independent and a background tab simply fast-forwards to
// the correct final state instead of spawning extra loops.
//
// Renderer choice: DOM/CSS transforms. The scene is three buttons and one pulse,
// so the DOM gives free HiDPI/resize crispness, native keyboard/focus semantics
// and media-query reduced-motion handling; Canvas/WebGL would add complexity
// without visual gain at this scale.
const TRAVEL_SHARE = 0.65;       // first 65% of the run: travel to the target
const FULL_DURATION_MS = 2200;   // inside the 2-3s brief, excluding backend delay
const QUICK_DURATION_MS = 300;   // skip / reduced motion: minimal motion, same outcome
const ARC_PX = 46;
const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function createTimeline({ stage, pulse, beacons, onDone }) {
  let frame = 0;
  let run = null;

  // offsetLeft/offsetTop exclude transforms, so this is layout geometry: reading
  // it every frame keeps travel aimed correctly through resizes.
  const centerOf = el => ({
    x: el.offsetLeft + el.offsetWidth / 2,
    y: el.offsetTop + el.offsetHeight / 2,
  });
  const delta = () => {
    const from = centerOf(pulse);
    const to = centerOf(beacons[run.targetIndex]);
    return { x: to.x - from.x, y: to.y - from.y };
  };
  const clearScene = () => {
    pulse.style.transform = '';
    pulse.style.opacity = '';
    delete stage.dataset.result;
    for (const beacon of beacons) beacon.classList.remove('lit');
  };
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const land = () => {
    stage.dataset.result = run.match ? 'match' : 'miss';
    beacons[run.targetIndex].classList.add('lit');
  };
  const finish = () => {
    const { x, y } = delta();
    // final state: energy absorbed by the lit beacon, orb gone from the scene
    pulse.style.transform = `translate(${x}px, ${y}px) scale(0)`;
    pulse.style.opacity = '0';
    if (!stage.dataset.result) land();
    run = null;
    stop();
    onDone();
  };

  function tick() {
    frame = requestAnimationFrame(timestamp => {
      frame = 0;
      if (!run || run.pausedAt) return;
      const progress = Math.min((timestamp - run.start) / run.duration, 1);
      if (progress >= 1) { finish(); return; }
      if (run.quick) {
        const { x, y } = delta();
        pulse.style.transform = `translate(${x}px, ${y}px)`;
        pulse.style.opacity = String(Math.max(1 - progress, 0.15));
        if (progress >= 0.5 && !stage.dataset.result) land();
      } else if (progress < TRAVEL_SHARE) {
        const t = easeInOutCubic(progress / TRAVEL_SHARE);
        const { x, y } = delta();
        // launch kick: the pulse visibly swells as it fires, reads energetic
        // from the first frames even though positional easing starts gentle
        const kick = 1 + 0.45 * Math.sin(Math.PI * Math.min(t * 1.6, 1));
        pulse.style.transform =
          `translate(${x * t}px, ${y * t - ARC_PX * Math.sin(Math.PI * t)}px) scale(${kick})`;
      } else {
        const t = (progress - TRAVEL_SHARE) / (1 - TRAVEL_SHARE);
        if (!stage.dataset.result) land();
        const { x, y } = delta();
        // the pulse hands its energy to the beacon: shrink + fade into it so
        // the landed orb never covers the beacon label
        const settle = Math.max(1.25 * (1 - t), 0);
        pulse.style.transform = `translate(${x}px, ${y}px) scale(${settle})`;
        pulse.style.opacity = String(1 - t);
      }
      tick();
    });
  }

  return {
    // Starting a new run always cancels the previous one: one active timeline.
    playReveal({ targetIndex, match, quick = false, startPaused = false }) {
      stop();
      clearScene();
      run = {
        targetIndex, match, quick,
        duration: quick ? QUICK_DURATION_MS : FULL_DURATION_MS,
        start: performance.now(),
        pausedAt: startPaused ? performance.now() : 0,
      };
      if (!run.pausedAt) tick();
    },
    pause() {
      if (!run || run.pausedAt) return;
      run.pausedAt = performance.now();
      stop();
    },
    resume() {
      if (!run || !run.pausedAt) return;
      run.start += performance.now() - run.pausedAt;
      run.pausedAt = 0;
      tick();
    },
    // Jump straight to the recorded outcome; never invents or changes a result.
    skip() { if (run) finish(); },
    // Static final state (e.g. page refresh after the reveal): no motion, no onDone.
    showResult({ targetIndex, match }) {
      stop();
      run = null;
      clearScene();
      pulse.style.opacity = '0';
      stage.dataset.result = match ? 'match' : 'miss';
      beacons[targetIndex].classList.add('lit');
    },
    cancel() {
      stop();
      run = null;
      clearScene();
    },
    active: () => Boolean(run),
  };
}

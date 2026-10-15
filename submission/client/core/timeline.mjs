// Animation timeline (pure: no DOM, no network; unit-tested in Node).
//
// Presentation time `t` only advances by frame deltas while not paused,
// so motion is frame-rate independent and Pause/Skip never touch server state.
// The pulse may orbit indefinitely; it lands only once the server's target is known.

// Geometry is part of the timeline: beacons sit on a circular orbit at fixed
// angles (in laps, 0 = top, clockwise), so landing can be computed exactly.
export const BEACON_ANGLES = Object.freeze([2 / 3, 0, 1 / 3]); // Azure (left), Amber (top), Violet (right)

export const MOTION = Object.freeze({
  // lap: ms per orbit. accel: ms to reach full speed. land*: deceleration bounds.
  // Tuned so the presentation after the server result is 1.8–3.0 s (brief: "about 2–3 s").
  normal: { charge: 550, travelMin: 700, lap: 1800, accel: 500, landMin: 900, landMax: 1500, reveal: 900 },
  reduced: { charge: 0, travelMin: 0, lap: 0, accel: 0, landMin: 250, landMax: 250, reveal: 300 },
});
const MAX_FRAME_MS = 100; // a background tab resumes where it was, not at a jump
const mod1 = x => ((x % 1) + 1) % 1;

export function createTimeline({ choice, target = null, reduced = false }) {
  return { choice, target, reduced, t: 0, paused: false, skip: false, land: null };
}

const motion = tl => (tl.reduced ? MOTION.reduced : MOTION.normal);

// Landing window: a cubic Hermite curve that starts at orbit speed v and ends at rest
// on the target. Over duration L it never reverses when the remaining distance d (laps)
// is ≥ vL/3, and never exceeds 4/3·v when d ≤ vL — so landing can start once the
// pulse is within [landMin/3, landMax] of orbit time from the target.
export function landingWindow(m = MOTION.normal) {
  return { min: m.landMin / (3 * m.lap), max: m.landMax / m.lap };
}

// Orbit angle after `ms` of travel: eases in from rest, then constant speed.
function orbitAngle(tl, ms) {
  const m = motion(tl);
  const start = BEACON_ANGLES[tl.choice];
  const v = 1 / m.lap;
  return start + (ms < m.accel ? (v * ms * ms) / (2 * m.accel) : v * (ms - m.accel / 2));
}

export function setResult(tl, target) {
  if (tl.target !== null) return tl; // first authoritative result wins
  return { ...tl, target };
}

function planLanding(tl, t) {
  const m = motion(tl);
  if (tl.reduced) return { at: t, from: null, dist: 0, dur: m.landMin };
  const from = orbitAngle(tl, t - m.charge);
  const dist = mod1(BEACON_ANGLES[tl.target] - from);
  const window = landingWindow(m);
  if (dist < window.min || dist > window.max) return null; // keep orbiting until aligned
  const dur = Math.min(m.landMax, Math.max(m.landMin, 2 * dist * m.lap));
  return { at: t, from, dist, dur };
}

export function advance(tl, dtMs) {
  if (tl.paused) return tl;
  const m = motion(tl);
  const t = tl.t + Math.min(Math.max(dtMs, 0), MAX_FRAME_MS);
  let land = tl.land;
  if (tl.target !== null && land === null) {
    if (tl.skip) return finishNow({ ...tl, t });
    if (t >= m.charge + Math.max(m.travelMin, m.accel)) land = planLanding(tl, t);
  }
  return { ...tl, t, land };
}

function finishNow(tl) {
  const m = motion(tl);
  const land = tl.land ?? { at: tl.t, from: BEACON_ANGLES[tl.target], dist: 0, dur: 0 };
  return { ...tl, skip: true, land, t: Math.max(tl.t, m.charge, land.at + land.dur + m.reveal) };
}

export const pause = tl => ({ ...tl, paused: true });
export const resume = tl => ({ ...tl, paused: false });

// Skip reveals a known result immediately, or arms itself to do so on arrival.
export function skip(tl) {
  return tl.target === null ? { ...tl, skip: true } : finishNow(tl);
}

// Position/phase at the timeline's current time. Pure function of state, so the
// renderer can also sample the recent past (comet trail).
export function sample(tl) {
  const m = motion(tl);
  const { t, land } = tl;
  if (t < m.charge) return { phase: 'charge', p: t / m.charge, angle: BEACON_ANGLES[tl.choice] };
  if (land === null || t < land.at) {
    return {
      phase: 'travel', angle: tl.reduced ? null : orbitAngle(tl, t - m.charge),
      waiting: t >= m.charge + m.travelMin,
    };
  }
  const since = t - land.at;
  if (since < land.dur) {
    const p = since / land.dur;
    if (tl.reduced) return { phase: 'land', p, angle: null };
    const h10 = p ** 3 - 2 * p * p + p; // starts at orbit speed
    const h01 = 3 * p * p - 2 * p ** 3; // ends exactly at the target, at rest
    return { phase: 'land', p, angle: land.from + (land.dur / m.lap) * h10 + land.dist * h01 };
  }
  if (since < land.dur + m.reveal) return { phase: 'reveal', p: (since - land.dur) / m.reveal, angle: BEACON_ANGLES[tl.target] };
  return { phase: 'done', p: 1, angle: BEACON_ANGLES[tl.target] };
}

// Bounds of the main presentation after the server result is known (ms).
export function presentationBounds(reduced = false) {
  const m = reduced ? MOTION.reduced : MOTION.normal;
  if (reduced) return { min: m.landMin + m.reveal, max: m.landMin + m.reveal };
  const w = landingWindow(m);
  const maxWait = Math.max(0, 1 - (w.max - w.min)) * m.lap;
  return { min: m.landMin + m.reveal, max: maxWait + m.landMax + m.reveal };
}

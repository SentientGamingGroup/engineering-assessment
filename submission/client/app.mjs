// Wiring: DOM, HTTP, WebSocket, persistence and the Canvas timeline.
// All decisions live in state.mjs; this file only performs effects.
import {
  reduce, controls, persisted, restore,
  REVEAL_MS, REDUCED_REVEAL_MS, easeInOutCubic, tick,
} from './state.mjs';

const $ = selector => document.querySelector(selector);
const stage = $('.stage');
const canvas = $('#fx');
const ctx = canvas.getContext('2d');
const beacons = [...document.querySelectorAll('.beacon')];
const buttons = { play: $('#play'), pause: $('#pause'), skip: $('#skip'), replay: $('#replay'), newRound: $('#new') };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const STORAGE_KEY = 'beacon-relay/v1';
const COLORS = ['#5dc8ff', '#ffcf68', '#b896ff'];

const randomId = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const load = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; } };
const save = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted(state))); } catch {} };

const saved = load();
let state = restore(saved ?? {}, saved?.playerId ?? randomId('player'));

function dispatch(action) {
  const before = state;
  state = reduce(state, action);
  if (state === before) return;
  if (state.phase !== before.phase || state.replaying !== before.replaying) startScene();
  save();
  render();
}

// --- HTTP ------------------------------------------------------------------

// Submit (or resubmit) the current intent. Timeouts, 5xx and network errors
// are unknown outcomes: retry with the SAME requestId, which the server
// deduplicates, so a retry can never create a second round.
let submitting = null;
async function submit() {
  const intent = state.intent;
  if (!intent || submitting === intent.requestId) return;
  submitting = intent.requestId;
  for (let attempt = 0; state.intent?.requestId === intent.requestId; attempt++) {
    try {
      const response = await fetch('/rounds', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: intent.requestId, playerId: state.playerId, choice: intent.choice }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      if (response.status === 202) dispatch({ type: 'accepted', round: body });
      else if (response.status < 500) dispatch({ type: 'rejected', requestId: intent.requestId, code: body.error?.code });
      else throw new Error(body.error?.code);
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, Math.min(500 * 2 ** attempt, 5000)));
    }
  }
  submitting = null;
}

// --- WebSocket feed with bounded reconnect -----------------------------------

let socket = null;
let retries = 0;
function connect() {
  setConnection('Connecting…', 'pending');
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream?after=${state.cursor}`);
  socket.onopen = () => {
    retries = 0;
    setConnection('Live', 'ok');
    // Reconcile: an intent from before a refresh/disconnect is resubmitted;
    // dedup returns the original round (accepted or already completed).
    if (state.intent && state.phase === 'submitting') submit();
  };
  socket.onmessage = message => {
    try {
      const data = JSON.parse(message.data);
      if (data.type === 'event') dispatch({ type: 'event', event: data.event });
    } catch {}
  };
  socket.onclose = () => {
    socket = null;
    const wait = Math.min(500 * 2 ** retries++, 10000) * (0.75 + Math.random() / 2);
    setConnection(`Reconnecting in ${Math.ceil(wait / 1000)}s…`, 'down');
    setTimeout(connect, wait);
  };
}
function setConnection(text, kind) {
  const el = $('#connection');
  el.textContent = text;
  el.dataset.state = kind;
}

// --- Controls ----------------------------------------------------------------

beacons.forEach((beacon, index) => {
  beacon.addEventListener('click', () => dispatch({ type: 'select', choice: index }));
});
buttons.play.addEventListener('click', () => {
  dispatch({ type: 'play', requestId: randomId('req') });
  submit();
});
buttons.pause.addEventListener('click', () => dispatch({ type: 'pause' }));
buttons.skip.addEventListener('click', () => dispatch({ type: 'skip' }));
buttons.replay.addEventListener('click', () => dispatch({ type: 'replay' }));
buttons.newRound.addEventListener('click', () => {
  dispatch({ type: 'newRound' });
  beacons[state.choice].focus();
});
// Keyboard: 1/2/3 select, Enter/Space on a beacon selects, P plays.
document.addEventListener('keydown', event => {
  if (event.target.closest?.('input,textarea') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (['1', '2', '3'].includes(event.key)) dispatch({ type: 'select', choice: Number(event.key) - 1 });
  if (event.key === 'p' || event.key === 'P') buttons.play.click();
});

function render() {
  const allowed = controls(state);
  beacons.forEach((beacon, index) => {
    beacon.setAttribute('aria-pressed', String(index === (state.intent?.choice ?? state.choice)));
    beacon.disabled = !allowed.select;
    beacon.dataset.outcome = state.phase === 'revealed' && state.round?.target === index ? (state.round.score ? 'match' : 'miss') : '';
  });
  for (const [name, button] of Object.entries(buttons)) button.disabled = !allowed[name];
  buttons.pause.textContent = state.paused ? 'Resume' : 'Pause';
  buttons.pause.setAttribute('aria-pressed', String(state.paused));
  $('#result').textContent = state.paused ? `Paused. ${state.message}` : state.message;
  $('#score').textContent = String(state.score);
  stage.dataset.phase = state.phase;
}

// --- Canvas timeline -----------------------------------------------------------
// One requestAnimationFrame loop for the page lifetime; scenes only reset a clock.
// Time comes from rAF timestamps (frame-rate independent); tick() clamps big gaps
// after a background tab, so resuming never fast-forwards or stacks loops.

let scene = { clock: 0, from: null };
let pulse = { x: 0, y: 0 }; // last drawn pulse position, where a reveal starts from
function startScene() { scene = { clock: 0, from: { ...pulse } }; }

const geometry = { width: 0, height: 0, origin: { x: 0, y: 0 }, beacons: [] };
function measure() {
  const box = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  geometry.width = box.width;
  geometry.height = box.height;
  geometry.origin = { x: box.width / 2, y: box.height * 0.18 };
  geometry.beacons = beacons.map(beacon => {
    const r = beacon.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2, radius: r.width / 2 };
  });
  if (!scene.from) pulse = { ...geometry.origin };
}
new ResizeObserver(measure).observe(stage);

const lerp = (a, b, t) => a + (b - a) * t;
function drawPulse(x, y, size, alpha = 1, color = '#72eed8') {
  pulse = { x, y };
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 2.5;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
function ring(x, y, radius, color, alpha, width = 3) {
  ctx.save();
  ctx.globalAlpha = Math.max(alpha, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Waiting motion: the pulse sweeps across the beacons on an ellipse, visibly
// "searching" without hinting at any answer.
function waitingPosition(clock) {
  const { width, height } = geometry;
  const angle = -Math.PI / 2 + (clock / 1800) * Math.PI * 2;
  return { x: width / 2 + Math.cos(angle) * width * 0.36, y: height * 0.5 + Math.sin(angle) * height * 0.3 };
}

function draw(clock) {
  const { origin } = geometry;
  ctx.clearRect(0, 0, geometry.width, geometry.height);
  const reduced = reducedMotion.matches;
  const round = state.round;

  if (state.phase === 'idle') {
    const breathe = reduced ? 0 : Math.sin(clock / 500) * 1.5;
    return drawPulse(origin.x, origin.y, 7 + breathe);
  }
  if (state.phase === 'submitting' || state.phase === 'pending') {
    if (reduced) return drawPulse(origin.x, origin.y, 8, 0.6 + 0.2 * Math.sin(clock / 400));
    // Anticipation: a short charge at the origin, then travel along the orbit.
    if (state.phase === 'submitting' && clock < 400) {
      return drawPulse(origin.x, origin.y, 7 + 5 * easeInOutCubic(clock / 400));
    }
    const p = waitingPosition(clock);
    const blend = Math.min(clock / 400, 1);
    const start = scene.from ?? origin;
    return drawPulse(lerp(start.x, p.x, blend), lerp(start.y, p.y, blend), 9);
  }
  if (!round || round.target === undefined) return;
  const target = geometry.beacons[round.target];
  const chosen = geometry.beacons[round.choice];
  const color = round.score ? '#72eed8' : '#ff7a8a';

  if (state.phase === 'revealing') {
    const total = reduced ? REDUCED_REVEAL_MS : REVEAL_MS;
    const t = Math.min(clock / total, 1);
    if (reduced) {
      ring(target.x, target.y, target.radius + 10, color, t, 4);
    } else {
      // 0–48%: eased travel into the target. 48–100%: impact burst.
      const travel = Math.min(t / 0.48, 1);
      const start = state.replaying ? origin : (scene.from ?? origin);
      const e = easeInOutCubic(travel);
      const arc = Math.sin(e * Math.PI) * -40;
      const burst = travel === 1 ? (t - 0.48) / 0.52 : 0;
      // The pulse is absorbed on impact so it never covers the beacon's label.
      drawPulse(lerp(start.x, target.x, e), lerp(start.y, target.y, e) + arc, 9 + 3 * e, 1 - burst, travel < 1 ? '#72eed8' : color);
      if (travel === 1) {
        for (let i = 0; i < 3; i++) {
          const k = Math.max(burst - i * 0.15, 0);
          ring(target.x, target.y, target.radius + 6 + k * 70, color, (1 - k) * 0.9, 3);
        }
        if (!round.score) ring(chosen.x, chosen.y, chosen.radius + 8, '#ffffff', 0.5 * (1 - burst), 2);
      }
    }
    if (t >= 1) dispatch({ type: 'revealDone' });
    return;
  }
  // revealed: steady result state
  ring(target.x, target.y, target.radius + 10, color, 0.9, 4);
  pulse = { x: target.x, y: target.y };
}

let last = performance.now();
function frame(now) {
  scene.clock = tick(scene.clock, now - last, state.paused);
  last = now;
  if (geometry.width) draw(scene.clock);
  requestAnimationFrame(frame);
}

// --- Boot -----------------------------------------------------------------------
measure();
render();
requestAnimationFrame(frame);
connect();

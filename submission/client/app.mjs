// App shell: owns DOM, HTTP, WebSocket and persistence. Game rules live in
// state.mjs; the reveal presentation lives in timeline.mjs.
import { createGame } from './state.mjs';
import { createTimeline } from './timeline.mjs';
import { attachFlickerGrid } from './fx.mjs';

const $ = selector => document.querySelector(selector);
const connection = $('#connection');
const result = $('#result');
const scoreEl = $('#score');
const playerEl = $('#player');
const stage = $('.stage');
const buttons = { play: $('#play'), pause: $('#pause'), skip: $('#skip'), replay: $('#replay'), fresh: $('#new') };
const beacons = [...document.querySelectorAll('.beacon')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const BEACON_NAMES = ['Azure', 'Amber', 'Violet'];

const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8000;

// localStorage can throw (Safari private mode, quota); a failed write must
// never break the game loop — worst case the session just isn't persisted.
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* session-only play */ } },
};
const PLAYER_KEY = 'beaconRelay.playerId';
const playerId = storage.get(PLAYER_KEY) ?? `player_${crypto.randomUUID()}`;
storage.set(PLAYER_KEY, playerId);
const STATE_KEY = `beaconRelay.state.${playerId}`;
let saved = {};
try { saved = JSON.parse(storage.get(STATE_KEY)) ?? {}; } catch { /* corrupt save: start fresh */ }
const game = createGame({ playerId, saved });

// --- reveal presentation: single rAF timeline (timeline.mjs) ---
let paused = false;
const timeline = createTimeline({
  stage,
  pulse: $('.pulse'),
  beacons,
  onDone: () => game.revealed(),
});
function startPresentation() {
  const s = game.snapshot();
  timeline.playReveal({
    targetIndex: s.round.target,
    match: s.round.score === 1,
    quick: s.skipRequested || reducedMotion.matches,
    startPaused: paused,
  });
}

// --- rendering ---
function message(s) {
  if (s.phase === 'idle') return `Beacon ${BEACON_NAMES[s.choice]} selected. Press Play to send the signal.`;
  if (s.phase === 'pending') return s.skipRequested
    ? 'Waiting for the relay — revealing as soon as it lands.'
    : 'Signal sent. Waiting for the relay…';
  if (s.phase === 'animating') return s.replaying ? 'Replaying the recorded result…' : 'Relay landing…';
  const r = s.lastResult;
  if (!r) return 'Round complete.'; // render must never be able to crash the app
  return `You chose ${BEACON_NAMES[r.choice]}; the relay lit ${BEACON_NAMES[r.target]} — ${r.score ? 'match, +1 point.' : 'no match.'}`;
}
let prevPhase = null;
let prevScore = null;
function render() {
  const s = game.snapshot();
  if (s.phase === 'animating' && prevPhase !== 'animating') startPresentation();
  prevPhase = s.phase;
  scoreEl.textContent = s.score;
  if (prevScore !== null && s.score > prevScore) {
    scoreEl.classList.remove('pop');
    void scoreEl.offsetWidth; // restart the pop animation
    scoreEl.classList.add('pop');
  }
  prevScore = s.score;
  for (const beacon of beacons) {
    const choice = Number(beacon.dataset.choice);
    beacon.setAttribute('aria-pressed', String(choice === s.choice));
    beacon.disabled = s.phase !== 'idle';
  }
  buttons.play.disabled = s.phase !== 'idle';
  buttons.pause.disabled = !['pending', 'animating'].includes(s.phase);
  buttons.pause.textContent = paused ? 'Resume' : 'Pause';
  buttons.skip.disabled = !['pending', 'animating'].includes(s.phase)
    || (s.phase === 'pending' && s.skipRequested);
  buttons.replay.disabled = s.phase !== 'revealed' || !s.lastResult;
  buttons.fresh.disabled = s.phase !== 'revealed';
  stage.dataset.phase = s.phase;
  stage.classList.toggle('paused', paused);
  result.textContent = message(s);
}

// --- HTTP: submit with bounded retries; a timeout is an unknown outcome, so the
// SAME requestId is retried rather than ever starting another round. ---
async function submitRound(requestId, choice, attempt = 0) {
  const stillCurrent = () => {
    const s = game.snapshot();
    return s.requestId === requestId && s.phase === 'pending';
  };
  if (!stillCurrent()) return;
  let response;
  try {
    response = await fetch('/rounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, playerId, choice }),
    });
  } catch { return retrySubmit(requestId, choice, attempt); }
  if (!stillCurrent()) return; // a late reply must not touch a newer round
  if (response.status === 202) {
    try { game.reconcile(await response.json()); }
    catch { retrySubmit(requestId, choice, attempt); } // malformed body: outcome unknown
    return;
  }
  if (response.status === 503 || response.status === 504) return retrySubmit(requestId, choice, attempt);
  const body = await response.json().catch(() => ({}));
  const code = body.error?.code ?? `HTTP_${response.status}`;
  game.abandon();
  result.textContent = code === 'ROUND_IN_PROGRESS'
    ? 'The server already has a round in progress for this player; its result will arrive via the feed.'
    : `The server rejected the request (${code}).`;
}
function retrySubmit(requestId, choice, attempt) {
  // Unknown outcome: keep retrying the SAME requestId with capped backoff until
  // the intent resolves. A cap on attempts could strand a pending round while
  // the WebSocket stays up (it is not reconnecting, so nothing else resubmits).
  setTimeout(() => submitRound(requestId, choice, attempt + 1),
    Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS));
}

// Refresh/reconnect recovery: ask the server what became of the stored intent.
async function reconcile() {
  const s = game.snapshot();
  if (s.phase !== 'pending') return;
  if (s.roundId) {
    try {
      const response = await fetch(`/rounds/${s.roundId}`);
      if (response.ok) { game.reconcile(await response.json()); return; }
    } catch { /* fall through to the idempotent re-submit */ }
  }
  submitRound(s.requestId, s.choice);
}

// --- WebSocket feed with bounded backoff; reconnects resume after the last
// APPLIED cursor and the state machine ignores anything already applied. ---
let socket = null;
let reconnectDelay = RETRY_BASE_MS;
let reconnectTimer = null;
function setStatus(text) {
  connection.textContent = text;
  connection.dataset.state = text.toLowerCase();
}
function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  setStatus('Connecting');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/stream?after=${game.snapshot().lastAppliedCursor}`);
  socket.onopen = () => { reconnectDelay = RETRY_BASE_MS; setStatus('Connected'); reconcile(); };
  socket.onmessage = ({ data }) => {
    try {
      const frame = JSON.parse(data);
      if (frame.type === 'event') game.applyEvent(frame.event);
    } catch { /* ignore malformed frames; cursor guard keeps state consistent */ }
  };
  socket.onclose = () => {
    if (reconnectTimer) return;
    setStatus('Reconnecting');
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RETRY_CAP_MS);
  };
  socket.onerror = () => socket.close();
}

// --- controls ---
for (const beacon of beacons) {
  beacon.onclick = () => game.select(Number(beacon.dataset.choice));
}
buttons.play.onclick = () => {
  const requestId = game.play(`req_${crypto.randomUUID()}`);
  if (requestId) submitRound(requestId, game.snapshot().choice); // intent persisted by play() before the POST
};
buttons.pause.onclick = () => {
  paused = !paused;
  if (paused) timeline.pause(); else timeline.resume(); // pending-phase loop pauses via CSS class
  render();
};
buttons.skip.onclick = () => {
  const { phase } = game.snapshot();
  game.requestSkip();
  // Skip always resumes presentation: a skip requested while paused+pending must
  // not leave the reveal frozen once the result arrives.
  if (paused) { paused = false; timeline.resume(); render(); }
  if (phase === 'animating') timeline.skip();
};
buttons.replay.onclick = () => { paused = false; game.replay(); };
buttons.fresh.onclick = () => { paused = false; timeline.cancel(); game.newRound(); };

game.subscribe(() => {
  storage.set(STATE_KEY, JSON.stringify(game.persistable()));
  render();
});
playerEl.textContent = `you: ${playerId.slice(0, 15)}…`;
attachFlickerGrid(document.querySelector('.grid-bg'));
// Refresh straight into a revealed round: show the landed result statically.
const initial = game.snapshot();
if (initial.phase === 'revealed' && initial.lastResult) {
  timeline.showResult({ targetIndex: initial.lastResult.target, match: initial.lastResult.score === 1 });
}
render();
connect();

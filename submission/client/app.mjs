// Beacon Relay client controller: owns client state and wires the layers together.
//   core/      pure logic (timeline, ledger, controls, messages) — unit-tested in Node
//   services/  I/O (HTTP api, WebSocket feed, localStorage)
//   ui/        DOM (stage renderer, view)
// Game rules live on the server; this file never decides an outcome.
import { controlsFor, isAnimating } from './core/controls.mjs';
import { randomId } from './core/ids.mjs';
import { keyAction } from './core/keyboard.mjs';
import { applyEvent, createLedger, recordCompleted, statsOf } from './core/ledger.mjs';
import { BEACON_NAMES, coreText, describeResult, stageNote } from './core/messages.mjs';
import * as Timeline from './core/timeline.mjs';
import * as api from './services/api.mjs';
import { createFeed } from './services/feed.mjs';
import { loadSaved, save } from './services/storage.mjs';
import { createStageRenderer } from './ui/stage-renderer.mjs';
import { createView } from './ui/view.mjs';

const LOADER_MAX_MS = 1500; // never hide an offline/reconnecting state behind the loader
const SUBMIT_RETRY_BASE_MS = 300;
const SUBMIT_RETRY_CAP_MS = 5000;
const OFFLINE_POLL_MS = 1500;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------- state
const saved = loadSaved();
const state = {
  // Persisted (see services/storage.mjs):
  playerId: saved.playerId || randomId('p'),
  selection: saved.selection ?? 0,
  intent: saved.intent ?? null, // { requestId, choice } — kept until New Round
  round: saved.round ?? null, // latest server snapshot for the intent
  revealed: saved.revealed ?? false,
  ledger: saved.ledger ?? createLedger(),
  // Session only:
  phase: 'idle', // idle | starting | playing | replaying | revealed
  timeline: null,
  note: '',
  submitRetry: 0,
};
const persist = () => save(state);

const view = createView();
const stage = createStageRenderer(view.stage, {
  onResize: () => { if (state.timeline && !frameId) drawFrame(); }, // repaint a paused frame
});
const feed = createFeed({
  getCursor: () => state.ledger.cursor,
  onEvent,
  onOpen: () => { view.reveal(); reconcile(); },
  onStatus: (kind, text) => { view.setConnection(kind, text); render(); },
});

// ---------------------------------------------------------------- server I/O
let submitTimer;
let submitting = false;

async function submit() {
  const intent = state.intent;
  if (!intent || state.round || submitting) return;
  clearTimeout(submitTimer);
  submitting = true;
  let response;
  try { response = await api.startRound({ ...intent, playerId: state.playerId }); } catch { response = undefined; }
  submitting = false;
  if (state.intent?.requestId !== intent.requestId) return; // late reply for an old intent
  if (response?.status === 202) { state.submitRetry = 0; adopt(response.body); return; }
  const code = response?.body?.error?.code;
  if (response && response.status < 500 && code !== 'ROUND_IN_PROGRESS') {
    // Definitive rejection: the server created nothing for this intent.
    abandon(`The server rejected this round (${code ?? response.status}).`);
    return;
  }
  // ROUND_IN_PROGRESS: this player's previous round (e.g. from another tab) is still
  // pending on the server and will finish by itself. Timeout/5xx/network: the outcome
  // is unknown. Either way, retry the SAME requestId — it can never create two rounds.
  const wait = api.backoff(state.submitRetry++, SUBMIT_RETRY_BASE_MS, SUBMIT_RETRY_CAP_MS);
  state.note = code === 'ROUND_IN_PROGRESS'
    ? 'Your previous round is still finishing — starting yours right after…'
    : 'Server slow — retrying the same request…';
  submitTimer = setTimeout(submit, wait);
  render();
}

// Accept a server snapshot for the current intent from any source (POST, GET, feed).
function adopt(round) {
  if (!round || !state.intent || round.requestId !== state.intent.requestId || round.playerId !== state.playerId) return;
  if (state.round?.status === 'completed') return; // never downgrade a final result
  state.round = round;
  state.ledger = recordCompleted(state.ledger, round, state.playerId);
  if (state.phase === 'starting') state.phase = 'playing';
  if (round.status === 'completed' && state.timeline && state.phase === 'playing') {
    state.timeline = Timeline.setResult(state.timeline, round.target);
  }
  state.note = '';
  persist();
  render();
}

async function reconcile() {
  if (!state.intent || state.revealed) return;
  if (!state.round) return submit(); // idempotent resend recovers a lost acceptance
  if (state.round.status === 'completed') return;
  const roundId = state.round.roundId;
  try {
    const round = await api.getRound(roundId);
    if (round && state.round?.roundId === roundId) adopt(round);
  } catch { /* next reconnect/poll will try again */ }
}

function onEvent(event) {
  const { ledger, applied } = applyEvent(state.ledger, event, state.playerId);
  if (!applied) return; // already applied (redelivery after reconnect)
  state.ledger = ledger;
  adopt(event.round); // no-op unless it belongs to the current intent
  persist();
  renderStats();
}

// While a result is outstanding and the feed is down, poll the round over HTTP.
setInterval(() => {
  if (!feed.isOpen() && state.intent && !state.revealed) reconcile();
}, OFFLINE_POLL_MS);

// ---------------------------------------------------------------- controls
function select(choice) {
  if (state.phase !== 'idle') return;
  state.selection = choice;
  persist();
  render();
  view.beacons[choice].focus();
}

function play() {
  if (state.phase !== 'idle') return; // double-click guard
  state.intent = { requestId: randomId('q'), choice: state.selection };
  state.round = null;
  state.revealed = false;
  state.submitRetry = 0;
  persist(); // the intent survives refresh before the request is even sent
  state.phase = 'starting';
  view.setResult(`Signal sent from ${BEACON_NAMES[state.intent.choice]} — waiting for the server to decide…`);
  startTimeline(state.intent.choice, null);
  submit();
}

function abandon(message) {
  clearTimeout(submitTimer);
  resetRound();
  view.setResult(message);
  render();
}

function togglePause() {
  if (!state.timeline || !isAnimating(state.phase)) return;
  state.timeline = state.timeline.paused ? Timeline.resume(state.timeline) : Timeline.pause(state.timeline);
  if (state.timeline.paused) stopLoop(); else startLoop();
  render();
}

function skip() {
  if (!state.timeline || !isAnimating(state.phase)) return;
  state.timeline = Timeline.resume(Timeline.skip(state.timeline));
  startLoop();
  render();
}

function replay() {
  if (state.phase !== 'revealed' || state.round?.status !== 'completed') return;
  state.phase = 'replaying'; // presentation only: no request, no score change
  startTimeline(state.round.choice, state.round.target);
  view.setResult('Replaying the recorded result…');
}

function newRound() {
  if (state.phase !== 'revealed') return;
  resetRound();
  view.setResult('Choose a beacon and press Play.');
  render();
}

function resetRound() {
  stopLoop();
  state.intent = null;
  state.round = null;
  state.revealed = false;
  state.timeline = null;
  state.phase = 'idle';
  state.note = '';
  persist();
  stage.clear();
}

view.beacons.forEach((beacon, i) => beacon.addEventListener('click', () => select(i)));
// One page-wide handler (Safari doesn't focus buttons on click/Tab by default).
const KEY_ACTIONS = {
  select: action => select(action.choice),
  move: action => select((state.selection + action.delta + BEACON_NAMES.length) % BEACON_NAMES.length),
  play, pause: togglePause, skip, replay, newRound,
};
document.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
  const focused = event.target;
  const target = focused?.classList?.contains('beacon') ? 'beacon' : focused?.tagName === 'BUTTON' ? 'button' : 'other';
  const action = keyAction(event.key, state.phase, target);
  if (!action) return;
  event.preventDefault(); // e.g. stop arrows/Space from scrolling the page
  KEY_ACTIONS[action.type](action);
});
view.buttons.play.addEventListener('click', play);
view.buttons.pause.addEventListener('click', togglePause);
view.buttons.skip.addEventListener('click', skip);
view.buttons.replay.addEventListener('click', replay);
view.buttons.newRound.addEventListener('click', newRound);

// ---------------------------------------------------------------- animation loop
// Exactly one requestAnimationFrame loop; starting a timeline discards the old one.
let frameId = 0;
let lastFrame = 0;

function startTimeline(choice, target) {
  stopLoop();
  stage.clear();
  state.timeline = Timeline.createTimeline({ choice, target, reduced: reducedMotion.matches });
  render();
  startLoop();
}
function startLoop() {
  if (frameId || !state.timeline || state.timeline.paused) return;
  lastFrame = performance.now();
  frameId = requestAnimationFrame(frame);
}
function stopLoop() {
  cancelAnimationFrame(frameId);
  frameId = 0;
}
function frame(now) {
  frameId = 0;
  state.timeline = Timeline.advance(state.timeline, now - lastFrame);
  lastFrame = now;
  const sampled = drawFrame();
  if (sampled.phase === 'done') return finish();
  frameId = requestAnimationFrame(frame);
}
function drawFrame() {
  const sampled = Timeline.sample(state.timeline);
  stage.draw(state.timeline, sampled, state.round);
  renderText(sampled);
  return sampled;
}

function finish() {
  const replayed = state.phase === 'replaying';
  state.phase = 'revealed';
  state.revealed = true;
  persist();
  stage.showReveal(state.round);
  const { text, tone } = describeResult(state.round, { replay: replayed });
  view.setResult(text, tone);
  render();
}

// ---------------------------------------------------------------- rendering
let statsReady = false;
function renderStats() {
  // Hide the current round's point until its reveal has been shown.
  const hidden = ['starting', 'playing'].includes(state.phase) ? state.round?.roundId : null;
  view.renderStats(statsOf(state.ledger, hidden), statsReady);
  statsReady = true;
}
function renderText(sampled = state.timeline && Timeline.sample(state.timeline)) {
  view.setCore(coreText({
    phase: state.phase, paused: state.timeline?.paused, sample: sampled,
    round: state.round, choice: state.timeline?.choice ?? state.selection,
  }));
  view.setNote(stageNote({
    note: state.note, sample: sampled, skipping: state.timeline?.skip, online: feed.isOpen(),
  }));
}
function render() {
  const controls = controlsFor({
    phase: state.phase, paused: state.timeline?.paused, hasResult: state.round?.status === 'completed',
  });
  view.setPhase(state.phase);
  view.renderControls(controls, state.intent?.choice ?? state.selection);
  renderText();
  renderStats();
}

// ---------------------------------------------------------------- restore after refresh
view.setPlayer(state.playerId);
if (state.intent) {
  if (state.revealed && state.round?.status === 'completed') {
    state.phase = 'revealed';
    stage.measure();
    stage.showReveal(state.round);
    const { text, tone } = describeResult(state.round);
    view.setResult(text, tone);
  } else {
    state.phase = state.round ? 'playing' : 'starting';
    view.setResult(`Resuming your ${BEACON_NAMES[state.intent.choice]} round…`);
    startTimeline(state.intent.choice, state.round?.status === 'completed' ? state.round.target : null);
    if (!state.round) submit();
  }
}
persist();
render();
feed.start();
setTimeout(view.reveal, LOADER_MAX_MS); // server down? show the honest "Reconnecting…" state

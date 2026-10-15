// Beacon Relay client.
//
// One authoritative source of truth: the server. The client mirrors it.
//   * Intent (requestId, playerId, choice, roundId?) is persisted BEFORE the POST,
//     so a refresh or dropped connection mid-request never loses the round, we
//     replay the same requestId and reconcile.
//   * The WebSocket feed is applied by strictly increasing sequence; the last
//     applied cursor is persisted (throttled) and used to reconnect without gaps.
//   * Score counts unique completed rounds for this player only, so redelivery
//     after a reconnect can never award a point twice.
//   * Two timelines: a "pending" travel while we await the server, and a "reveal"
//     timeline that only ever runs once the round is actually completed. Reveal is
//     never shown for a pending/absent round. Pause affects presentation only;
//     prefers-reduced-motion collapses motion but not the outcome.

const $ = sel => document.querySelector(sel);
const els = {
  connection: $('#connection'), result: $('#result'), score: $('#score'),
  play: $('#play'), pause: $('#pause'), skip: $('#skip'), replay: $('#replay'), neu: $('#new'),
  beacons: [...document.querySelectorAll('.beacon')], pulse: $('.pulse'), stage: $('.stage'),
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const PRESENT_MS = 2500; // reveal presentation length, excluding backend delay
const label = ['Azure', 'Amber', 'Violet'];

// Persistent identity + the completed-round ledger that backs the score.
const playerId = store.get('player', null) || (() => {
  const id = 'player_' + crypto.randomUUID().slice(0, 8);
  store.set('player', id); return id;
})();
const scored = new Set(store.get('scored', [])); // roundIds already counted
let score = store.get('score', 0);
let cursor = store.get('cursor', 0);

// UI state machine: idle | pending | revealing | revealed
let phase = 'idle';
let choice = store.get('choice', 0);
let intent = store.get('intent', null);  // { requestId, playerId, choice, roundId? }
let current = null;                       // the round we're presenting

// ---------- rendering ----------
const setConnection = (text, ok) => { els.connection.textContent = text; els.connection.dataset.ok = ok ? '1' : '0'; };
const renderChoice = () => els.beacons.forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.choice === choice)));
const announce = text => { els.result.textContent = text; };
function renderControls() {
  els.play.disabled = phase !== 'idle';
  els.pause.disabled = phase !== 'pending' && phase !== 'revealing';
  els.skip.disabled = phase !== 'pending' && phase !== 'revealing';
  els.replay.disabled = !(phase === 'revealed' && current?.status === 'completed');
  els.neu.disabled = phase === 'idle';
  els.beacons.forEach(b => { b.disabled = phase !== 'idle'; });
}

// ---------- single rAF timeline (pending travel, then reveal) ----------
let anim = null; // { elapsed, last, paused, raf, duration, from, to, reveal }
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
function beaconCenter(i) {
  const s = els.stage.getBoundingClientRect(), b = els.beacons[i].getBoundingClientRect();
  return { x: b.left + b.width / 2 - s.left, y: b.top + b.height / 2 - s.top };
}
const restPoint = () => ({ x: els.stage.clientWidth / 2, y: els.stage.clientHeight * 0.18 });
function stopAnim() { if (anim?.raf) cancelAnimationFrame(anim.raf); anim = null; }
function placePulse(x, y) { els.pulse.style.transform = `translate(${x - 8}px, ${y - 8}px)`; }

// Travel from current rest toward a beacon. `reveal` decides what happens at t=1:
// a pending run just holds; a reveal run calls finishReveal (only when completed).
function runTimeline(targetIndex, { reveal, duration }) {
  stopAnim();
  const from = restPoint();
  const to = beaconCenter(targetIndex);
  if (reducedMotion.matches) { placePulse(to.x, to.y); if (reveal) finishReveal(); return; }
  anim = { elapsed: 0, last: performance.now(), paused: false, duration, reveal };
  const frame = now => {
    if (!anim) return;
    const dt = now - anim.last; anim.last = now;
    if (!anim.paused) anim.elapsed += dt;
    const t = Math.min(1, anim.elapsed / anim.duration);
    const e = easeInOut(t);
    placePulse(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    if (t >= 1) { if (anim.reveal) finishReveal(); else anim.raf = requestAnimationFrame(frame); return; }
    anim.raf = requestAnimationFrame(frame);
  };
  anim.raf = requestAnimationFrame(frame);
}
const startPending = idx => runTimeline(idx, { reveal: false, duration: 900 });
const startReveal = idx => { phase = 'revealing'; renderControls(); runTimeline(idx, { reveal: true, duration: PRESENT_MS }); };

function finishReveal() {
  if (current?.status !== 'completed') return; // never reveal a pending/absent round
  stopAnim();
  phase = 'revealed';
  const r = current;
  els.stage.dataset.reveal = r.score ? 'match' : 'miss';
  els.beacons[r.target]?.classList.add('is-target');
  announce(`${r.score ? 'Match' : 'Miss'}. You chose ${label[r.choice]} (${r.choice}); signal was ${label[r.target]} (${r.target}). +${r.score} point.`);
  renderControls();
}

// ---------- applying server state ----------
function updateScore(r) {
  if (r.status !== 'completed' || r.playerId !== playerId || scored.has(r.roundId)) return;
  scored.add(r.roundId); score += r.score; // unique completed rounds only
  store.set('scored', [...scored]); store.set('score', score);
  els.score.textContent = String(score);
}
function onRound(r) {
  updateScore(r);
  // Adopt the round we're presenting, or, after a refresh, when `current` is not
  // yet set, the in-flight round named by our persisted intent.
  const mine = current ? r.roundId === current.roundId : r.roundId === intent?.roundId;
  if (!mine) return; // stale / another player's round
  current = r;
  if (r.status === 'completed' && phase !== 'revealing' && phase !== 'revealed') startReveal(r.target);
}
// Cursor is persisted on a throttle: the global feed can be busy and only the
// latest value matters for reconnect.
let cursorTimer = null;
function persistCursor() { if (cursorTimer) return; cursorTimer = setTimeout(() => { cursorTimer = null; store.set('cursor', cursor); }, 500); }
function applyEvent(ev) {
  if (ev.sequence <= cursor) return; // already applied; ignore redelivery
  cursor = ev.sequence; persistCursor();
  onRound(ev.round);
}

// ---------- WebSocket with bounded-backoff reconnect ----------
let ws, backoff = 500;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/stream?after=${cursor}`);
  ws.onopen = () => { setConnection('Connected', true); backoff = 500; reconcile(); };
  ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.type === 'event') applyEvent(m.event); } catch { /* ignore */ } };
  ws.onclose = () => { setConnection('Reconnecting...', false); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 8000); };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

// On (re)connect or refresh, reconcile the in-flight round directly over HTTP so
// we never sit waiting on an event we may have missed while disconnected.
async function reconcile() {
  if (!intent) return;
  try {
    if (intent.roundId) {
      const r = await (await fetch(`/rounds/${encodeURIComponent(intent.roundId)}`)).json();
      if (!r.error) onRound(r);
    } else {
      await submit({ requestId: intent.requestId, playerId, choice: intent.choice });
    }
  } catch { /* the WS feed will catch us up */ }
}

// ---------- actions ----------
async function submit(payload) {
  const res = await fetch('/rounds', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (res.status === 202 && !body.error) {
    intent = { requestId: payload.requestId, playerId: payload.playerId, choice: payload.choice, roundId: body.roundId };
    store.set('intent', intent);
    current = body;
    if (body.status === 'completed') startReveal(body.target);
    return body;
  }
  return body; // conflict/in-progress: surfaced by caller
}

async function play() {
  if (phase !== 'idle') return; // guard double clicks
  phase = 'pending';
  els.stage.dataset.reveal = ''; els.beacons.forEach(b => b.classList.remove('is-target'));
  announce('Pulse away. Awaiting the authoritative signal...');
  renderControls();
  // Persist intent BEFORE the request so a refresh mid-POST can still recover it.
  const payload = { requestId: crypto.randomUUID(), playerId, choice };
  intent = { requestId: payload.requestId, playerId, choice };
  store.set('intent', intent);
  startPending(choice); // travel toward the chosen beacon while we wait
  const body = await submit(payload).catch(() => null);
  if (!body || body.error) {
    phase = 'idle'; stopAnim(); intent = null; store.del('intent');
    announce('Could not start the round. Try again.'); renderControls();
  }
}

function pauseResume() {
  if (!anim) return;
  anim.paused = !anim.paused; anim.last = performance.now();
  els.pause.textContent = anim.paused ? 'Resume' : 'Pause';
}
function skip() {
  if (current?.status === 'completed') finishReveal();
  // if still pending, there is nothing to reveal yet, honestly keep waiting.
}
function replay() {
  if (current?.status !== 'completed') return;
  els.stage.dataset.reveal = ''; els.beacons.forEach(b => b.classList.remove('is-target'));
  startReveal(current.target); // no StartRound, no score change
}
function newRound() {
  stopAnim(); phase = 'idle'; current = null; intent = null; store.del('intent');
  els.stage.dataset.reveal = ''; els.beacons.forEach(b => b.classList.remove('is-target'));
  els.pause.textContent = 'Pause'; const p = restPoint(); placePulse(p.x, p.y);
  announce('Choose a beacon and press Play.'); renderControls();
}

// ---------- wiring ----------
els.beacons.forEach(b => b.addEventListener('click', () => {
  if (phase !== 'idle') return;
  choice = +b.dataset.choice; store.set('choice', choice); renderChoice();
}));
els.play.onclick = play;
els.pause.onclick = pauseResume;
els.skip.onclick = skip;
els.replay.onclick = replay;
els.neu.onclick = newRound;
document.addEventListener('keydown', e => {
  if (e.key >= '1' && e.key <= '3' && phase === 'idle') { choice = +e.key - 1; store.set('choice', choice); renderChoice(); }
  if (e.key === 'Enter' && phase === 'idle') play();
});
addEventListener('resize', () => { if (phase === 'idle') { const p = restPoint(); placePulse(p.x, p.y); } });
addEventListener('pagehide', () => store.set('cursor', cursor)); // flush throttled cursor

// ---------- boot ----------
els.score.textContent = String(score);
renderChoice();
const rest = restPoint(); placePulse(rest.x, rest.y);
if (intent) { phase = 'pending'; choice = intent.choice; renderChoice(); announce('Reconnecting to your round...'); }
else announce('Choose a beacon and press Play.');
renderControls();
setConnection('Connecting...', false);
connect();

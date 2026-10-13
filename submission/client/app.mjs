import { GameState } from './model.mjs';
import { AnimationLoop } from './timeline.mjs';

const STORAGE = 'beacon-relay.v1';
const names = ['Azure', 'Amber', 'Violet'];
const $ = (selector) => document.querySelector(selector);
const beacons = [...document.querySelectorAll('[data-choice]')];
let saved;
try {
  saved = JSON.parse(localStorage.getItem(STORAGE));
} catch {
  /* first visit or unavailable storage */
}
const state = new GameState(saved, crypto.randomUUID());
const motion = matchMedia('(prefers-reduced-motion: reduce)');
state.reducedMotion = motion.matches;
let storageWarning = '',
  networkMessage = '',
  connected = false,
  stopped = false;
let socket, reconnectTimer, reconcileTimer, controller;
let reconnectAttempts = 0,
  retryAttempts = 0,
  busy = false;

function save() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(state.snapshot()));
  } catch {
    storageWarning =
      'Browser storage unavailable; keep this tab open to preserve your player.';
  }
}
const needsReconciliation = () =>
  Boolean(state.intent && state.round?.status !== 'completed');
function scheduleReconcile(ms = 1000) {
  clearTimeout(reconcileTimer);
  if (!stopped && needsReconciliation())
    reconcileTimer = setTimeout(reconcile, ms);
}
async function api(path, options = {}) {
  controller = new AbortController();
  const active = controller;
  const timeout = setTimeout(() => active.abort(), 4000);
  try {
    const response = await fetch(path, {
      ...options,
      signal: active.signal,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const body = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(body.error?.code ?? 'REQUEST_FAILED'), {
        status: response.status,
      });
    return body;
  } finally {
    clearTimeout(timeout);
    if (controller === active) controller = null;
  }
}
async function recoverPlayerRound(requestId) {
  // Another tab may own this player's pending round. Recover from server history.
  let after = 0;
  const rounds = new Map();
  for (;;) {
    const page = await api(`/events?after=${after}&limit=100`);
    if (state.intent?.requestId !== requestId) return;
    for (const event of page.events) {
      if (event.round.playerId === state.playerId)
        rounds.set(event.round.roundId, event.round);
    }
    after = page.nextCursor;
    if (page.events.length < 100) break;
  }
  for (const round of rounds.values()) {
    if (round.status === 'completed')
      state.ledger.set(round.roundId, round.score);
  }
  const latest = [...rounds.values()].at(-1);
  const pending = [...rounds.values()].find(
    (round) => round.status === 'accepted',
  );
  const round = pending ?? latest;
  if (round) {
    state.intent = {
      requestId: round.requestId,
      playerId: round.playerId,
      choice: round.choice,
    };
    state.round = null;
    state.applyRound(round);
  }
}
async function reconcile() {
  if (busy || stopped || !needsReconciliation()) return;
  busy = true;
  const intent = { ...state.intent };
  const key = state.round?.roundId;
  try {
    const round = key
      ? await api(`/rounds/${encodeURIComponent(key)}`)
      : await api('/rounds', { method: 'POST', body: JSON.stringify(intent) });
    if (stopped || state.intent?.requestId !== intent.requestId) return;
    state.applyRound(round);
    retryAttempts = 0;
    networkMessage = '';
  } catch (error) {
    if (stopped || state.intent?.requestId !== intent.requestId) return;
    retryAttempts++;
    if (error.message === 'ROUND_IN_PROGRESS') {
      try {
        await recoverPlayerRound(intent.requestId);
        networkMessage = 'Recovered your round from another tab.';
      } catch {
        networkMessage = 'Recovering your existing round…';
      }
    } else if (
      error.status === 400 ||
      error.message === 'IDEMPOTENCY_CONFLICT'
    ) {
      networkMessage = `Request rejected: ${error.message}. Refresh to reconcile before continuing.`;
      retryAttempts = Infinity;
    } else
      networkMessage =
        'Connection interrupted. Retrying the same round request…';
  } finally {
    busy = false;
    save();
    render();
    if (retryAttempts !== Infinity)
      scheduleReconcile(
        retryAttempts
          ? Math.min(8000, 400 * 2 ** Math.min(retryAttempts, 5)) +
              Math.random() * 200
          : 1000,
      );
  }
}
function connect() {
  clearTimeout(reconnectTimer);
  if (stopped) return;
  if (
    socket &&
    [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)
  )
    return;
  const active = new WebSocket(
    `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream?after=${state.cursor}`,
  );
  socket = active;
  active.onopen = () => {
    if (socket !== active || stopped) return;
    connected = true;
    reconnectAttempts = 0;
    render();
    scheduleReconcile(0);
  };
  active.onmessage = (message) => {
    if (socket !== active || stopped) return;
    try {
      const frame = JSON.parse(message.data);
      if (frame.type !== 'event') return;
      if (state.applyEvent(frame.event)) {
        if (state.round?.status === 'completed') {
          networkMessage = '';
          retryAttempts = 0;
        }
        save();
        render();
      }
    } catch {
      active.close(1000, 'RECONCILE');
    }
  };
  active.onerror = () => {
    /* close owns reconnection */
  };
  active.onclose = () => {
    if (socket !== active || stopped) return;
    connected = false;
    render();
    const delay = Math.min(8000, 250 * 2 ** Math.min(reconnectAttempts++, 5));
    reconnectTimer = setTimeout(connect, delay + Math.random() * 200);
    scheduleReconcile(0);
  };
}

function text(selector, value) {
  const element = $(selector);
  if (element.textContent !== value) element.textContent = value;
}
function positionPulse(time = 0) {
  const stage = $('.stage'),
    pulse = $('.pulse');
  let x = 50,
    y = 20;
  if (state.phase === 'travel' || state.phase === 'revealed') {
    const t = state.phase === 'revealed' ? 1 : state.progress;
    const eased = t * t * (3 - 2 * t);
    const end = [20, 50, 80][state.round.target];
    // A normalized cubic Bézier remains crisp and aligned on resize/high DPI.
    x =
      (1 - eased) ** 3 * 50 +
      3 * (1 - eased) ** 2 * eased * 50 +
      3 * (1 - eased) * eased ** 2 * end +
      eased ** 3 * end;
    y =
      (1 - eased) ** 3 * 20 +
      3 * (1 - eased) ** 2 * eased * 38 +
      3 * (1 - eased) * eased ** 2 * 42 +
      eased ** 3 * 64;
  } else if (
    ['submitting', 'waiting'].includes(state.phase) &&
    !state.reducedMotion
  ) {
    x += Math.sin(time / 450) * 3;
    y += Math.cos(time / 450) * 1.5;
  }
  pulse.style.transform = `translate(${(stage.clientWidth * x) / 100}px, ${(stage.clientHeight * y) / 100}px) translate(-50%, -50%)`;
}
const loop = new AnimationLoop((delta, time) => {
  const before = state.phase;
  state.tick(delta);
  if (before !== state.phase) {
    save();
    render();
  }
  positionPulse(time);
  return (
    !stopped &&
    !document.hidden &&
    !state.paused &&
    (state.phase === 'travel' ||
      (!state.reducedMotion && ['submitting', 'waiting'].includes(state.phase)))
  );
});
function render() {
  const active = ['submitting', 'waiting', 'travel'].includes(state.phase);
  const revealed = state.phase === 'revealed';
  $('.stage').dataset.phase = state.phase;
  $('.stage').dataset.outcome = revealed
    ? state.round.score
      ? 'match'
      : 'miss'
    : '';
  for (const [index, beacon] of beacons.entries()) {
    beacon.setAttribute('aria-pressed', String(state.choice === index));
    beacon.disabled = state.phase !== 'select';
    beacon.classList.toggle('target', revealed && state.round.target === index);
    beacon.classList.toggle('chosen', state.choice === index);
  }
  for (const [index, path] of [
    ...document.querySelectorAll('.route'),
  ].entries()) {
    path.classList.toggle('selected', state.choice === index);
    path.classList.toggle(
      'lit',
      ['travel', 'revealed'].includes(state.phase) &&
        state.round.target === index,
    );
  }
  $('#play').disabled = state.phase !== 'select';
  $('#pause').disabled = !active;
  $('#skip').disabled = !active || state.skipped;
  $('#replay').disabled = !revealed;
  $('#new').disabled = !revealed;
  text('#pause', state.paused ? 'Resume' : 'Pause');
  text('#play', state.phase === 'submitting' ? 'Sending…' : 'Play round');
  text('#score', String(state.score));
  text(
    '#round-count',
    `${state.ledger.size} round${state.ledger.size === 1 ? '' : 's'} completed`,
  );
  text('#connection', connected ? 'Live connection' : 'Reconnecting…');
  $('#connection').dataset.connected = String(connected);
  const phaseLabel = state.paused
    ? 'Presentation paused'
    : state.phase === 'select'
      ? 'Ready to relay'
      : state.phase === 'submitting'
        ? 'Sending your signal'
        : state.phase === 'waiting'
          ? 'Awaiting server signal'
          : state.phase === 'travel'
            ? state.isReplay
              ? 'Replaying signal'
              : 'Signal in transit'
            : 'Relay complete';
  text('#phase', phaseLabel);
  text(
    '#selection',
    `${String(state.choice + 1).padStart(2, '0')} / ${names[state.choice]}`,
  );
  let result = 'Choose a beacon, then send your signal.';
  if (state.phase === 'submitting')
    result = 'Sending your choice. Repeated clicks cannot start another round.';
  if (state.phase === 'waiting')
    result = state.skipped
      ? 'Skip requested. Waiting for the server result…'
      : 'The server is resolving your round. Your signal is safely in flight.';
  if (state.phase === 'travel')
    result = state.isReplay
      ? 'Replaying the recorded result. Your score stays the same.'
      : 'Signal received. Following the relay to its destination…';
  if (revealed)
    result = `${state.round.score ? 'Signal matched!' : 'Signal missed.'} You chose ${names[state.round.choice]}; the relay reached ${names[state.round.target]}. +${state.round.score} demo point${state.round.score === 1 ? '' : 's'}.`;
  if (state.paused) result += ' Presentation paused; the server continues.';
  text('#result', result);
  text('#notice', storageWarning || networkMessage);
  positionPulse();
  if (
    !stopped &&
    !document.hidden &&
    !state.paused &&
    (state.phase === 'travel' ||
      (!state.reducedMotion && ['submitting', 'waiting'].includes(state.phase)))
  )
    loop.start();
  else loop.stop();
  if (!needsReconciliation()) clearTimeout(reconcileTimer);
}

for (const beacon of beacons)
  beacon.onclick = () => {
    state.select(Number(beacon.dataset.choice));
    save();
    render();
  };
$('#play').onclick = () => {
  if (!state.begin(crypto.randomUUID())) return;
  networkMessage = '';
  retryAttempts = 0;
  save();
  render();
  void reconcile();
};
$('#pause').onclick = () => {
  state.pause();
  render();
};
$('#skip').onclick = () => {
  state.skip();
  save();
  render();
};
$('#replay').onclick = () => {
  state.replay();
  render();
};
$('#new').onclick = () => {
  if (state.newRound()) {
    networkMessage = '';
    save();
    render();
    beacons[state.choice].focus();
  }
};
document.addEventListener('keydown', (event) => {
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    state.phase !== 'select'
  )
    return;
  if (['1', '2', '3'].includes(event.key)) {
    event.preventDefault();
    state.select(Number(event.key) - 1);
    save();
    render();
    beacons[state.choice].focus();
  } else if (
    ['ArrowLeft', 'ArrowRight'].includes(event.key) &&
    beacons.includes(document.activeElement)
  ) {
    event.preventDefault();
    state.select((state.choice + (event.key === 'ArrowRight' ? 1 : 2)) % 3);
    save();
    render();
    beacons[state.choice].focus();
  }
});
motion.addEventListener('change', () => {
  state.reducedMotion = motion.matches;
  render();
});
window.addEventListener('resize', () => positionPulse());
document.addEventListener('visibilitychange', () => {
  render();
  if (!document.hidden) {
    connect();
    scheduleReconcile(0);
  }
});
window.addEventListener('online', () => {
  connect();
  scheduleReconcile(0);
});
window.addEventListener('offline', () => {
  connected = false;
  socket?.close();
  render();
});
window.addEventListener('pagehide', () => {
  stopped = true;
  save();
  loop.stop();
  clearTimeout(reconnectTimer);
  clearTimeout(reconcileTimer);
  controller?.abort();
  socket?.close();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    stopped = false;
    render();
    connect();
    scheduleReconcile(0);
  }
});
save();
render();
connect();
scheduleReconcile(0);

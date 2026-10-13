import {
  clamp01,
  easeInOut,
  mixPoint,
  frameDelta,
  timelineStage,
} from './timeline.mjs';

const connection = document.querySelector('#connection');
const stage = document.querySelector('.stage');
const pulse = document.querySelector('.pulse');
const result = document.querySelector('#result');
const scoreLabel = document.querySelector('#score');
const beacons = [...document.querySelectorAll('.beacon')];
const playButton = document.querySelector('#play');
const pauseButton = document.querySelector('#pause');
const skipButton = document.querySelector('#skip');
const replayButton = document.querySelector('#replay');
const newButton = document.querySelector('#new');

const STORAGE_KEY = 'beacon-relay-session-v1';
const BEACON_NAMES = ['Azure', 'Amber', 'Violet'];
const MAX_BACKOFF_MS = 8000;
const NORMAL_TRAVEL_MS = 1800;
const NORMAL_FINAL_MS = 450;
const REDUCED_TRAVEL_MS = 250;
const REDUCED_FINAL_MS = 100;

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function validId(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function readSavedState() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    saved = {};
  }

  const playerId = validId(saved.playerId)
    ? saved.playerId
    : makeId('player');

  const validChoice = Number.isInteger(saved.selectedChoice)
    && saved.selectedChoice >= 0
    && saved.selectedChoice <= 2;

  const possibleIntent = saved.currentIntent;
  const currentIntent = possibleIntent
    && validId(possibleIntent.requestId)
    && possibleIntent.playerId === playerId
    && Number.isInteger(possibleIntent.choice)
    && possibleIntent.choice >= 0
    && possibleIntent.choice <= 2
    ? possibleIntent
    : null;

  const currentRound = saved.currentRound
    && typeof saved.currentRound.roundId === 'string'
    ? saved.currentRound
    : null;

  const allowedPhases = new Set([
    'idle',
    'pending',
    'animating',
    'revealed',
  ]);

  let phase = allowedPhases.has(saved.phase) ? saved.phase : 'idle';

  if (!currentIntent) phase = 'idle';
  if (phase === 'revealed' && currentRound?.status !== 'completed') {
    phase = 'idle';
  }
  if (phase !== 'idle' && !currentIntent) phase = 'idle';

  return {
    playerId,
    selectedChoice: validChoice ? saved.selectedChoice : 0,
    currentIntent: phase === 'idle' && !currentIntent
      ? null
      : currentIntent,
    currentRound: phase === 'idle' && !currentIntent
      ? null
      : currentRound,
    phase,
    cursor: Number.isSafeInteger(saved.lastAppliedCursor)
      && saved.lastAppliedCursor >= 0
      ? saved.lastAppliedCursor
      : 0,
    completedRoundIds: Array.isArray(saved.completedRoundIds)
      ? saved.completedRoundIds.filter(
          value => typeof value === 'string',
        )
      : [],
  };
}

const state = readSavedState();
const completedRoundIds = new Set(state.completedRoundIds);

let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let retryTimer = null;
let retryAttempts = 0;
let activeFrame = null;
let timeline = null;
let eventQueue = Promise.resolve();
let reconcileInFlight = false;
let disposed = false;

function persist() {
  state.completedRoundIds = [...completedRoundIds];

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      playerId: state.playerId,
      selectedChoice: state.selectedChoice,
      currentIntent: state.currentIntent,
      currentRound: state.currentRound,
      phase: state.phase,
      lastAppliedCursor: state.cursor,
      completedRoundIds: state.completedRoundIds,
    }));
  } catch {
    // The game still works if browser storage is unavailable.
  }
}

function setMessage(message) {
  result.textContent = message;
}

function setConnection(message) {
  connection.textContent = message;
}

function isActive() {
  return state.phase === 'pending'
    || state.phase === 'animating';
}

function updateUI() {
  for (const button of beacons) {
    const choice = Number(button.dataset.choice);
    button.setAttribute(
      'aria-pressed',
      String(choice === state.selectedChoice),
    );
    button.disabled = state.phase !== 'idle';

    const round = state.phase === 'revealed'
      ? state.currentRound
      : null;

    button.classList.toggle(
      'is-target',
      Boolean(round && round.target === choice),
    );

    button.classList.toggle(
      'is-miss',
      Boolean(round && round.choice === choice && round.score === 0),
    );

    button.classList.toggle(
      'is-match',
      Boolean(round && round.target === choice && round.score === 1),
    );
  }

  playButton.disabled = state.phase !== 'idle';

  pauseButton.textContent = timeline?.paused ? 'Resume' : 'Pause';
  pauseButton.disabled = !isActive()
    || !timeline
    || timeline.skipRequested;

  skipButton.disabled = !isActive()
    || !timeline
    || timeline.skipRequested;

  replayButton.disabled = !(
    state.phase === 'revealed'
    && state.currentRound?.status === 'completed'
  );

  newButton.disabled = state.phase !== 'revealed';
  scoreLabel.textContent = String(completedRoundIds.size);
}

function apiError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  let body = {};

  try {
    body = await response.json();
  } catch {
    // The HTTP status is still useful if the body is not JSON.
  }

  if (!response.ok) {
    throw apiError(
      body?.error?.code || `HTTP_${response.status}`,
      response.status,
      body?.error?.code,
    );
  }

  return body;
}

function beaconPoint(choice) {
  const beacon = beacons.find(
    button => Number(button.dataset.choice) === choice,
  );

  const stageRect = stage.getBoundingClientRect();
  const rect = beacon.getBoundingClientRect();

  return {
    x: (
      (rect.left + rect.width / 2 - stageRect.left)
      / stageRect.width
    ) * 100,
    y: (
      (rect.top + rect.height / 2 - stageRect.top)
      / stageRect.height
    ) * 100,
  };
}

function pulseCenter() {
  return { x: 50, y: 50 };
}

function ringConfiguration(choice) {
  const start = beaconPoint(choice);
  const angle = Math.atan2(
    (start.y - 50) / 30,
    (start.x - 50) / 24,
  );

  return { angle, point: ringPoint(angle) };
}

function ringPoint(angle) {
  return {
    x: 50 + 24 * Math.cos(angle),
    y: 50 + 30 * Math.sin(angle),
  };
}

function placePulse(point) {
  pulse.style.left = `${point.x}%`;
  pulse.style.top = `${point.y}%`;
}

function cancelFrame() {
  if (activeFrame !== null) {
    cancelAnimationFrame(activeFrame);
  }
  activeFrame = null;
}

function scheduleFrame() {
  if (
    !timeline
    || timeline.paused
    || document.hidden
    || activeFrame !== null
  ) {
    return;
  }

  activeFrame = requestAnimationFrame(drawFrame);
}

function startTimeline(choice, completedRound = null, isReplay = false) {
  cancelFrame();

  const reducedMotion = window.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  ).matches ?? false;

  const travelMs = reducedMotion
    ? REDUCED_TRAVEL_MS
    : NORMAL_TRAVEL_MS;

  const finalMs = reducedMotion
    ? REDUCED_FINAL_MS
    : NORMAL_FINAL_MS;

  const config = ringConfiguration(choice);

  timeline = {
    choice,
    elapsed: 0,
    lastNow: null,
    paused: false,
    skipRequested: false,
    waitingForResult: false,
    travelMs,
    approachMs: reducedMotion ? 90 : 650,
    finalMs,
    angle: config.angle,
    resultRound: completedRound?.status === 'completed'
      ? completedRound
      : null,
    resultAvailableAt: completedRound?.status === 'completed'
      ? 0
      : null,
    isReplay,
  };

  placePulse(beaconPoint(choice));

  setMessage(isReplay
    ? 'Replaying the recorded result. No new round is being created.'
    : 'Sending your choice to the server…');

  updateUI();
  scheduleFrame();
}

function drawFrame(now) {
  activeFrame = null;

  if (!timeline || timeline.paused || document.hidden) return;

  timeline.elapsed += frameDelta(timeline.lastNow, now);

  timeline.lastNow = now;

  const t = timeline.elapsed;
  const start = beaconPoint(timeline.choice);
  const ring = ringPoint(timeline.angle);

  const phase = timelineStage(
    t,
    timeline.approachMs,
    timeline.travelMs,
    Boolean(timeline.resultRound),
  );

  if (timeline.skipRequested) {
    placePulse(ring);
    return;
  }

  if (phase === 'approach') {
    placePulse(mixPoint(
      start,
      ring,
      easeInOut(t / timeline.approachMs),
    ));
    scheduleFrame();
    return;
  }

  if (phase === 'travel') {
    const progress = (
      (t - timeline.approachMs)
      / (timeline.travelMs - timeline.approachMs)
    );

    const angle = timeline.angle + 2 * Math.PI * progress;
    placePulse(ringPoint(angle));
    scheduleFrame();
    return;
  }

  if (phase === 'waiting') {
    placePulse(ring);
    timeline.waitingForResult = true;

    if (state.phase === 'animating') {
      setMessage(
        'Pulse is travelling. Waiting for the server to confirm the target…',
      );
    } else {
      setMessage(
        'Your request is still pending. Waiting for the server…',
      );
    }

    return;
  }

  const finalStart = Math.max(
    timeline.travelMs,
    timeline.resultAvailableAt ?? timeline.travelMs,
  );

  const progress = clamp01(
    (t - finalStart) / timeline.finalMs,
  );

  const target = beaconPoint(timeline.resultRound.target);

  placePulse(mixPoint(ring, target, easeInOut(progress)));

  if (progress >= 1) {
    revealRound(timeline.resultRound);
    return;
  }

  scheduleFrame();
}

function resultMessage(round) {
  const chosen = BEACON_NAMES[round.choice] ?? String(round.choice);
  const target = BEACON_NAMES[round.target] ?? String(round.target);
  const verdict = round.score === 1 ? 'MATCH!' : 'MISS.';

  return `${verdict} You chose ${round.choice} (${chosen}); `
    + `the server target was ${round.target} (${target}). `
    + `This round earned ${round.score} point${round.score === 1 ? '' : 's'}. `
    + `Total score: ${completedRoundIds.size}.`;
}

function revealRound(round) {
  if (!round || round.status !== 'completed') return;

  cancelFrame();
  timeline = null;

  state.currentRound = round;
  state.selectedChoice = round.choice;
  state.phase = 'revealed';

  placePulse(beaconPoint(round.target));
  setMessage(resultMessage(round));

  persist();
  updateUI();
}

function attachCompletedResult(round) {
  if (state.phase === 'revealed') return;

  if (!timeline) {
    state.phase = 'animating';
    startTimeline(round.choice, round, false);
  }

  if (!timeline) return;

  timeline.resultRound = round;

  if (timeline.resultAvailableAt === null) {
    timeline.resultAvailableAt = timeline.elapsed;
  }

  if (timeline.skipRequested) {
    revealRound(round);
    return;
  }

  if (timeline.waitingForResult) {
    timeline.lastNow = null;
  }

  timeline.waitingForResult = false;
  scheduleFrame();
}

function acceptRoundResponse(round) {
  const intent = state.currentIntent;

  if (!intent || round.requestId !== intent.requestId) return;

  if (round.status === 'completed') {
    state.currentRound = round;
    persist();
    updateUI();
    attachCompletedResult(round);
    return;
  }

  // Don't let a late accepted response replace a completed result.
  if (state.currentRound?.status === 'completed') return;

  state.currentRound = round;

  if (state.phase === 'pending') {
    state.phase = 'animating';
  }

  retryAttempts = 0;

  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;

  setMessage(
    'Round accepted. The server is calculating the result; the animation cannot change it.',
  );

  persist();
  updateUI();
}

function scheduleRetry(intent, message) {
  if (state.currentIntent?.requestId !== intent.requestId || disposed) {
    return;
  }

  if (retryTimer) clearTimeout(retryTimer);

  const delays = [500, 1000, 2000, 4000, MAX_BACKOFF_MS];
  const delay = delays[Math.min(
    retryAttempts,
    delays.length - 1,
  )];

  retryAttempts += 1;

  setMessage(
    `${message} Retrying safely in ${delay / 1000}s…`,
  );

  retryTimer = setTimeout(() => {
    retryTimer = null;

    if (state.currentIntent?.requestId !== intent.requestId) return;

    void reconcileCurrentRound();
  }, delay);
}

function handleRequestFailure(intent, error) {
  if (state.currentIntent?.requestId !== intent.requestId) return;

  if (error.status === 503 || error.status === 504 || !error.status) {
    scheduleRetry(intent, 'The server response is uncertain.');
    return;
  }

  if (error.code === 'ROUND_IN_PROGRESS') {
    void syncEvents();
    scheduleRetry(intent, 'Another round is still pending for this player.');
    return;
  }

  // Permanent validation or conflict errors are shown to the player.
  cancelFrame();
  timeline = null;

  state.currentIntent = null;
  state.currentRound = null;
  state.phase = 'idle';

  setMessage(
    `Could not start the round: ${error.code || error.message}. Please try again.`,
  );

  persist();
  updateUI();
}

async function postCurrentIntent(intent) {
  if (state.currentIntent?.requestId !== intent.requestId) return;

  try {
    const round = await requestJson('/rounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: intent.requestId,
        playerId: intent.playerId,
        choice: intent.choice,
      }),
    });

    if (state.currentIntent?.requestId !== intent.requestId) return;

    acceptRoundResponse(round);
  } catch (error) {
    handleRequestFailure(intent, error);
  }
}

async function reconcileCurrentRound() {
  const intent = state.currentIntent;

  if (!intent || reconcileInFlight || disposed) return;

  reconcileInFlight = true;

  try {
    if (state.currentIntent?.requestId !== intent.requestId) return;

    if (state.currentRound?.roundId) {
      try {
        const round = await requestJson(
          `/rounds/${encodeURIComponent(state.currentRound.roundId)}`,
        );

        if (state.currentIntent?.requestId === intent.requestId) {
          acceptRoundResponse(round);
        }
      } catch (error) {
        if (error.status === 404) {
          await postCurrentIntent(intent);
        } else {
          handleRequestFailure(intent, error);
        }
      }
    } else {
      await postCurrentIntent(intent);
    }
  } finally {
    reconcileInFlight = false;
  }
}

function applyEvent(event) {
  if (
    !event
    || !Number.isSafeInteger(event.sequence)
    || event.sequence < 1
  ) {
    return;
  }

  if (event.sequence <= state.cursor) return;

  if (event.sequence !== state.cursor + 1) {
    throw new Error(
      `Expected event ${state.cursor + 1}, got ${event.sequence}`,
    );
  }

  const round = event.round;
  let shouldAttachResult = false;

  if (
    round
    && event.type === 'round.accepted'
    && state.currentIntent?.requestId === round.requestId
  ) {
    if (state.currentRound?.status !== 'completed') {
      state.currentRound = round;
    }

    if (state.phase === 'pending') {
      state.phase = 'animating';
    }

    if (state.phase !== 'revealed') {
      setMessage(
        'Round accepted. The energy pulse is travelling while the server works.',
      );
    }
  }

  if (round && event.type === 'round.completed') {
    if (
      round.playerId === state.playerId
      && !completedRoundIds.has(round.roundId)
    ) {
      completedRoundIds.add(round.roundId);
    }

    if (state.currentIntent?.requestId === round.requestId) {
      state.currentRound = round;
      shouldAttachResult = state.phase !== 'revealed';
    }
  }

  state.cursor = event.sequence;

  persist();
  updateUI();

  if (shouldAttachResult) {
    attachCompletedResult(round);
  }
}

async function catchUpEvents(through = Number.POSITIVE_INFINITY) {
  while (!disposed) {
    const page = await requestJson(
      `/events?after=${state.cursor}&limit=100`,
    );

    const events = Array.isArray(page.events) ? page.events : [];

    if (events.length === 0) return;

    const before = state.cursor;

    for (const event of events) {
      if (event.sequence <= state.cursor) continue;

      applyEvent(event);

      if (state.cursor >= through) return;
    }

    if (state.cursor === before || events.length < 100) return;
  }
}

function enqueueEvent(event) {
  eventQueue = eventQueue
    .then(async () => {
      if (
        !event
        || !Number.isSafeInteger(event.sequence)
        || event.sequence <= state.cursor
      ) {
        return;
      }

      if (event.sequence > state.cursor + 1) {
        await catchUpEvents(event.sequence - 1);
      }

      if (event.sequence === state.cursor + 1) {
        applyEvent(event);
      }
    })
    .catch(error => {
      console.warn(
        'Could not apply event yet; reconnect/catch-up will retry.',
        error,
      );
    });

  return eventQueue;
}

function syncEvents() {
  eventQueue = eventQueue
    .then(() => catchUpEvents())
    .catch(error => {
      console.warn(
        'Event catch-up failed; the client will retry.',
        error,
      );
    });

  return eventQueue;
}

function scheduleReconnect() {
  if (disposed || reconnectTimer) return;

  const delay = Math.min(
    500 * (2 ** reconnectAttempts),
    MAX_BACKOFF_MS,
  );

  reconnectAttempts = Math.min(reconnectAttempts + 1, 5);

  setConnection(`Reconnecting in ${Math.ceil(delay / 1000)}s`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, delay);
}

function connectSocket() {
  if (disposed) return;

  setConnection(reconnectAttempts === 0 ? 'Connecting' : 'Reconnecting');

  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';

  const candidate = new WebSocket(
    `${scheme}//${location.host}/stream?after=${state.cursor}`,
  );

  socket = candidate;

  candidate.addEventListener('open', () => {
    if (socket !== candidate) return;

    reconnectAttempts = 0;
    setConnection('Connected');

    void syncEvents();
    void reconcileCurrentRound();
  });

  candidate.addEventListener('message', message => {
    let data;

    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }

    if (data?.type === 'event' && data.event) {
      void enqueueEvent(data.event);
    }
  });

  candidate.addEventListener('error', () => {
    if (socket === candidate) {
      setConnection('Connection error');
    }
  });

  candidate.addEventListener('close', () => {
    if (socket !== candidate) return;

    socket = null;
    setConnection('Disconnected');
    scheduleReconnect();
  });
}

function chooseBeacon(event) {
  if (state.phase !== 'idle') return;

  const choice = Number(event.currentTarget.dataset.choice);

  if (!Number.isInteger(choice) || choice < 0 || choice > 2) return;

  state.selectedChoice = choice;

  setMessage(
    `Beacon ${choice} (${BEACON_NAMES[choice]}) selected. Press Play when ready.`,
  );

  persist();
  updateUI();
}

function playRound() {
  if (state.phase !== 'idle') return;

  const intent = {
    requestId: makeId('intent'),
    playerId: state.playerId,
    choice: state.selectedChoice,
  };

  state.currentIntent = intent;
  state.currentRound = null;
  state.phase = 'pending';

  persist();
  updateUI();

  startTimeline(intent.choice);
  void postCurrentIntent(intent);
}

function togglePause() {
  if (!timeline || !isActive() || timeline.skipRequested) return;

  timeline.paused = !timeline.paused;
  timeline.lastNow = null;

  setMessage(timeline.paused
    ? 'Presentation paused. The server continues processing the round.'
    : 'Presentation resumed. The server result remains authoritative.');

  updateUI();

  if (!timeline.paused) {
    scheduleFrame();
  }
}

function skipPresentation() {
  if (!timeline || !isActive() || timeline.skipRequested) return;

  timeline.skipRequested = true;
  cancelFrame();

  placePulse(ringPoint(timeline.angle));

  if (timeline.resultRound) {
    revealRound(timeline.resultRound);
  } else {
    setMessage(
      'Animation skipped. Waiting for the server to finish the round; the result will not be guessed.',
    );

    updateUI();
  }
}

function replayRound() {
  if (
    state.phase !== 'revealed'
    || state.currentRound?.status !== 'completed'
  ) {
    return;
  }

  const round = state.currentRound;

  state.selectedChoice = round.choice;
  state.phase = 'animating';

  persist();
  updateUI();

  startTimeline(round.choice, round, true);
}

function newRound() {
  if (state.phase !== 'revealed') return;

  cancelFrame();
  timeline = null;

  if (retryTimer) clearTimeout(retryTimer);

  retryTimer = null;
  retryAttempts = 0;

  state.currentIntent = null;
  state.currentRound = null;
  state.phase = 'idle';

  placePulse(pulseCenter());

  setMessage(
    'Choose a beacon and press Play to start a new round. Previous rounds remain saved.',
  );

  persist();
  updateUI();
}

for (const button of beacons) {
  button.addEventListener('click', chooseBeacon);
}

playButton.addEventListener('click', playRound);
pauseButton.addEventListener('click', togglePause);
skipButton.addEventListener('click', skipPresentation);
replayButton.addEventListener('click', replayRound);
newButton.addEventListener('click', newRound);

// A hidden tab pauses the animation clock, not the server round.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelFrame();
    if (timeline) timeline.lastNow = null;
  } else {
    if (timeline) timeline.lastNow = null;
    scheduleFrame();
  }
});

window.addEventListener('resize', () => {
  if (!timeline) return;

  timeline.angle = ringConfiguration(timeline.choice).angle;

  if (
    state.phase === 'revealed'
    && state.currentRound?.status === 'completed'
  ) {
    placePulse(beaconPoint(state.currentRound.target));
  }
});

window.addEventListener('pagehide', () => {
  disposed = true;
  cancelFrame();

  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (retryTimer) clearTimeout(retryTimer);

  if (socket && socket.readyState < WebSocket.CLOSING) {
    socket.close();
  }
});

// A page restored from the back-forward cache needs to reconnect.
window.addEventListener('pageshow', () => {
  if (!disposed) return;

  disposed = false;
  connectSocket();
  void syncEvents();

  if (state.currentIntent) {
    void reconcileCurrentRound();
  }

  scheduleFrame();
});

// Restore saved presentation and reconcile any unfinished round.
if (
  state.phase === 'revealed'
  && state.currentRound?.status === 'completed'
) {
  placePulse(beaconPoint(state.currentRound.target));
  setMessage(resultMessage(state.currentRound));
} else if (state.currentIntent) {
  if (state.phase !== 'pending' && state.phase !== 'animating') {
    state.phase = 'pending';
  }

  startTimeline(state.currentIntent.choice);

  if (state.currentRound?.status === 'completed') {
    timeline.resultRound = state.currentRound;
    timeline.resultAvailableAt = 0;
  }

  setMessage(
    'Restoring your saved round and checking its authoritative status…',
  );
} else {
  state.phase = 'idle';
  setMessage('Choose a beacon and press Play to start.');
  placePulse(pulseCenter());
}

persist();
updateUI();
connectSocket();

if (state.currentIntent) {
  void reconcileCurrentRound();
}
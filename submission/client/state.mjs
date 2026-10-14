// Pure client state machine: no DOM, network or timers, so it is unit-tested
// directly (state.test.mjs). app.mjs feeds it user actions and server facts.
//
//   idle --play--> submitting --accepted--> pending --completed--> revealing --done--> revealed
//                                                                     ^                    |
//                                                                     +------replay--------+
//   revealed --newRound--> idle
//
// The server is authoritative: the client never invents a result, and score
// comes only from round.completed events, counted once per roundId.

export const initialState = playerId => ({
  playerId,
  phase: 'idle',
  choice: 0,
  intent: null,      // { requestId, choice } kept until the round is finished
  round: null,       // latest server snapshot of the current round
  cursor: 0,         // last applied event sequence
  scored: [],        // roundIds already counted (redelivery-safe)
  score: 0,
  paused: false,
  skip: false,       // skip pressed while waiting: reveal instantly on completion
  replaying: false,
  message: 'Choose a beacon and press Play.',
});

const sameRequest = (state, round) => state.intent && round && round.requestId === state.intent.requestId;
const isComplete = round => round?.status === 'completed';

// proto3 omits choice 0 on the wire; restore it at the edge.
export const normalizeRound = round => (round ? { ...round, choice: round.choice ?? 0 } : round);

function arrive(state, round) {
  // A snapshot never moves a round backwards (late "accepted" after "completed").
  if (isComplete(state.round) && !isComplete(round)) return state;
  const next = { ...state, round };
  if (isComplete(round) && (state.phase === 'submitting' || state.phase === 'pending')) {
    return state.skip
      ? { ...next, phase: 'revealed', skip: false, paused: false, message: resultText(round) }
      : { ...next, phase: 'revealing', message: 'Signal locked. Revealing…' };
  }
  if (!isComplete(round) && state.phase === 'submitting') {
    return { ...next, phase: 'pending', message: 'Accepted. Waiting for the server result…' };
  }
  return next;
}

export function resultText(round) {
  const names = ['Azure', 'Amber', 'Violet'];
  return round.score === 1
    ? `Match! You chose ${names[round.choice]}; the signal hit ${names[round.target]}. +1 point.`
    : `Miss. You chose ${names[round.choice]}; the signal hit ${names[round.target]}. No point.`;
}

export function reduce(state, action) {
  switch (action.type) {
    case 'select':
      return state.phase === 'idle' && [0, 1, 2].includes(action.choice) ? { ...state, choice: action.choice } : state;

    case 'play': // guarded: only from idle, so double clicks cannot start twice
      if (state.phase !== 'idle') return state;
      return {
        ...state, phase: 'submitting', paused: false, skip: false, replaying: false, round: null,
        intent: { requestId: action.requestId, choice: state.choice },
        message: 'Sending signal…',
      };

    case 'accepted': // HTTP reply; stale if it belongs to an older intent
      if (!sameRequest(state, action.round)) return state;
      return arrive(state, normalizeRound(action.round));

    case 'snapshot': // GET /rounds/:id during reconcile
      if (!sameRequest(state, action.round)) return state;
      return arrive(state, normalizeRound(action.round));

    case 'event': {
      const { sequence, round: raw } = action.event;
      if (sequence <= state.cursor) return state; // redelivery after reconnect
      const round = normalizeRound(raw);
      let next = { ...state, cursor: sequence };
      if (action.event.type === 'round.completed' && round.playerId === state.playerId
        && !next.scored.includes(round.roundId)) {
        next = { ...next, scored: [...next.scored, round.roundId], score: next.score + round.score };
      }
      return sameRequest(next, round) ? arrive(next, round) : next;
    }

    case 'rejected': // definite application error: the intent did not create a round
      if (state.phase !== 'submitting' || action.requestId !== state.intent?.requestId) return state;
      return {
        ...state, phase: 'idle', intent: null,
        message: action.code === 'ROUND_IN_PROGRESS'
          ? 'You already have a round in progress elsewhere. Try again shortly.'
          : `The server rejected the round (${action.code}).`,
      };

    case 'pause':
      return ['pending', 'revealing'].includes(state.phase) ? { ...state, paused: !state.paused } : state;

    case 'skip':
      if (state.phase === 'revealing') {
        return { ...state, phase: 'revealed', paused: false, replaying: false, message: resultText(state.round) };
      }
      if (state.phase === 'pending' || state.phase === 'submitting') {
        return { ...state, skip: true, message: 'Skipping: the result appears as soon as the server completes it.' };
      }
      return state;

    case 'revealDone':
      return state.phase === 'revealing'
        ? { ...state, phase: 'revealed', paused: false, replaying: false, message: resultText(state.round) }
        : state;

    case 'replay': // presentation only: no request, no score change
      return state.phase === 'revealed'
        ? { ...state, phase: 'revealing', replaying: true, paused: false, message: 'Replaying the recorded result…' }
        : state;

    case 'newRound':
      return state.phase === 'revealed'
        ? { ...state, phase: 'idle', intent: null, round: null, replaying: false, message: 'Choose a beacon and press Play.' }
        : state;

    default:
      return state;
  }
}

// Which controls make sense now; app.mjs disables everything else.
export function controls(state) {
  const animating = state.phase === 'pending' || state.phase === 'revealing';
  return {
    select: state.phase === 'idle',
    play: state.phase === 'idle',
    pause: animating,
    skip: animating || state.phase === 'submitting',
    replay: state.phase === 'revealed',
    newRound: state.phase === 'revealed',
  };
}

// What survives a refresh. Phase is re-derived on load: anything between
// play and reveal resumes as "submitting" and is reconciled with the server.
export function persisted(state) {
  const { playerId, choice, intent, round, cursor, scored, score } = state;
  return { playerId, choice, intent, round, cursor, scored, score };
}

export function restore(saved, playerId) {
  const state = { ...initialState(playerId), ...saved };
  if (state.intent && isComplete(state.round)) return { ...state, phase: 'revealed', message: resultText(state.round) };
  // Keep the last known round snapshot; resubmitting the same requestId reconciles it.
  if (state.intent) return { ...state, phase: 'submitting', message: 'Reconnecting to your round…' };
  return state;
}

// --- Timeline math (pure, frame-rate independent) ---------------------------

export const REVEAL_MS = 2500;
export const REDUCED_REVEAL_MS = 600;
export const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Advance a clock by real elapsed time. dt is clamped so a backgrounded tab
// resumes smoothly instead of jumping, and pause freezes presentation only.
export function tick(clock, dt, paused) {
  return paused ? clock : clock + Math.min(Math.max(dt, 0), 100);
}

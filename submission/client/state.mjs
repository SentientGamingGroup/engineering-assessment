// Pure game state machine: no DOM, no network, no timers. The app shell owns
// I/O and presentation; tests drive this module directly.
//
// Phases: idle -> pending (intent sent) -> animating (result held, reveal
// playing) -> revealed. Server events move state forward; presentation never
// invents or changes an outcome.
const MAX_CURSOR = 4294967295; // uint32 — anything outside gets the WS closed with 1008
export function createGame({ playerId, saved = {} }) {
  const scored = new Set(Array.isArray(saved.scored) ? saved.scored : []);
  // Persisted data is untrusted (hand-edited storage, older versions, private
  // mode quirks): validate every field or fall back to a clean value.
  const savedResult = saved.lastResult;
  const resultValid = savedResult && savedResult.status === 'completed'
    && savedResult.playerId === playerId && Number.isInteger(savedResult.target);
  const cursorValid = Number.isInteger(saved.lastAppliedCursor)
    && saved.lastAppliedCursor >= 0 && saved.lastAppliedCursor <= MAX_CURSOR;
  const state = {
    playerId,
    phase: 'idle',
    choice: Number.isInteger(saved.choice) && saved.choice >= 0 && saved.choice <= 2 ? saved.choice : 0,
    requestId: typeof saved.requestId === 'string' ? saved.requestId : null,
    roundId: typeof saved.roundId === 'string' ? saved.roundId : null,
    round: null,
    lastResult: resultValid ? savedResult : null,
    replaying: false,
    skipRequested: false,
    lastAppliedCursor: cursorValid ? saved.lastAppliedCursor : 0,
    score: Number.isInteger(saved.score) && saved.score >= 0 ? saved.score : scored.size,
  };
  // Resume interrupted work: a persisted intent means the server may own a round
  // we have not yet seen complete; the shell reconciles it via HTTP/WS.
  if (saved.phase === 'revealed' && state.lastResult) state.phase = 'revealed';
  else if (state.requestId && ['pending', 'animating'].includes(saved.phase)) state.phase = 'pending';
  else { state.requestId = null; state.roundId = null; }

  const listeners = new Set();
  const emit = () => { for (const listener of listeners) listener(); };
  const mine = round => round.playerId === state.playerId;
  // Score = points from unique completed rounds for this player (the server's
  // round.score, 1 only on a match); the Set makes redelivery, replay and
  // reconcile-after-refresh all idempotent.
  const credit = round => {
    if (round.status !== 'completed' || !mine(round) || scored.has(round.roundId)) return false;
    scored.add(round.roundId);
    if (round.score === 1) state.score += 1;
    return true;
  };
  const reveal = round => {
    state.round = round;
    state.lastResult = round;
    state.roundId = round.roundId;
    state.replaying = false;
    state.phase = 'animating';
  };

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: () => ({ ...state }),
    persistable: () => ({
      phase: state.phase, choice: state.choice, requestId: state.requestId,
      roundId: state.roundId, lastAppliedCursor: state.lastAppliedCursor,
      score: state.score, scored: [...scored], lastResult: state.lastResult,
    }),
    select(choice) {
      if (state.phase !== 'idle' || !Number.isInteger(choice) || choice < 0 || choice > 2) return false;
      state.choice = choice;
      emit();
      return true;
    },
    // Returns the requestId when a round starts, null otherwise — the second of
    // two rapid clicks gets null, so one intent can never become two requests.
    play(requestId) {
      if (state.phase !== 'idle') return null;
      state.requestId = requestId;
      state.roundId = null;
      state.round = null;
      state.skipRequested = false;
      state.phase = 'pending';
      emit();
      return requestId;
    },
    // Server round snapshot for the CURRENT intent (POST reply, GET reconcile,
    // duplicate re-submit). Stale replies carry an older requestId and are
    // dropped, so they can never replace a newer round.
    reconcile(round) {
      if (!round || !mine(round) || round.requestId !== state.requestId) return false;
      if (round.status === 'completed') {
        credit(round);
        if (state.phase !== 'pending') return false;
        reveal(round);
      } else if (state.phase === 'pending') {
        state.roundId = round.roundId;
        state.round = round;
      } else return false;
      emit();
      return true;
    },
    applyEvent(event) {
      if (!event?.round || !Number.isInteger(event.sequence)
        || event.sequence <= state.lastAppliedCursor) return false;
      state.lastAppliedCursor = event.sequence;
      const round = event.round;
      if (mine(round)) {
        if (event.type === 'round.accepted' && state.phase === 'pending'
          && round.requestId === state.requestId && !state.roundId) {
          state.roundId = round.roundId;
          state.round = round;
        }
        if (event.type === 'round.completed') {
          credit(round);
          if (round.roundId === state.roundId && state.phase === 'pending') reveal(round);
        }
      }
      emit();
      return true;
    },
    requestSkip() {
      if (!['pending', 'animating'].includes(state.phase)) return false;
      state.skipRequested = true;
      emit();
      return true;
    },
    revealed() {
      if (state.phase !== 'animating') return false;
      state.phase = 'revealed';
      state.replaying = false;
      state.skipRequested = false;
      emit();
      return true;
    },
    // Replay re-presents the recorded result only: no request, no score change.
    replay() {
      if (state.phase !== 'revealed' || !state.lastResult) return false;
      state.round = state.lastResult;
      state.replaying = true;
      state.phase = 'animating';
      emit();
      return true;
    },
    newRound() {
      if (!['revealed', 'idle'].includes(state.phase)) return false;
      state.phase = 'idle';
      state.requestId = null;
      state.roundId = null;
      state.round = null;
      state.replaying = false;
      state.skipRequested = false;
      // score/scored/lastResult/cursor survive: a visual reset never erases server history
      emit();
      return true;
    },
    // Unrecoverable rejection of the current intent (e.g. ROUND_IN_PROGRESS from
    // another session). The feed still credits that round when it completes.
    abandon() {
      if (state.phase !== 'pending') return false;
      state.phase = 'idle';
      state.requestId = null;
      state.roundId = null;
      state.round = null;
      emit();
      return true;
    },
  };
}

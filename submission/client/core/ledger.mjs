// Ledger: what this browser has applied from the server feed.
// Score is derived from unique completed rounds for the player, keyed by roundId,
// so redelivery, replay and reconnect backfill cannot count a round twice.
export function createLedger() {
  return { cursor: 0, completed: {} };
}

export function applyEvent(ledger, event, playerId) {
  if (!event || !Number.isInteger(event.sequence) || event.sequence <= ledger.cursor) {
    return { ledger, applied: false };
  }
  let completed = ledger.completed;
  const round = event.round;
  if (event.type === 'round.completed' && round?.playerId === playerId && !(round.roundId in completed)) {
    completed = { ...completed, [round.roundId]: round.score === 1 ? 1 : 0 };
  }
  return { ledger: { cursor: event.sequence, completed }, applied: true };
}

// A round fetched over HTTP (reconciliation) counts exactly like a feed event.
export function recordCompleted(ledger, round, playerId) {
  if (round?.status !== 'completed' || round.playerId !== playerId || round.roundId in ledger.completed) return ledger;
  return { ...ledger, completed: { ...ledger.completed, [round.roundId]: round.score === 1 ? 1 : 0 } };
}

export function scoreOf(ledger, hideRoundId = null) {
  return statsOf(ledger, hideRoundId).score;
}

// HUD numbers. Completion order is insertion order (roundIds are never integer-like).
export function statsOf(ledger, hideRoundId = null) {
  const scores = Object.entries(ledger.completed).filter(([id]) => id !== hideRoundId).map(([, s]) => s);
  let streak = 0;
  for (let i = scores.length - 1; i >= 0 && scores[i] === 1; i--) streak++;
  return { score: scores.reduce((a, b) => a + b, 0), rounds: scores.length, streak };
}

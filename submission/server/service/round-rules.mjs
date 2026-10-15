// Pure domain rules for a round. No I/O, no clocks: callers pass timestamps in.
import { createHash } from 'node:crypto';
import { CHOICES, ROUND_STATUS } from '../common/constants.mjs';

// Public toy rule from the brief: SHA-256(roundId UTF-8)[0] modulo 3.
export const targetFor = roundId => createHash('sha256').update(roundId, 'utf8').digest()[0] % CHOICES;

// Immutable public snapshot with exactly the contract fields.
// Pending rounds never carry target/score/completedAt.
export function toSnapshot(round) {
  const base = {
    roundId: round.roundId, requestId: round.requestId, playerId: round.playerId,
    choice: round.choice, status: round.status, createdAt: round.createdAt,
  };
  if (round.status !== ROUND_STATUS.COMPLETED) return Object.freeze(base);
  return Object.freeze({ ...base, target: round.target, score: round.score, completedAt: round.completedAt });
}

export function acceptRound({ roundId, intent, createdAt }) {
  return toSnapshot({ roundId, ...intent, status: ROUND_STATUS.ACCEPTED, createdAt });
}

export function completeRound(round, completedAt) {
  const target = targetFor(round.roundId);
  return toSnapshot({
    ...round, status: ROUND_STATUS.COMPLETED, target, score: round.choice === target ? 1 : 0, completedAt,
  });
}

// Same requestId must carry the same payload to count as a replay.
export const isSameIntent = (round, intent) => round.playerId === intent.playerId && round.choice === intent.choice;

export const isPending = round => round.status === ROUND_STATUS.ACCEPTED;

export const dueAt = (round, delayMs) => Date.parse(round.createdAt) + delayMs;

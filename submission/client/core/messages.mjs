// User-facing text, derived purely from state so it is consistent everywhere
// (live reveal, replay and page restore all use the same wording).
import { easeOutBack } from './easing.mjs';

export const BEACON_NAMES = Object.freeze(['Azure', 'Amber', 'Violet']);

export function describeResult(round, { replay = false } = {}) {
  const match = round.score === 1;
  const text = `${replay ? 'Replay — ' : ''}You chose ${BEACON_NAMES[round.choice]}. `
    + `The signal landed on ${BEACON_NAMES[round.target]}. ${match ? 'Match! +1 point.' : 'Miss — 0 points.'}`
    + `${replay ? ' (Score unchanged.)' : ''}`;
  return { text, tone: match ? 'hit' : 'miss' };
}

// Headline in the centre of the orbit. `pop` scales the result word in.
export function coreText({ phase, paused, sample, round, choice }) {
  const revealing = phase === 'revealed' || sample?.phase === 'reveal' || sample?.phase === 'done';
  if (revealing && round?.status === 'completed') {
    const match = round.score === 1;
    const pop = sample?.phase === 'reveal' ? 0.6 + 0.4 * easeOutBack(Math.min(1, sample.p * 1.6)) : 1;
    return { title: match ? 'MATCH!' : 'MISS', sub: match ? '+1 point' : `landed on ${BEACON_NAMES[round.target]}`, pop };
  }
  if (paused) return { title: 'PAUSED', sub: 'server keeps going', pop: 1 };
  if (sample?.phase === 'charge' || phase === 'starting') return { title: 'CHARGING', sub: `from ${BEACON_NAMES[choice]}`, pop: 1 };
  if (sample?.phase === 'land') return { title: 'LOCKING ON…', sub: '', pop: 1 };
  if (sample?.phase === 'travel') {
    return { title: sample.waiting ? 'RELAYING…' : 'RELAYING', sub: sample.waiting ? 'waiting for the server' : '', pop: 1 };
  }
  return { title: 'PICK A BEACON', sub: 'then press Play', pop: 1 };
}

// Small status line on the stage (network/retry situations only).
export function stageNote({ note, sample, skipping, online }) {
  if (note) return note;
  if (sample?.phase !== 'travel') return '';
  if (skipping) return 'Skipping — waiting for the server result…';
  if (!sample.waiting) return '';
  return online ? 'Waiting for the server…' : 'Connection lost — your round continues on the server';
}

// Browser-independent state; server facts and presentation have separate lifecycles.
const validId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const validRoundId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validChoice = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 2;
export const TRAVEL_MS = 2400;
export class GameState {
  constructor(saved, newPlayerId) {
    this.playerId = validId(saved?.playerId) ? saved.playerId : newPlayerId;
    this.choice = validChoice(saved?.choice) ? saved.choice : 0;
    this.cursor =
      Number.isInteger(saved?.cursor) &&
      saved.cursor >= 0 &&
      saved.cursor <= 4294967295
        ? saved.cursor
        : 0;
    this.ledger = new Map(
      (Array.isArray(saved?.ledger) ? saved.ledger : []).filter(
        (pair) =>
          Array.isArray(pair) &&
          validRoundId(pair[0]) &&
          [0, 1].includes(pair[1]),
      ),
    );
    // A cursor without its score ledger cannot safely skip historical completions.
    if (!Array.isArray(saved?.ledger)) this.cursor = 0;
    this.intent =
      saved?.intent?.playerId === this.playerId &&
      validId(saved.intent.requestId) &&
      validChoice(saved.intent.choice)
        ? { ...saved.intent }
        : null;
    this.round =
      saved?.round?.playerId === this.playerId &&
      validRoundId(saved.round.roundId) &&
      this.intent?.requestId === saved.round.requestId
        ? { ...saved.round }
        : null;
    if (this.intent) this.choice = this.intent.choice;
    this.phase =
      this.round?.status === 'completed'
        ? 'revealed'
        : this.intent
          ? 'waiting'
          : 'select';
    this.elapsed = 0;
    this.paused = false;
    this.skipped = false;
    this.isReplay = false;
  }
  get score() {
    return [...this.ledger.values()].reduce((sum, value) => sum + value, 0);
  }
  get progress() {
    return Math.min(1, this.elapsed / this.duration);
  }
  get duration() {
    return this.reducedMotion ? 180 : TRAVEL_MS;
  }
  select(choice) {
    if (this.phase !== 'select' || !validChoice(choice)) return false;
    this.choice = choice;
    return true;
  }
  begin(requestId) {
    if (this.phase !== 'select') return false;
    this.intent = { requestId, playerId: this.playerId, choice: this.choice };
    this.round = null;
    this.phase = 'submitting';
    this.elapsed = 0;
    this.paused = false;
    this.skipped = false;
    this.isReplay = false;
    return true;
  }
  applyRound(round) {
    if (round.playerId !== this.playerId) return false;
    if (round.status === 'completed')
      this.ledger.set(round.roundId, round.score);
    if (!this.intent || this.intent.requestId !== round.requestId) return false;
    if (this.round && this.round.roundId !== round.roundId) return false;
    // A late accepted reply or repeated completion cannot restart presentation.
    if (this.round?.status === 'completed') return false;
    this.round = { ...round };
    this.choice = round.choice;
    if (round.status === 'completed') {
      this.elapsed = 0;
      this.phase = this.skipped ? 'revealed' : 'travel';
    } else this.phase = 'waiting';
    return true;
  }
  applyEvent(event) {
    if (!Number.isInteger(event.sequence) || event.sequence <= this.cursor)
      return false;
    if (event.sequence !== this.cursor + 1) throw new Error('EVENT_GAP');
    this.applyRound(event.round);
    this.cursor = event.sequence;
    return true;
  }
  pause() {
    if (!['submitting', 'waiting', 'travel'].includes(this.phase)) return;
    this.paused = !this.paused;
  }
  skip() {
    if (!['submitting', 'waiting', 'travel'].includes(this.phase)) return;
    this.skipped = true;
    this.paused = false;
    if (this.round?.status === 'completed') this.phase = 'revealed';
  }
  replay() {
    if (this.phase !== 'revealed' || this.round?.status !== 'completed')
      return false;
    this.phase = 'travel';
    this.elapsed = 0;
    this.paused = false;
    this.skipped = false;
    this.isReplay = true;
    return true;
  }
  newRound() {
    if (this.phase !== 'revealed') return false;
    this.phase = 'select';
    this.intent = null;
    this.round = null;
    this.elapsed = 0;
    this.paused = false;
    this.skipped = false;
    this.isReplay = false;
    return true;
  }
  tick(delta) {
    if (this.phase !== 'travel' || this.paused) return;
    this.elapsed += Math.max(0, delta);
    if (this.progress >= 1) this.phase = 'revealed';
  }
  snapshot() {
    return {
      playerId: this.playerId,
      choice: this.choice,
      cursor: this.cursor,
      intent: this.intent,
      round: this.round,
      ledger: [...this.ledger],
    };
  }
}

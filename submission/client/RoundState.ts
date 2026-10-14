// The client's round state. No DOM or network, so it is unit-testable in Node.
import { ID, isChoice } from './types.ts';
import type { Choice, Round, RoundEvent } from './types.ts';

/** idle -> submitting -> pending -> completed -> (newRound) idle */
export type Phase = 'idle' | 'submitting' | 'pending' | 'completed';

/** The player's current round: their intent (requestId + choice) plus what the server reported. */
export interface CurrentRound {
  requestId: string;
  choice: Choice;
  status: 'submitting' | 'accepted' | 'completed';
  roundId?: string;
  createdAt?: string;
  target?: Choice;
  score?: 0 | 1;
  completedAt?: string;
}

/** What survives a refresh (see toJSON/restore). */
export interface Snapshot {
  playerId: string;
  choice: Choice;
  cursor: number;
  results: Record<string, number>;
  round: CurrentRound | null;
  /** Idempotency key of the current intent (see play()); equals round.requestId once played. */
  intentKey: string;
}

/**
 * The server is authoritative; this only remembers the player's intent, the round it
 * maps to, the last applied event cursor and per-round scores keyed by roundId (so
 * redelivery can't double count). Mutating methods return true when something changed.
 */
export class RoundState {
  private readonly _playerId: string;
  private _choice: Choice;
  private _cursor: number;
  private _results: Record<string, number>;
  private _round: CurrentRound | null;
  private _intentKey: string;
  private _notice = '';
  private readonly makeId: (prefix: string) => string;

  private constructor(snapshot: Snapshot, makeId: (prefix: string) => string) {
    this._playerId = snapshot.playerId;
    this._choice = snapshot.choice;
    this._cursor = snapshot.cursor;
    this._results = snapshot.results;
    this._round = snapshot.round;
    this._intentKey = snapshot.intentKey;
    this.makeId = makeId;
  }

  /** Rebuild from saved data, distrusting anything malformed. */
  static restore(saved: unknown, makeId: (prefix: string) => string): RoundState {
    const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Snapshot>;
    const results = s.results && typeof s.results === 'object' && !Array.isArray(s.results) ? s.results : null;
    const round = s.round && typeof s.round === 'object' && ID.test(s.round.requestId ?? '') && isChoice(s.round.choice)
      ? s.round : null;
    return new RoundState({
      playerId: ID.test(s.playerId ?? '') ? s.playerId! : makeId('p'),
      choice: isChoice(s.choice) ? s.choice : 0,
      // Without trustworthy results, rebuild the score from the full event history.
      cursor: results && Number.isInteger(s.cursor) && s.cursor! >= 0 ? s.cursor! : 0,
      results: { ...results },
      round,
      // A played intent's key is its round's; otherwise keep the saved unsent key.
      intentKey: round ? round.requestId : ID.test(s.intentKey ?? '') ? s.intentKey! : makeId('req'),
    }, makeId);
  }

  toJSON(): Snapshot {
    return {
      playerId: this._playerId, choice: this._choice, cursor: this._cursor, results: this._results,
      round: this._round, intentKey: this._intentKey,
    };
  }

  get playerId(): string { return this._playerId; }
  get choice(): Choice { return this._choice; }
  /** Sequence of the last applied event. */
  get cursor(): number { return this._cursor; }
  get round(): CurrentRound | null { return this._round; }
  /** Why the last attempt didn't start a round (an error code), or ''. */
  get notice(): string { return this._notice; }

  get phase(): Phase {
    if (!this._round) return 'idle';
    if (!this._round.roundId) return 'submitting';
    return this._round.status === 'completed' ? 'completed' : 'pending';
  }

  /** Points from unique completed rounds of this player. */
  get score(): number {
    return Object.values(this._results).reduce((sum, value) => sum + value, 0);
  }

  select(choice: Choice): boolean {
    if (this.phase !== 'idle' || !isChoice(choice) || choice === this._choice) return false;
    this._choice = choice;
    return true;
  }

  /**
   * Start a round for the current intent. The key was created before the click and is
   * *not* rotated here: every Play, retry, refresh or tab acting on this intent sends
   * the same key, so the server dedupes them into one round. It only rotates when the
   * intent ends: newRound(), rejected() or serverReset().
   */
  play(): boolean {
    if (this.phase !== 'idle') return false;
    this._notice = '';
    this._round = { requestId: this._intentKey, choice: this._choice, status: 'submitting' };
    return true;
  }

  /** The server refused to start the round (4xx): the intent is over. */
  rejected(requestId: string, code: string): boolean {
    if (this.phase !== 'submitting' || this._round!.requestId !== requestId) return false;
    this._round = null;
    this._notice = code;
    this.nextIntent();
    return true;
  }

  /** Apply a feed event; only the next sequence is accepted (duplicates/stale/gaps are ignored). */
  applyEvent(event: RoundEvent): boolean {
    if (event.sequence !== this._cursor + 1) return false;
    this.applyRound(event.round);
    this._cursor = event.sequence;
    return true;
  }

  /** Apply a server snapshot (POST/GET reply or event) to the current round, if it is ours. */
  applyRound(data: Round): boolean {
    const recorded = this.recordResult(data);
    const current = this._round;
    if (!current || data.requestId !== current.requestId || data.playerId !== this._playerId) return recorded; // stale/other
    if (current.roundId && current.roundId !== data.roundId) return recorded;
    if (current.status === 'completed' || current.status === data.status) return recorded; // completed is immutable
    this._round = {
      requestId: current.requestId, choice: current.choice, roundId: data.roundId,
      status: data.status, createdAt: data.createdAt,
      ...(data.status === 'completed' && { target: data.target, score: data.score, completedAt: data.completedAt }),
    };
    return true;
  }

  newRound(): boolean {
    if (this.phase !== 'completed') return false;
    this._round = null;
    this._notice = '';
    this.nextIntent();
    return true;
  }

  /** The server's history is shorter than our cursor: re-read it from 0, keeping the round. */
  resync(): boolean {
    if (!this._cursor) return false;
    this._cursor = 0;
    this._results = {};
    return true;
  }

  /** The server lost our round, so our cursor and results are stale too. */
  serverReset(): void {
    this._cursor = 0;
    this._results = {};
    this._round = null;
    this._notice = 'SERVER_RESET';
    this.nextIntent();
  }

  /** The current intent has ended; the next one gets a fresh key. */
  private nextIntent(): void {
    this._intentKey = this.makeId('req');
  }

  private recordResult(round: Round): boolean {
    if (round.status !== 'completed' || round.playerId !== this._playerId) return false;
    if (this._results[round.roundId] === round.score) return false;
    this._results = { ...this._results, [round.roundId]: round.score! };
    return true;
  }
}

// Wire shapes from docs/API.md, shared by every client module.

export type Choice = 0 | 1 | 2;
export const BEACONS = ['01 Azure', '02 Amber', '03 Violet'] as const;
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isChoice = (value: unknown): value is Choice => value === 0 || value === 1 || value === 2;

/** A server round snapshot. target/score/completedAt only exist once completed. */
export interface Round {
  roundId: string;
  requestId: string;
  playerId: string;
  choice: Choice;
  status: 'accepted' | 'completed';
  createdAt: string;
  target?: Choice;
  score?: 0 | 1;
  completedAt?: string;
}

export interface RoundEvent {
  sequence: number;
  type: 'round.accepted' | 'round.completed';
  round: Round;
}

// HTTP calls to the gateway. Network errors, timeouts and 5xx are an *unknown*
// outcome, never a rejection: the caller retries the same requestId.
import type { Choice, Round } from './types.ts';

const TIMEOUT_MS = 5000;

export type StartResult =
  | { kind: 'accepted'; round: Round }
  | { kind: 'rejected'; code: string }
  | { kind: 'unknown' };

export type GetResult =
  | { kind: 'found'; round: Round }
  | { kind: 'missing' }
  | { kind: 'unknown' };

export class RoundApi {
  async startRound(requestId: string, playerId: string, choice: Choice): Promise<StartResult> {
    try {
      const response = await fetch('/rounds', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, playerId, choice }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 202) return { kind: 'accepted', round: body };
      if (response.status < 500) return { kind: 'rejected', code: body?.error?.code ?? `HTTP_${response.status}` };
    } catch { /* network error or timeout */ }
    return { kind: 'unknown' };
  }

  async getRound(roundId: string): Promise<GetResult> {
    try {
      const response = await fetch(`/rounds/${encodeURIComponent(roundId)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.ok) return { kind: 'found', round: await response.json() };
      if (response.status === 404) return { kind: 'missing' };
    } catch { /* network error or timeout */ }
    return { kind: 'unknown' };
  }

  /** Whether the server's history contains this sequence; undefined when unknown. */
  async hasEvent(sequence: number): Promise<boolean | undefined> {
    try {
      const response = await fetch(`/events?after=${sequence - 1}&limit=1`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) return undefined;
      const body = await response.json();
      return body.events?.length > 0;
    } catch {
      return undefined;
    }
  }
}

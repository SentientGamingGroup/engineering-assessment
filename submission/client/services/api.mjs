// HTTP calls to the gateway. Network failures/timeouts throw; HTTP errors resolve
// with their status so callers can tell "rejected" (4xx) from "unknown" (5xx/throw).
const POST_TIMEOUT_MS = 5000;
const GET_TIMEOUT_MS = 3000;

export async function startRound({ requestId, playerId, choice }) {
  const response = await fetch('/rounds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, playerId, choice }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.json() };
}

export async function getRound(roundId) {
  const response = await fetch(`/rounds/${encodeURIComponent(roundId)}`, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
  return response.ok ? response.json() : null;
}

// Bounded exponential backoff with jitter, shared by request and socket retries.
export const backoff = (attempt, baseMs, capMs) => Math.min(capMs, baseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);

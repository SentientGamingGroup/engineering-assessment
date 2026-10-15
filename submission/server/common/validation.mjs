// Pure input validators. HTTP and gRPC apply the same rules; they differ only where
// the contract says so (HTTP needs an explicit choice and string query numbers).
import { CHOICES, ID_PATTERN, MAX_CURSOR, MAX_PAGE_SIZE, ROUND_ID_PATTERN } from './constants.mjs';

export const isId = value => typeof value === 'string' && ID_PATTERN.test(value);
export const isRoundId = value => typeof value === 'string' && ROUND_ID_PATTERN.test(value);
export const isChoice = value => Number.isInteger(value) && value >= 0 && value < CHOICES;
export const isCursor = value => Number.isInteger(value) && value >= 0 && value <= MAX_CURSOR;
export const isPageSize = value => Number.isInteger(value) && value >= 1 && value <= MAX_PAGE_SIZE;

// HTTP POST /rounds body: exactly { requestId, playerId, choice }.
export function isStartRoundBody(body) {
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).sort().join(',') === 'choice,playerId,requestId'
    && isId(body.requestId) && isId(body.playerId) && isChoice(body.choice);
}

// gRPC StartRound: an omitted uint32 choice arrives as undefined and means 0.
export function normalizeStartRound(request) {
  const intent = { requestId: request?.requestId, playerId: request?.playerId, choice: request?.choice ?? 0 };
  return isId(intent.requestId) && isId(intent.playerId) && isChoice(intent.choice) ? intent : null;
}

// gRPC ListEvents: limit 0 means "omitted" (default page size).
export function normalizeListEvents(request) {
  const page = { after: request?.after ?? 0, limit: request?.limit || MAX_PAGE_SIZE };
  return isCursor(page.after) && isPageSize(page.limit) ? page : null;
}

// HTTP GET /events?after=&limit= — decimal strings only; limit=0 is invalid here.
export function parseEventsQuery(searchParams) {
  const after = searchParams.get('after') ?? '0';
  const limit = searchParams.get('limit') ?? String(MAX_PAGE_SIZE);
  if (!/^\d+$/.test(after) || !/^\d+$/.test(limit)) return null;
  const page = { after: Number(after), limit: Number(limit) };
  return isCursor(page.after) && isPageSize(page.limit) ? page : null;
}

// WebSocket ?after= cursor.
export function parseCursor(value = '0') {
  return /^\d+$/.test(value) && isCursor(Number(value)) ? Number(value) : null;
}

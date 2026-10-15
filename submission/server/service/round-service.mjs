// Authoritative RoundService: the single owner of round state.
//
// Durability: every state change is appended to the event log (fsynced) before any
// caller sees it. Memory holds only a projection rebuilt from the log at startup.
//
// Concurrency: each mutation (validate → dedupe → guard → append → index) runs
// synchronously in one event-loop turn, so concurrent gRPC calls cannot interleave
// between the duplicate check and the write. No locks are needed.
import { randomUUID } from 'node:crypto';
import { grpc } from '../../../lib/grpc.mjs';
import { EVENT_TYPE } from '../common/constants.mjs';
import { isRoundId, normalizeListEvents, normalizeStartRound } from '../common/validation.mjs';
import { acquireDataLock } from './data-lock.mjs';
import { errors, toGrpcError } from './errors.mjs';
import { openEventLog } from './event-log.mjs';
import { acceptRound, completeRound, dueAt, isPending, isSameIntent, toSnapshot } from './round-rules.mjs';

export async function createService({ dataDir, roundDelayMs, now = () => Date.now() }) {
  const lock = acquireDataLock(dataDir); // single durable state owner per DATA_DIR
  let log;
  try { log = openEventLog(dataDir); } catch (error) { lock.release(); throw error; }
  const rounds = new Map();          // roundId → latest snapshot
  const byRequest = new Map();       // requestId → roundId
  const pendingByPlayer = new Map(); // playerId → roundId
  const timers = new Map();          // roundId → completion timer
  let closed = false;

  // Projection: fold one event into the in-memory indexes.
  const index = round => {
    rounds.set(round.roundId, round);
    byRequest.set(round.requestId, round.roundId);
    if (isPending(round)) pendingByPlayer.set(round.playerId, round.roundId);
    else if (pendingByPlayer.get(round.playerId) === round.roundId) pendingByPlayer.delete(round.playerId);
  };
  const record = (type, round) => {
    const event = log.append(type, round);
    index(round);
    return event;
  };

  // ---- completion scheduling (server-owned; never waits for a client)
  const schedule = round => {
    clearTimeout(timers.get(round.roundId));
    const wait = Math.max(0, dueAt(round, roundDelayMs) - now());
    timers.set(round.roundId, setTimeout(complete, wait, round.roundId));
  };
  function complete(roundId) {
    timers.delete(roundId);
    const round = rounds.get(roundId);
    if (closed || !round || !isPending(round)) return; // never complete twice
    const at = now();
    if (at < dueAt(round, roundDelayMs)) return schedule(round); // timer fired early
    record(EVENT_TYPE.COMPLETED, completeRound(round, new Date(at).toISOString()));
  }

  // ---- use cases
  function startRound(request) {
    const intent = normalizeStartRound(request);
    if (!intent) throw errors.invalidRequest();
    // Resolve requestId duplicates before checking player activity.
    const existingId = byRequest.get(intent.requestId);
    if (existingId) {
      const existing = rounds.get(existingId);
      if (!isSameIntent(existing, intent)) throw errors.idempotencyConflict();
      return existing;
    }
    if (pendingByPlayer.has(intent.playerId)) throw errors.roundInProgress();
    const round = acceptRound({ roundId: randomUUID(), intent, createdAt: new Date(now()).toISOString() });
    record(EVENT_TYPE.ACCEPTED, round);
    schedule(round);
    return round;
  }

  function getRound(request) {
    if (!isRoundId(request?.roundId)) throw errors.invalidRequest();
    const round = rounds.get(request.roundId);
    if (!round) throw errors.roundNotFound();
    return round;
  }

  function listEvents(request) {
    const query = normalizeListEvents(request);
    if (!query) throw errors.invalidCursor();
    const events = log.page(query.after, query.limit);
    return { events, nextCursor: events.length ? events.at(-1).sequence : query.after };
  }

  // ---- recovery: rebuild the projection, then resume unfinished rounds.
  // Overdue rounds get a zero-delay timer; completed rounds are left untouched.
  for (const event of log.replayed()) index(toSnapshot(event.round));
  for (const roundId of pendingByPlayer.values()) schedule(rounds.get(roundId));

  // ---- gRPC adapter
  const unary = useCase => (call, callback) => {
    if (closed) return callback({ code: grpc.status.UNAVAILABLE, details: 'SHUTTING_DOWN' });
    try { callback(null, useCase(call.request)); } catch (error) { callback(toGrpcError(error)); }
  };

  return {
    handlers: {
      health: unary(() => ({ ok: true })),
      startRound: unary(startRound),
      getRound: unary(getRound),
      listEvents: unary(listEvents),
    },
    close() {
      if (closed) return;
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      log.close();
      lock.release();
    },
  };
}

// Authoritative RoundService: single owner of all round/event state.
//
// Design (see NOTES.md):
//   * The durable source of truth is an append-only JSONL event log under DATA_DIR.
//     Sequence assignment, the fsync and the in-memory append all happen inside one
//     serialized write queue, so no event becomes visible on the feed (ListEvents /
//     WebSocket) before it is durable, and sequence numbers are gap-free.
//   * In-memory projections (rounds, byRequest, pendingByPlayer, events) are rebuilt
//     from the log on startup. A pending round found at startup is simply rescheduled.
//   * Completion is driven by a timer owned here, never by a client read, the
//     service finishes rounds on its own clock.
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { grpc } from '../lib/grpc.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UINT32_MAX = 4294967295;
const targetFor = id => createHash('sha256').update(id).digest()[0] % 3;
const nowIso = () => new Date().toISOString();

// gRPC application error with the exact status/details the contract requires.
const fail = (code, details) => Object.assign(new Error(details), { code, details });
const INVALID = details => fail(grpc.status.INVALID_ARGUMENT, details);
const NOT_FOUND = () => fail(grpc.status.NOT_FOUND, 'ROUND_NOT_FOUND');
const CONFLICT = () => fail(grpc.status.ALREADY_EXISTS, 'IDEMPOTENCY_CONFLICT');
const IN_PROGRESS = () => fail(grpc.status.FAILED_PRECONDITION, 'ROUND_IN_PROGRESS');

// Public snapshots. Pending rounds must never expose target/score/completedAt.
const acceptedView = r => ({
  roundId: r.roundId, requestId: r.requestId, playerId: r.playerId,
  choice: r.choice, status: 'accepted', createdAt: r.createdAt,
});
const completedView = r => ({
  roundId: r.roundId, requestId: r.requestId, playerId: r.playerId,
  choice: r.choice, status: 'completed', createdAt: r.createdAt,
  target: r.target, score: r.score, completedAt: r.completedAt,
});
const view = r => (r.status === 'completed' ? completedView(r) : acceptedView(r));

export async function createService({ dataDir, roundDelayMs }) {
  const delayMs = Number(roundDelayMs) || 0;
  const logPath = join(dataDir, 'events.log');
  await mkdir(dirname(logPath), { recursive: true });

  const rounds = new Map();          // roundId -> round record
  const byRequest = new Map();       // requestId -> roundId
  const pendingByPlayer = new Map(); // playerId -> roundId (only while accepted)
  const events = [];                 // { sequence, type, round }, durable events only
  const timers = new Map();          // roundId -> Timeout
  let sequence = 0;

  const handle = await open(logPath, 'a');
  let writeTail = Promise.resolve();

  // Durably commit one event. Sequence is assigned, the line is fsync'd, and the
  // event is appended to the in-memory feed, all inside the serialized queue, so
  // the feed never exposes a non-durable event and sequences stay gap-free. A link
  // runs after the previous one settles either way; a failed write surfaces to this
  // caller only and does not poison later commits.
  const commit = (type, round, afterDurable) => {
    const run = async () => {
      const seq = sequence + 1;
      const event = { sequence: seq, type, round };
      await handle.write(JSON.stringify(event) + '\n');
      await handle.sync();
      sequence = seq;
      events.push(event);
      if (afterDurable) afterDurable();   // state change becomes observable with the feed
      return event;
    };
    const result = writeTail.then(run, run);
    writeTail = result.catch(() => {});
    return result;
  };

  const scheduleCompletion = round => {
    if (timers.has(round.roundId)) return;
    const wait = Math.max(0, Date.parse(round.createdAt) + delayMs - Date.now());
    const timer = setTimeout(() => complete(round.roundId).catch(() => {}), wait);
    if (timer.unref) timer.unref();
    timers.set(round.roundId, timer);
  };

  const complete = async roundId => {
    timers.delete(roundId);
    const round = rounds.get(roundId);
    if (!round || round.status !== 'accepted') return; // already done / gone
    const target = targetFor(roundId);
    // Stamp completion no earlier than createdAt + delay, so the eligibility
    // invariant holds despite timer jitter and ISO millisecond flooring.
    const dueAt = Date.parse(round.createdAt) + delayMs;
    const completed = {
      ...acceptedView(round), status: 'completed',
      target, score: round.choice === target ? 1 : 0,
      completedAt: new Date(Math.max(Date.now(), dueAt)).toISOString(),
    };
    // Make the round observable as completed only once its event is durable and
    // on the feed, so getRound and ListEvents never disagree.
    await commit('round.completed', completedView(completed), () => {
      rounds.set(roundId, completed);
      if (pendingByPlayer.get(completed.playerId) === roundId) pendingByPlayer.delete(completed.playerId);
    });
  };

  // --- recovery: replay the durable log, then reschedule anything still pending ---
  let existing = '';
  try { existing = await readFile(logPath, 'utf8'); } catch { /* fresh start */ }
  for (const line of existing.split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; } // drop a torn trailing line
    const { sequence: seq, type, round } = record;
    sequence = Math.max(sequence, seq);
    if (type === 'round.accepted') {
      rounds.set(round.roundId, { ...round });
      byRequest.set(round.requestId, round.roundId);
      pendingByPlayer.set(round.playerId, round.roundId);
    } else if (type === 'round.completed') {
      rounds.set(round.roundId, { ...round });
      if (pendingByPlayer.get(round.playerId) === round.roundId) pendingByPlayer.delete(round.playerId);
    }
    events.push(record);
  }
  for (const round of rounds.values()) {
    if (round.status === 'accepted') scheduleCompletion(round);
  }

  // --- domain operation: start (or replay) a round ---
  // Critical section is synchronous: all map mutations happen before any await,
  // so concurrent duplicates are serialized by the event loop with no interleaving.
  const startRound = (requestId, playerId, choice) => {
    if (typeof requestId !== 'string' || !ID_RE.test(requestId)
      || typeof playerId !== 'string' || !ID_RE.test(playerId)
      || !Number.isInteger(choice) || choice < 0 || choice > 2) {
      throw INVALID('INVALID_REQUEST');
    }
    // Idempotency is resolved before the player-activity guard.
    const seenId = byRequest.get(requestId);
    if (seenId) {
      const seen = rounds.get(seenId);
      if (seen.playerId !== playerId || seen.choice !== choice) throw CONFLICT();
      return Promise.resolve(view(seen)); // replay (pending or completed)
    }
    if (pendingByPlayer.has(playerId)) throw IN_PROGRESS();

    const roundId = randomUUID();
    const round = { roundId, requestId, playerId, choice, status: 'accepted', createdAt: nowIso() };
    rounds.set(roundId, round);
    byRequest.set(requestId, roundId);
    pendingByPlayer.set(playerId, roundId);
    scheduleCompletion(round);
    // Acknowledge only once the accepted event is durable and on the feed.
    return commit('round.accepted', acceptedView(round)).then(() => view(rounds.get(roundId)));
  };

  const listEvents = (after, limit) => {
    if (!Number.isInteger(after) || after < 0 || after > UINT32_MAX) throw INVALID('INVALID_CURSOR');
    if (!Number.isInteger(limit) || limit < 0 || limit > 100) throw INVALID('INVALID_CURSOR');
    const size = limit === 0 ? 100 : limit; // gRPC limit=0 means default 100
    // Sequences are contiguous from 1, so events[i].sequence === i + 1: an event
    // with sequence > after sits at index >= after. Slice directly, O(size).
    const start = Math.min(after, events.length);
    const slice = events.slice(start, start + size);
    const nextCursor = slice.length ? slice[slice.length - 1].sequence : after;
    return { events: slice, nextCursor };
  };

  // --- gRPC handler adapters ---
  const handlers = {
    health: (_call, cb) => cb(null, { ok: true }),
    startRound: (call, cb) => {
      try {
        const { requestId, playerId, choice } = call.request;
        Promise.resolve(startRound(requestId, playerId, choice ?? 0)).then(r => cb(null, r), cb);
      } catch (e) { cb(e); }
    },
    getRound: (call, cb) => {
      const round = rounds.get(call.request.roundId);
      if (!round) return cb(NOT_FOUND());
      cb(null, view(round));
    },
    listEvents: (call, cb) => {
      try { cb(null, listEvents(call.request.after ?? 0, call.request.limit ?? 0)); }
      catch (e) { cb(e); }
    },
  };

  return {
    handlers,
    async close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      try { await writeTail; } catch { /* best effort */ }
      await handle.close();
    },
  };
}

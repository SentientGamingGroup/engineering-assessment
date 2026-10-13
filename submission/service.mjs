// Authoritative round service. Single durable state owner: an append-only JSONL
// event log under DATA_DIR; all in-memory indexes are rebuilt from it on startup.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { grpc } from '../lib/grpc.mjs';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CURSOR = 4294967295;
const DEFAULT_LIMIT = 100;
// ISO timestamps truncate to milliseconds; without a margin a timer can fire with
// completedAt - createdAt one millisecond short of the configured delay.
const COMPLETION_MARGIN_MS = 25;
const RETRY_DELAY_MS = 1000;

const fail = (code, details) => Object.assign(new Error(details), { code, details });
const targetFor = roundId => createHash('sha256').update(roundId, 'utf8').digest()[0] % 3;
// Identity of a StartRound payload for idempotency comparison (requestId aside).
const fingerprintOf = round => `${round.playerId}|${round.choice}`;

export async function createService({ dataDir, roundDelayMs }) {
  const logPath = join(dataDir, 'events.jsonl');
  const events = [];                 // full ordered history, snapshots at event time
  const rounds = new Map();          // roundId -> latest round state
  const requests = new Map();        // requestId -> { fingerprint, roundId, ready }
  const playerPending = new Map();   // playerId -> pending roundId
  const timers = new Map();          // roundId -> completion timer
  let lastSequence = 0;

  await mkdir(dataDir, { recursive: true });
  let raw = '';
  try { raw = await readFile(logPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // SIGKILL mid-append can tear only the final line; it was never acknowledged,
  // so it is cut off before reopening for append. Otherwise the next event would
  // be glued onto the fragment and turn it into mid-file corruption.
  if (raw !== '' && !raw.endsWith('\n')) {
    const keep = raw.slice(0, raw.lastIndexOf('\n') + 1);
    await truncate(logPath, Buffer.byteLength(keep, 'utf8'));
    raw = keep;
  }
  const lines = raw.split('\n').filter(line => line !== '');
  lines.forEach((line, index) => {
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error(`Corrupt event log at line ${index + 1}`); }
    lastSequence = event.sequence;
    events.push(event);
    const round = event.round;
    rounds.set(round.roundId, round);
    if (event.type === 'round.accepted') {
      requests.set(round.requestId, {
        fingerprint: fingerprintOf(round), roundId: round.roundId, ready: Promise.resolve(round),
      });
      playerPending.set(round.playerId, round.roundId);
    } else if (playerPending.get(round.playerId) === round.roundId) {
      playerPending.delete(round.playerId);
    }
  });

  const handle = await open(logPath, 'a');
  // Single writer chain: appends stay in sequence order and memory only reflects
  // durable events. A failed write must not stall later appends.
  let tail = Promise.resolve();
  const appendEvent = (type, round) => {
    const write = tail.then(async () => {
      const event = { sequence: lastSequence + 1, type, round };
      await handle.write(JSON.stringify(event) + '\n');
      lastSequence += 1;
      events.push(event);
      return event;
    });
    tail = write.catch(() => {});
    return write;
  };

  function armCompletion(round, delayMs) {
    const timer = setTimeout(() => {
      timers.delete(round.roundId);
      completeRound(round.roundId).catch(error => {
        console.error(`Completion failed for round ${round.roundId}; retrying`, error);
        armCompletion(round, RETRY_DELAY_MS);
      });
    }, Math.max(delayMs, 0));
    timers.set(round.roundId, timer);
  }
  const scheduleCompletion = round => armCompletion(round,
    Date.parse(round.createdAt) + roundDelayMs + COMPLETION_MARGIN_MS - Date.now());

  async function completeRound(roundId) {
    const current = rounds.get(roundId);
    if (!current || current.status !== 'accepted') return;
    const target = targetFor(roundId);
    const earliest = Date.parse(current.createdAt) + roundDelayMs;
    const completedAt = new Date(Math.max(Date.now(), earliest)).toISOString();
    const completed = {
      ...current, status: 'completed',
      target, score: current.choice === target ? 1 : 0, completedAt,
    };
    await appendEvent('round.completed', completed);
    rounds.set(roundId, completed);
    if (playerPending.get(current.playerId) === roundId) playerPending.delete(current.playerId);
  }

  async function startRound(request) {
    const { requestId, playerId } = request;
    const choice = request.choice ?? 0; // proto3 omits the default 0 on the wire
    if (typeof requestId !== 'string' || !ID_PATTERN.test(requestId)
      || typeof playerId !== 'string' || !ID_PATTERN.test(playerId)
      || !Number.isInteger(choice) || choice < 0 || choice > 2) {
      throw fail(grpc.status.INVALID_ARGUMENT, 'INVALID_REQUEST');
    }
    const fingerprint = fingerprintOf({ playerId, choice });
    const existing = requests.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw fail(grpc.status.ALREADY_EXISTS, 'IDEMPOTENCY_CONFLICT');
      }
      await existing.ready;
      const round = rounds.get(existing.roundId);
      if (!round) throw fail(grpc.status.INTERNAL, 'INTERNAL_ERROR');
      return round;
    }
    if (playerPending.has(playerId)) {
      throw fail(grpc.status.FAILED_PRECONDITION, 'ROUND_IN_PROGRESS');
    }
    const round = {
      roundId: randomUUID(), requestId, playerId, choice,
      status: 'accepted', createdAt: new Date().toISOString(),
    };
    // Reserve synchronously (no await yet) so concurrent duplicates and same-player
    // starts observe this round before the durable write settles.
    const ready = appendEvent('round.accepted', round);
    requests.set(requestId, { fingerprint, roundId: round.roundId, ready: ready.catch(() => {}) });
    rounds.set(round.roundId, round);
    playerPending.set(playerId, round.roundId);
    try { await ready; }
    catch (error) {
      requests.delete(requestId);
      rounds.delete(round.roundId);
      if (playerPending.get(playerId) === round.roundId) playerPending.delete(playerId);
      console.error('Failed to persist acceptance', error);
      throw fail(grpc.status.INTERNAL, 'INTERNAL_ERROR');
    }
    scheduleCompletion(round);
    return round;
  }

  async function getRound(request) {
    const round = rounds.get(request.roundId);
    if (!round) throw fail(grpc.status.NOT_FOUND, 'ROUND_NOT_FOUND');
    return round;
  }

  async function listEvents(request) {
    const after = request.after ?? 0;
    const limit = (request.limit ?? 0) === 0 ? DEFAULT_LIMIT : request.limit;
    if (!Number.isInteger(after) || after < 0 || after > MAX_CURSOR
      || !Number.isInteger(limit) || limit < 1 || limit > DEFAULT_LIMIT) {
      throw fail(grpc.status.INVALID_ARGUMENT, 'INVALID_CURSOR');
    }
    const page = events.filter(event => event.sequence > after).slice(0, limit);
    return { events: page, nextCursor: page.length ? page[page.length - 1].sequence : after };
  }

  // Recovered pending rounds must still finish; overdue ones fire immediately.
  for (const round of rounds.values()) {
    if (round.status === 'accepted') scheduleCompletion(round);
  }

  const unary = fn => (call, callback) => {
    fn(call.request ?? {}).then(
      result => callback(null, result),
      error => {
        if (!error || typeof error.code !== 'number') {
          console.error('Unexpected service error', error);
          error = fail(grpc.status.INTERNAL, 'INTERNAL_ERROR');
        }
        callback(error);
      });
  };

  return {
    handlers: {
      health: (_call, callback) => callback(null, { ok: true }),
      startRound: unary(startRound),
      getRound: unary(getRound),
      listEvents: unary(listEvents),
    },
    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      tail.then(() => handle.close()).catch(() => {});
    },
  };
}

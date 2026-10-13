import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { grpc } from '../lib/grpc.mjs';

const id = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const roundId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = (code, details) => {
  throw Object.assign(new Error(details), { code, details });
};
export const targetFor = (value) =>
  createHash('sha256').update(value, 'utf8').digest()[0] % 3;

// A process lock prevents accidentally running two state owners against DATA_DIR.
// A killed process leaves a lock which the next owner can reclaim.
function acquireLock(path) {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (JSON.parse(readFileSync(path, 'utf8')).token === token)
            unlinkSync(path);
        } catch (error) {
          if (error.code !== 'ENOENT')
            console.error('Lock cleanup:', error.message);
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(readFileSync(path, 'utf8'));
      try {
        process.kill(owner.pid, 0);
      } catch (probe) {
        if (probe.code !== 'ESRCH') throw probe;
        unlinkSync(path);
        continue;
      }
      throw new Error(`DATA_DIR is already owned by process ${owner.pid}`);
    }
  }
  throw new Error('Could not acquire DATA_DIR lock');
}

export async function createService({ dataDir, roundDelayMs }) {
  if (
    !Number.isFinite(roundDelayMs) ||
    roundDelayMs < 0 ||
    roundDelayMs > 2147483647
  ) {
    throw new Error('ROUND_DELAY_MS must be between 0 and 2147483647');
  }
  mkdirSync(dataDir, { recursive: true });
  const release = acquireLock(join(dataDir, 'owner.lock'));
  const file = join(dataDir, 'state.json');
  const temporary = join(dataDir, 'state.next');
  let state = { version: 1, events: [], due: {} };
  let rounds = new Map(),
    requests = new Map(),
    players = new Map();
  let timer,
    closed = false;

  function index(snapshot) {
    const nextRounds = new Map(),
      nextRequests = new Map(),
      nextPlayers = new Map();
    if (
      snapshot.version !== 1 ||
      !Array.isArray(snapshot.events) ||
      !snapshot.due ||
      typeof snapshot.due !== 'object' ||
      Array.isArray(snapshot.due)
    ) {
      throw new Error('Invalid durable state');
    }
    for (const [offset, event] of snapshot.events.entries()) {
      const r = event.round;
      if (
        event.sequence !== offset + 1 ||
        !r ||
        !roundId(r.roundId) ||
        !id(r.requestId) ||
        !id(r.playerId) ||
        !Number.isInteger(r.choice) ||
        r.choice < 0 ||
        r.choice > 2 ||
        !Number.isFinite(Date.parse(r.createdAt))
      ) {
        throw new Error('Invalid durable event');
      }
      const previous = nextRounds.get(r.roundId);
      if (event.type === 'round.accepted') {
        if (
          previous ||
          nextRequests.has(r.requestId) ||
          nextPlayers.has(r.playerId) ||
          r.status !== 'accepted' ||
          'target' in r ||
          'score' in r ||
          'completedAt' in r
        )
          throw new Error('Invalid acceptance history');
        nextRequests.set(r.requestId, r.roundId);
        nextPlayers.set(r.playerId, r.roundId);
      } else if (event.type === 'round.completed') {
        if (
          !previous ||
          previous.status !== 'accepted' ||
          r.status !== 'completed' ||
          ['requestId', 'playerId', 'choice', 'createdAt'].some(
            (key) => previous[key] !== r[key],
          ) ||
          r.target !== targetFor(r.roundId) ||
          r.score !== Number(r.choice === r.target) ||
          !Number.isFinite(Date.parse(r.completedAt)) ||
          Date.parse(r.completedAt) < Date.parse(r.createdAt)
        )
          throw new Error('Invalid completion history');
        nextPlayers.delete(r.playerId);
      } else throw new Error('Invalid event type');
      Object.freeze(r);
      Object.freeze(event);
      nextRounds.set(r.roundId, r);
    }
    for (const r of nextRounds.values()) {
      if (
        r.status === 'accepted' &&
        (!Number.isFinite(snapshot.due[r.roundId]) ||
          snapshot.due[r.roundId] < Date.parse(r.createdAt))
      )
        throw new Error('Missing completion deadline');
    }
    for (const key of Object.keys(snapshot.due)) {
      if (nextRounds.get(key)?.status !== 'accepted')
        throw new Error('Orphan completion deadline');
    }
    return [nextRounds, nextRequests, nextPlayers];
  }

  function commit(type, round, dueAt) {
    if (closed) fail(grpc.status.UNAVAILABLE, 'UPSTREAM_UNAVAILABLE');
    if (state.events.length >= 4294967295)
      fail(grpc.status.RESOURCE_EXHAUSTED, 'EVENT_LIMIT');
    const due = { ...state.due };
    if (type === 'round.accepted') due[round.roundId] = dueAt;
    else delete due[round.roundId];
    const event = Object.freeze({
      sequence: state.events.length + 1,
      type,
      round: Object.freeze(round),
    });
    const next = { version: 1, events: [...state.events, event], due };
    // No request can observe a partially committed transition. Rename is the
    // commit point; process termination (not power-loss durability) is in scope.
    writeFileSync(temporary, JSON.stringify(next));
    renameSync(temporary, file);
    state = next;
    rounds.set(round.roundId, round);
    if (type === 'round.accepted') {
      requests.set(round.requestId, round.roundId);
      players.set(round.playerId, round.roundId);
    } else players.delete(round.playerId);
    return round;
  }

  function schedule(retry = false) {
    clearTimeout(timer);
    if (closed || players.size === 0) return;
    const deadline = Math.min(...Object.values(state.due));
    timer = setTimeout(
      completeDue,
      retry ? 100 : Math.max(0, Math.min(2147483647, deadline - Date.now())),
    );
  }
  function completeDue() {
    if (closed) return;
    try {
      for (const [key, deadline] of Object.entries(state.due)) {
        if (Date.now() < deadline) continue;
        const r = rounds.get(key),
          target = targetFor(key);
        commit('round.completed', {
          ...r,
          status: 'completed',
          target,
          score: Number(r.choice === target),
          completedAt: new Date().toISOString(),
        });
      }
      schedule();
    } catch (error) {
      console.error('Completion persistence failed; retrying:', error.message);
      schedule(true);
    }
  }

  try {
    try {
      state = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    [rounds, requests, players] = index(state);
    schedule();
  } catch (error) {
    release();
    throw error;
  }

  const handler = (fn) => (call, callback) => {
    try {
      if (closed) fail(grpc.status.UNAVAILABLE, 'UPSTREAM_UNAVAILABLE');
      callback(null, fn(call.request));
    } catch (error) {
      if (!Number.isInteger(error.code)) {
        console.error('Service error:', error.message);
        callback({
          code: grpc.status.UNAVAILABLE,
          details: 'UPSTREAM_UNAVAILABLE',
        });
      } else callback(error);
    }
  };
  return {
    handlers: {
      health: handler(() => ({ ok: true })),
      startRound: handler((input) => {
        const { requestId, playerId } = input,
          choice = input.choice ?? 0;
        if (
          !id(requestId) ||
          !id(playerId) ||
          !Number.isInteger(choice) ||
          choice < 0 ||
          choice > 2
        ) {
          fail(grpc.status.INVALID_ARGUMENT, 'INVALID_REQUEST');
        }
        const existing = rounds.get(requests.get(requestId));
        if (existing) {
          if (existing.playerId !== playerId || existing.choice !== choice)
            fail(grpc.status.ALREADY_EXISTS, 'IDEMPOTENCY_CONFLICT');
          return existing;
        }
        if (players.has(playerId))
          fail(grpc.status.FAILED_PRECONDITION, 'ROUND_IN_PROGRESS');
        const now = Date.now();
        const round = commit(
          'round.accepted',
          {
            roundId: randomUUID(),
            requestId,
            playerId,
            choice,
            status: 'accepted',
            createdAt: new Date(now).toISOString(),
          },
          now + roundDelayMs,
        );
        schedule();
        return round;
      }),
      getRound: handler(({ roundId: key }) => {
        if (!roundId(key))
          fail(grpc.status.INVALID_ARGUMENT, 'INVALID_REQUEST');
        const r = rounds.get(key);
        if (!r) fail(grpc.status.NOT_FOUND, 'ROUND_NOT_FOUND');
        return r;
      }),
      listEvents: handler((input) => {
        const after = input.after ?? 0,
          limit = input.limit || 100;
        if (
          !Number.isInteger(after) ||
          after < 0 ||
          after > 4294967295 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          fail(grpc.status.INVALID_ARGUMENT, 'INVALID_CURSOR');
        const events = state.events.slice(after, after + limit);
        return { events, nextCursor: events.at(-1)?.sequence ?? after };
      }),
    },
    close() {
      closed = true;
      clearTimeout(timer);
      release();
    },
  };
}

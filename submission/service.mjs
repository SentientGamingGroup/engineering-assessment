import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { grpc } from '../lib/grpc.mjs';

const validId = /^[A-Za-z0-9_-]{1,64}$/;
const validRoundId = /^[A-Za-z0-9_-]{1,128}$/;
const copy = value => structuredClone(value);

function rpcError(code, details) {
  const error = new Error(details);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeError(error) {
  if (
    error &&
    Number.isInteger(error.code) &&
    typeof error.details === 'string'
  ) {
    return error;
  }

  return rpcError(grpc.status.INTERNAL, 'INTERNAL_ERROR');
}

export async function createService({ dataDir, roundDelayMs }) {
  await mkdir(dataDir, { recursive: true });

  const logPath = join(dataDir, 'events.jsonl');
  const delayMs =
    Number.isFinite(roundDelayMs) && roundDelayMs >= 0
      ? roundDelayMs
      : 1200;

  // Current view of every round.
  const rounds = new Map();

  // Maps a request ID to its original round ID.
  const requests = new Map();

  // At most one unfinished round per player.
  const pendingPlayers = new Map();

  // Complete, ordered history of accepted/completed events.
  const events = [];

  const timers = new Map();
  let closed = false;

  // Keep state changes in order, including concurrent requests.
  let queue = Promise.resolve();

  function serialize(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  async function appendEvent(type, round) {
    const event = {
      sequence: events.length + 1,
      type,
      round: copy(round),
    };

    // Write to disk BEFORE making the event visible in memory.
    await appendFile(
      logPath,
      JSON.stringify(event) + '\n',
      'utf8',
    );

    events.push(event);
    return event;
  }

  async function finishRound(roundId) {
    return serialize(async () => {
      if (closed) return;

      const current = rounds.get(roundId);

      // Prevent a round from being completed twice.
      if (!current || current.status !== 'accepted') return;

      const target =
        createHash('sha256')
          .update(current.roundId, 'utf8')
          .digest()[0] % 3;

      const completed = {
        ...current,
        status: 'completed',
        target,
        score: current.choice === target ? 1 : 0,
        completedAt: new Date().toISOString(),
      };

      await appendEvent('round.completed', completed);

      rounds.set(roundId, completed);

      if (pendingPlayers.get(current.playerId) === roundId) {
        pendingPlayers.delete(current.playerId);
      }
    });
  }

  function scheduleCompletion(round, retryDelayMs) {
    if (closed || round.status !== 'accepted') return;

    clearTimeout(timers.get(round.roundId));

    const dueAt =
      Date.parse(round.createdAt) + delayMs;

    const waitMs =
      retryDelayMs ?? Math.max(0, dueAt - Date.now());

    const timer = setTimeout(() => {
      timers.delete(round.roundId);

      finishRound(round.roundId).catch(error => {
        console.error('Round completion failed:', error.message);

        const current = rounds.get(round.roundId);
        if (!closed && current?.status === 'accepted') {
          scheduleCompletion(current, 250);
        }
      });
    }, waitMs);

    timers.set(round.roundId, timer);
    timer.unref?.();
  }

  // Recover the event log before accepting requests.
  let log = await readFile(logPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });

  // Repair an incomplete final line after an abrupt process stop.
  if (log && !log.endsWith('\n')) {
    const lastNewline = log.lastIndexOf('\n');
    const tail = log.slice(lastNewline + 1);

    try {
      JSON.parse(tail);
      await appendFile(logPath, '\n', 'utf8');
      log += '\n';
    } catch {
      log = log.slice(0, lastNewline + 1);
      await writeFile(logPath, log, 'utf8');
    }
  }

  for (const line of log.split('\n')) {
    if (!line.trim()) continue;

    const event = JSON.parse(line);

    if (
      event.sequence !== events.length + 1 ||
      !['round.accepted', 'round.completed'].includes(event.type) ||
      !event.round
    ) {
      throw new Error('Invalid event history in ' + logPath);
    }

    events.push(event);

    const round = event.round;

    if (event.type === 'round.accepted') {
      rounds.set(round.roundId, round);
      requests.set(round.requestId, round.roundId);
      pendingPlayers.set(round.playerId, round.roundId);
    } else {
      rounds.set(round.roundId, round);
      requests.set(round.requestId, round.roundId);

      if (pendingPlayers.get(round.playerId) === round.roundId) {
        pendingPlayers.delete(round.playerId);
      }
    }
  }

  // Unfinished rounds continue even without a browser connected.
  for (const round of rounds.values()) {
    if (round.status === 'accepted') {
      scheduleCompletion(round);
    }
  }

  function handle(operation, callback) {
    serialize(operation).then(
      result => callback(null, result),
      error => callback(normalizeError(error)),
    );
  }

  return {
    handlers: {
      health: (_call, callback) => {
        callback(null, { ok: true });
      },

      startRound: (call, callback) => {
        handle(async () => {
          const request = call.request ?? {};
          const { requestId, playerId } = request;
          const choice = request.choice ?? 0;

          if (
            typeof requestId !== 'string' ||
            !validId.test(requestId) ||
            typeof playerId !== 'string' ||
            !validId.test(playerId) ||
            !Number.isInteger(choice) ||
            choice < 0 ||
            choice > 2
          ) {
            throw rpcError(
              grpc.status.INVALID_ARGUMENT,
              'INVALID_REQUEST',
            );
          }

          // Check duplicates BEFORE checking whether the player
          // already has an unfinished round.
          const existingId = requests.get(requestId);

          if (existingId) {
            const existing = rounds.get(existingId);

            if (
              existing.playerId !== playerId ||
              existing.choice !== choice
            ) {
              throw rpcError(
                grpc.status.ALREADY_EXISTS,
                'IDEMPOTENCY_CONFLICT',
              );
            }

            return {
              round: copy(existing),
              created: false,
            };
          }

          if (pendingPlayers.has(playerId)) {
            throw rpcError(
              grpc.status.FAILED_PRECONDITION,
              'ROUND_IN_PROGRESS',
            );
          }

          const accepted = {
            roundId: randomUUID(),
            requestId,
            playerId,
            choice,
            status: 'accepted',
            createdAt: new Date().toISOString(),
          };

          await appendEvent('round.accepted', accepted);

          rounds.set(accepted.roundId, accepted);
          requests.set(requestId, accepted.roundId);
          pendingPlayers.set(playerId, accepted.roundId);
          scheduleCompletion(accepted);

          return {
            round: copy(accepted),
            created: true,
          };
        }, callbackWithRound(callback));
      },

      getRound: (call, callback) => {
        handle(() => {
          const roundId = call.request?.roundId;
          const round = typeof roundId === 'string'
            && validRoundId.test(roundId)
            ? rounds.get(roundId)
            : undefined;

          if (!round) {
            throw rpcError(
              grpc.status.NOT_FOUND,
              'ROUND_NOT_FOUND',
            );
          }

          return copy(round);
        }, callback);
      },

      listEvents: (call, callback) => {
        handle(() => {
          const request = call.request ?? {};
          const after = request.after ?? 0;
          const suppliedLimit = request.limit ?? 0;
          const limit = suppliedLimit === 0 ? 100 : suppliedLimit;

          if (
            !Number.isInteger(after) ||
            after < 0 ||
            after > 4294967295 ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100
          ) {
            throw rpcError(
              grpc.status.INVALID_ARGUMENT,
              'INVALID_CURSOR',
            );
          }

          const page = events
            .filter(event => event.sequence > after)
            .slice(0, limit)
            .map(copy);

          return {
            events: page,
            nextCursor: page.length
              ? page[page.length - 1].sequence
              : after,
          };
        }, callback);
      },
    },

    close() {
      closed = true;

      for (const timer of timers.values()) {
        clearTimeout(timer);
      }

      timers.clear();
    },
  };
}

// Keeps the accepted-round response separate from the internal flag
// that tells us whether this request created a new round.
function callbackWithRound(callback) {
  return (error, result) => {
    if (error) {
      callback(error);
      return;
    }

    callback(null, result.round);
  };
}
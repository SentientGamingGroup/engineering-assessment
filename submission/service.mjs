import { grpc } from '../lib/grpc.mjs';
export async function createService({ dataDir, roundDelayMs }) {
  // TODO: durable rounds, request deduplication, scheduled completion and events.
  // Keep a single owner of state. Do not wait for a browser to finish a round.
  const unimplemented = (_call, callback) => callback({
    code: grpc.status.UNIMPLEMENTED, details: 'NOT_IMPLEMENTED',
  });
  return {
    handlers: {
      health: (_call, callback) => callback(null, { ok: true }),
      startRound: unimplemented,
      getRound: unimplemented,
      listEvents: unimplemented,
    },
    close() {},
  };
}

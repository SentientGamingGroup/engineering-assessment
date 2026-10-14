// HTTP-to-gRPC scaffolding. Review/adapt as needed; add realtime behavior in stream.mjs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { call, grpc } from '../lib/grpc.mjs';
import { attachStream } from './stream.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/client/app.mjs', ['app.mjs', 'text/javascript']],
  ['/client/state.mjs', ['state.mjs', 'text/javascript']],
  ['/client/style.css', ['style.css', 'text/css']],
]);
const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
// An empty EventPage has no repeated field on the wire (loader uses defaults:false).
// Zero-valued choice/nextCursor are written explicitly by the Go codec (codec.go).
function normalize(method, result) {
  if (method === 'listEvents') result.events ??= [];
  return result;
}
export function createGateway(client) {
  const timeout = Number(process.env.GRPC_TIMEOUT_MS || 300);
  // A deadline, cancellation or unavailable service is an unknown outcome, not a
  // rejection. Each attempt keeps the finite GRPC_TIMEOUT_MS deadline; attempts
  // repeat within a bounded budget. Every method is safe to repeat: reads
  // trivially, StartRound because the retry carries the same requestId.
  const RETRY_BUDGET_MS = 1500;
  const transient = new Set([grpc.status.DEADLINE_EXCEEDED, grpc.status.UNAVAILABLE, grpc.status.CANCELLED]);
  const invoke = async (method, payload) => {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try { return normalize(method, await call(client, method, payload, timeout)); }
      catch (error) {
        const backoff = 50 * attempt;
        if (!transient.has(error.code) || Date.now() - started + backoff + timeout > RETRY_BUDGET_MS) throw error;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const asset = assets.get(url.pathname);
      if (asset) {
        if (req.method !== 'GET') return reply(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        const bytes = await readFile(new URL(`./client/${asset[0]}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }).end(bytes);
        return;
      }
      const kind = url.pathname === '/health' ? 'health'
        : url.pathname === '/rounds' ? 'startRound'
        : /^\/rounds\/[^/]+$/.test(url.pathname) ? 'getRound'
        : url.pathname === '/events' ? 'listEvents' : undefined;
      if (!kind) return reply(res, 404, { error: { code: 'NOT_FOUND' } });
      if (req.method !== (kind === 'startRound' ? 'POST' : 'GET')) {
        return reply(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      }
      let payload = {};
      if (kind === 'startRound') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
          return reply(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8192) return reply(res, 413, { error: { code: 'BODY_TOO_LARGE' } });
          chunks.push(chunk);
        }
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reply(res, 400, { error: { code: 'INVALID_REQUEST' } }); }
        if (!payload || Array.isArray(payload)
          || Object.keys(payload).sort().join(',') !== 'choice,playerId,requestId'
          || ![payload.requestId, payload.playerId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value))
          || !Number.isInteger(payload.choice) || payload.choice < 0 || payload.choice > 2) {
          return reply(res, 400, { error: { code: 'INVALID_REQUEST' } });
        }
      } else if (kind === 'getRound') {
        try { payload = { roundId: decodeURIComponent(url.pathname.slice(8)) }; }
        catch { return reply(res, 404, { error: { code: 'ROUND_NOT_FOUND' } }); } // malformed %-escape
      } else if (kind === 'listEvents') {
        const after = url.searchParams.get('after') ?? '0';
        const limit = url.searchParams.get('limit') ?? '100';
        if (!/^\d+$/.test(after) || !/^\d+$/.test(limit)
          || Number(after) > 4294967295 || Number(limit) < 1 || Number(limit) > 100) {
          return reply(res, 400, { error: { code: 'INVALID_CURSOR' } });
        }
        payload = { after: Number(after), limit: Number(limit) };
      }
      const result = await invoke(kind, payload);
      reply(res, kind === 'startRound' ? 202 : 200, result);
    } catch (error) {
      const status = new Map([
        [grpc.status.INVALID_ARGUMENT, 400], [grpc.status.NOT_FOUND, 404],
        [grpc.status.ALREADY_EXISTS, 409], [grpc.status.FAILED_PRECONDITION, 409],
        [grpc.status.DEADLINE_EXCEEDED, 504], [grpc.status.CANCELLED, 504], [grpc.status.UNAVAILABLE, 503],
        [grpc.status.UNIMPLEMENTED, 501],
      ]).get(error.code) || 500;
      const code = error.code === grpc.status.DEADLINE_EXCEEDED || error.code === grpc.status.CANCELLED ? 'UPSTREAM_TIMEOUT'
        : error.code === grpc.status.UNAVAILABLE ? 'UPSTREAM_UNAVAILABLE'
        : error.code === grpc.status.UNIMPLEMENTED ? 'NOT_IMPLEMENTED'
        : ['INVALID_REQUEST', 'INVALID_CURSOR', 'ROUND_NOT_FOUND', 'IDEMPOTENCY_CONFLICT', 'ROUND_IN_PROGRESS'].includes(error.details)
          ? error.details : 'INTERNAL_ERROR';
      reply(res, status, { error: { code } });
    }
  });
  server.stopStream = attachStream(server, invoke);
  return server;
}

// HTTP-to-gRPC scaffolding. Review/adapt as needed; add realtime behavior in stream.mjs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { call, grpc } from '../lib/grpc.mjs';
import { attachStream } from './stream.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/client/app.mjs', ['app.mjs', 'text/javascript']],
  ['/client/style.css', ['style.css', 'text/css']],
]);
// Client TypeScript modules (/client/Name.ts), served with types stripped (see below).
// Matched by pattern rather than listed at startup, so a new module needs no restart.
const TS_MODULE = /^\/client\/([A-Za-z0-9_-]+\.ts)$/;
// Every RPC is safe to repeat: StartRound is deduplicated by requestId, the rest are reads.
// A deadline/unavailable error is an unknown outcome, so retry the same payload a bounded
// number of times before surfacing 504/503.
const RETRYABLE = new Set([grpc.status.DEADLINE_EXCEEDED, grpc.status.UNAVAILABLE]);
const ATTEMPTS = 3;
// The loader uses defaults:false and an empty repeated field is never on the wire,
// so restore the contract's shape for empty pages (HTTP and the WebSocket feed).
const withWireDefaults = (method, result, payload) => {
  if (method === 'listEvents') { result.events ??= []; result.nextCursor ??= payload.after ?? 0; }
  return result;
};
const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
/** timeoutMs is the deadline of each gRPC attempt (GRPC_TIMEOUT_MS, parsed by start.mjs). */
export function createGateway(client, { timeoutMs = 300 } = {}) {
  const invoke = async (method, payload) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return withWireDefaults(method, await call(client, method, payload, timeoutMs), payload);
      } catch (error) {
        if (!RETRYABLE.has(error.code) || attempt >= ATTEMPTS) throw error;
        await delay(50 * attempt);
      }
    }
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const tsModule = TS_MODULE.exec(url.pathname)?.[1];
      const asset = assets.get(url.pathname) ?? (tsModule && [tsModule, 'text/javascript']);
      if (asset) {
        if (req.method !== 'GET') return reply(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        let bytes;
        try { bytes = await readFile(new URL(`./client/${asset[0]}`, import.meta.url)); }
        catch (error) { if (error.code === 'ENOENT') return reply(res, 404, { error: { code: 'NOT_FOUND' } }); throw error; }
        // Node's built-in type stripping, no build step. 'strip' mode blanks types in
        // place, so line/column positions match the .ts source for debugging.
        if (asset[0].endsWith('.ts')) bytes = stripTypeScriptTypes(bytes.toString(), { mode: 'strip' });
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
        if (Number(req.headers['content-length']) > 8192) {
          res.setHeader('Connection', 'close');
          return reply(res, 413, { error: { code: 'BODY_TOO_LARGE' } });
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8192) {
            res.setHeader('Connection', 'close');
            return reply(res, 413, { error: { code: 'BODY_TOO_LARGE' } });
          }
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
        let roundId = '';
        try { roundId = decodeURIComponent(url.pathname.slice(8)); } catch { /* malformed escape */ }
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(roundId)) return reply(res, 404, { error: { code: 'ROUND_NOT_FOUND' } });
        payload = { roundId };
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
        [grpc.status.DEADLINE_EXCEEDED, 504], [grpc.status.UNAVAILABLE, 503],
        [grpc.status.UNIMPLEMENTED, 501],
      ]).get(error.code) || 500;
      const code = error.code === grpc.status.DEADLINE_EXCEEDED ? 'UPSTREAM_TIMEOUT'
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

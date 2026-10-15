// HTTP gateway: validates browser requests and forwards them to the RoundService over
// a real gRPC client with a finite deadline. It holds no domain state of its own.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { call } from '../../../lib/grpc.mjs';
import { ERROR_CODE, MAX_BODY_BYTES } from '../common/constants.mjs';
import { isRoundId, isStartRoundBody, parseEventsQuery } from '../common/validation.mjs';
import { attachStream } from './event-stream.mjs';
import { fromGrpcError, HttpError, isJsonRequest, readBody, sendError, sendJson } from './http-utils.mjs';
import { createStaticAssets } from './static-assets.mjs';

const CLIENT_DIR = fileURLToPath(new URL('../../client/', import.meta.url));

export function createGateway(client, { timeoutMs = Number(process.env.GRPC_TIMEOUT_MS || 300) } = {}) {
  const invoke = (method, payload) => call(client, method, payload, timeoutMs);
  const assets = createStaticAssets(CLIENT_DIR);

  // ---- route handlers: return [status, body] or throw HttpError
  async function startRound(req) {
    if (!isJsonRequest(req)) throw new HttpError(415, ERROR_CODE.UNSUPPORTED_MEDIA_TYPE);
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (!raw) throw new HttpError(413, ERROR_CODE.BODY_TOO_LARGE, { Connection: 'close' });
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, ERROR_CODE.INVALID_REQUEST); }
    if (!isStartRoundBody(body)) throw new HttpError(400, ERROR_CODE.INVALID_REQUEST);
    return [202, await invoke('startRound', body)];
  }

  async function getRound(_req, url, [encodedId]) {
    let roundId;
    try { roundId = decodeURIComponent(encodedId); } catch { roundId = ''; }
    if (!isRoundId(roundId)) throw new HttpError(400, ERROR_CODE.INVALID_REQUEST); // same rule as gRPC GetRound
    return [200, await invoke('getRound', { roundId })];
  }

  async function listEvents(_req, url) {
    const query = parseEventsQuery(url.searchParams);
    if (!query) throw new HttpError(400, ERROR_CODE.INVALID_CURSOR);
    const page = await invoke('listEvents', query);
    return [200, { events: page.events ?? [], nextCursor: page.nextCursor ?? query.after }];
  }

  const routes = [
    { pattern: /^\/health$/, method: 'GET', handle: async () => [200, await invoke('health', {})] },
    { pattern: /^\/rounds$/, method: 'POST', handle: startRound },
    { pattern: /^\/rounds\/([^/]+)$/, method: 'GET', handle: getRound },
    { pattern: /^\/events$/, method: 'GET', handle: listEvents },
  ];

  async function serveAsset(req, res, relative) {
    if (req.method !== 'GET') throw new HttpError(405, ERROR_CODE.METHOD_NOT_ALLOWED);
    const asset = await assets.read(relative);
    if (!asset) throw new HttpError(404, ERROR_CODE.NOT_FOUND);
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache' }).end(asset.bytes);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const asset = assets.resolve(url.pathname);
      if (asset) return await serveAsset(req, res, asset);
      for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        if (req.method !== route.method) throw new HttpError(405, ERROR_CODE.METHOD_NOT_ALLOWED);
        const [status, body] = await route.handle(req, url, match.slice(1));
        return sendJson(res, status, body);
      }
      throw new HttpError(404, ERROR_CODE.NOT_FOUND);
    } catch (error) {
      if (error instanceof HttpError) return sendError(res, error.status, error.code, error.headers);
      const { status, code } = fromGrpcError(error);
      sendError(res, status, code);
    }
  });
  // Bound slow/idle HTTP clients; WebSocket upgrades are unaffected.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.stopStream = attachStream(server, invoke);
  return server;
}

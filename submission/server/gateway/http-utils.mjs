// Small HTTP helpers shared by the gateway routes.
import { grpc } from '../../../lib/grpc.mjs';
import { ERROR_CODE } from '../common/constants.mjs';

// A route throws HttpError to send a contract error response.
export class HttpError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export const sendError = (res, status, code, headers) => sendJson(res, status, { error: { code } }, headers);

export const isJsonRequest = req => /^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '');

// Reads at most `limit` bytes. On overflow it stops buffering and drains the rest,
// resolving null, so memory stays bounded whatever the client sends.
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) return resolve(null);
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= limit) return chunks.push(chunk);
      chunks.length = 0;
      req.removeAllListeners('data');
      req.resume();
      resolve(null);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// gRPC failure → HTTP status + contract code. Timeouts/unavailability are
// "unknown outcome", never a rejection, so they keep their own codes.
const STATUS_BY_GRPC = new Map([
  [grpc.status.INVALID_ARGUMENT, 400], [grpc.status.NOT_FOUND, 404],
  [grpc.status.ALREADY_EXISTS, 409], [grpc.status.FAILED_PRECONDITION, 409],
  [grpc.status.DEADLINE_EXCEEDED, 504], [grpc.status.UNAVAILABLE, 503],
]);
const DOMAIN_CODES = new Set([
  ERROR_CODE.INVALID_REQUEST, ERROR_CODE.INVALID_CURSOR, ERROR_CODE.ROUND_NOT_FOUND,
  ERROR_CODE.IDEMPOTENCY_CONFLICT, ERROR_CODE.ROUND_IN_PROGRESS,
]);
export function fromGrpcError(error) {
  const status = STATUS_BY_GRPC.get(error.code) ?? 500;
  if (error.code === grpc.status.DEADLINE_EXCEEDED) return { status, code: ERROR_CODE.UPSTREAM_TIMEOUT };
  if (error.code === grpc.status.UNAVAILABLE) return { status, code: ERROR_CODE.UPSTREAM_UNAVAILABLE };
  return { status, code: DOMAIN_CODES.has(error.details) ? error.details : ERROR_CODE.INTERNAL_ERROR };
}

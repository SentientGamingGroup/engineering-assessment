// WebSocket event feed. Each connection runs its own gRPC cursor loop: page the
// backlog after the client's cursor, then keep polling for live events. A single
// monotonic cursor per connection makes gaps, duplicates and the backfill/live
// race impossible by construction.
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';

const PAGE_LIMIT = 100;
const LIVE_POLL_MS = 120;
const UPSTREAM_RETRY_MS = 150;
const MAX_QUEUED_OUTPUT = 256 * 1024;
// First ping at 20s, terminate at 40s without a pong — well inside the 60s bound.
const HEARTBEAT_MS = 20000;

// heartbeatMs is injectable so tests can exercise the timeout without waiting 40s.
export function attachStream(server, invoke, { heartbeatMs = HEARTBEAT_MS } = {}) {
  const sockets = new WebSocketServer({
    server, path: '/stream', maxPayload: 4096, perMessageDeflate: false,
  });
  sockets.on('connection', (socket, req) => {
    socket.on('error', () => {});
    const cursor = new URL(req.url, 'http://localhost').searchParams.get('after') ?? '0';
    if (!/^\d+$/.test(cursor) || Number(cursor) > 4294967295) {
      socket.close(1008, 'INVALID_CURSOR');
      return;
    }
    let closed = false;
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      if (socket.readyState !== socket.OPEN) return; // ping() throws while closing
      alive = false;
      socket.ping();
    }, heartbeatMs);
    socket.on('pong', () => { alive = true; });
    socket.on('close', () => { closed = true; clearInterval(heartbeat); });
    // Incoming client frames are not commands; ws enforces maxPayload (close 1009).
    (async () => {
      let after = Number(cursor);
      while (!closed && socket.readyState === socket.OPEN) {
        let page;
        try { page = await invoke('listEvents', { after, limit: PAGE_LIMIT }); }
        catch { await delay(UPSTREAM_RETRY_MS); continue; } // transient upstream fault: retry
        const events = page.events ?? [];
        for (const event of events) {
          if (closed || socket.readyState !== socket.OPEN) return;
          const frame = JSON.stringify({ type: 'event', event });
          // Count the frame about to be queued so output never exceeds the bound.
          if (socket.bufferedAmount + Buffer.byteLength(frame) > MAX_QUEUED_OUTPUT) {
            socket.close(1013, 'SLOW_CONSUMER');
            return;
          }
          socket.send(frame);
        }
        after = page.nextCursor ?? after;
        if (events.length < PAGE_LIMIT) await delay(LIVE_POLL_MS);
      }
    })().catch(() => socket.terminate());
  });
  return () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  };
}

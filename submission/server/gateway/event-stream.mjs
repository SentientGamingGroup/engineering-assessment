// Ordered WebSocket event feed over gRPC ListEvents.
//
// Each socket owns a cursor (`sent`) and a pump that pages ListEvents strictly after
// it, so backfill and live delivery are the same code path: there is no replay/live
// boundary where an event could be skipped or sent twice. One shared head poller
// notices new events and nudges the pumps; it runs only while sockets are connected.
import { WebSocketServer } from 'ws';
import { MAX_PAGE_SIZE } from '../common/constants.mjs';
import { parseCursor } from '../common/validation.mjs';

export const LIMITS = Object.freeze({
  maxQueuedBytes: 256 * 1024, // hard cap on per-socket queued output → 1013
  resumeBelowBytes: 64 * 1024, // stop fetching while a peer is this far behind
  slowConsumerMs: 10_000, // backed up this long → close 1013 (slow consumer)
  pollMs: 100,
  heartbeatMs: 25_000, // two missed pongs ≤ 50s < 60s requirement
  retryMs: 250,
});

export function attachStream(server, invoke, limits = LIMITS) {
  const sockets = new WebSocketServer({
    server, path: '/stream', maxPayload: 4096, perMessageDeflate: false,
  });
  const peers = new Set();
  let head = 0;
  let headTimer;
  let polling = false;

  const pollHead = async () => {
    headTimer = undefined;
    if (polling || peers.size === 0) return;
    polling = true;
    try {
      const page = await invoke('listEvents', { after: head, limit: MAX_PAGE_SIZE });
      if (page.nextCursor > head) {
        head = page.nextCursor;
        for (const peer of peers) peer.pump();
      }
    } catch { /* upstream slow/unavailable: try again next tick */ }
    polling = false;
    if (peers.size && !headTimer) headTimer = setTimeout(pollHead, limits.pollMs);
  };
  const ensurePolling = () => { if (!headTimer && !polling) headTimer = setTimeout(pollHead, 0); };

  const heartbeat = setInterval(() => {
    for (const peer of peers) peer.beat();
  }, limits.heartbeatMs);
  heartbeat.unref();

  sockets.on('connection', (socket, req) => {
    socket.on('error', () => {});
    const cursor = parseCursor(new URL(req.url, 'http://localhost').searchParams.get('after') ?? undefined);
    if (cursor === null) {
      socket.close(1008, 'INVALID_CURSOR');
      return;
    }
    let sent = cursor;
    let busy = false;
    let again = false;
    let alive = true;
    let closed = false;
    let retry;
    let backedUpSince = 0;
    const slowConsumer = () => {
      closed = true;
      socket.close(1013, 'SLOW_CONSUMER');
    };

    const later = () => {
      if (!closed && !retry) retry = setTimeout(() => { retry = undefined; peer.pump(); }, limits.retryMs);
    };
    const peer = {
      async pump() {
        if (closed) return;
        if (busy) { again = true; return; }
        busy = true;
        try {
          do {
            again = false;
            // Backpressure: don't fetch more while the peer is draining a backlog;
            // a peer that stays backed up is a slow consumer and is closed with 1013.
            if (socket.bufferedAmount > limits.resumeBelowBytes) {
              backedUpSince ||= Date.now();
              if (Date.now() - backedUpSince >= limits.slowConsumerMs) return slowConsumer();
              later();
              break;
            }
            backedUpSince = 0;
            const page = await invoke('listEvents', { after: sent, limit: MAX_PAGE_SIZE });
            if (closed) return;
            for (const event of page.events ?? []) {
              if (event.sequence <= sent) continue; // defensive: never resend
              const frame = JSON.stringify({ type: 'event', event });
              if (socket.bufferedAmount + Buffer.byteLength(frame) > limits.maxQueuedBytes) return slowConsumer();
              socket.send(frame);
              sent = event.sequence;
            }
            if ((page.events ?? []).length === MAX_PAGE_SIZE) again = true; // more history to page
            if (sent > head) head = sent;
          } while (again && !closed);
        } catch {
          later(); // deadline/unavailable: keep the cursor and retry
        } finally {
          busy = false;
        }
      },
      beat() {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      },
    };

    socket.on('pong', () => { alive = true; });
    // Client frames are not commands; oversize frames are rejected by ws (1009).
    socket.on('message', () => {});
    socket.on('close', () => {
      closed = true;
      clearTimeout(retry);
      peers.delete(peer);
      socket.removeAllListeners('pong');
      socket.removeAllListeners('message');
      if (peers.size === 0) { clearTimeout(headTimer); headTimer = undefined; }
    });
    peers.add(peer);
    peer.pump();
    ensurePolling();
  });

  const stop = () => {
    clearInterval(heartbeat);
    clearTimeout(headTimer);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  };
  stop.wss = sockets; // exposed for tests/diagnostics
  return stop;
}

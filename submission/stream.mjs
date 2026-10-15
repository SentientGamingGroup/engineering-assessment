// Realtime event feed. The gateway reaches the service only over unary gRPC, so
// delivery is a single cursor-driven poll of ListEvents: one monotonically
// advancing cursor means every sequence is sent exactly once and the
// backfill->live transition has no gap or duplicate by construction.
import { WebSocketServer } from 'ws';

const OUTPUT_LIMIT = 256 * 1024; // queued bytes before a slow consumer is dropped
const POLL_MS = 50;              // live latency ceiling
const PING_MS = 30000;           // two missed pings => terminated within 60s

export function attachStream(server, invoke) {
  const sockets = new WebSocketServer({
    server, path: '/stream', maxPayload: 4096, perMessageDeflate: false,
  });
  sockets.on('connection', (socket, req) => {
    socket.on('error', () => {});
    const after = new URL(req.url, 'http://localhost').searchParams.get('after') ?? '0';
    if (!/^\d+$/.test(after) || Number(after) > 4294967295) {
      socket.close(1008, 'INVALID_CURSOR');
      return;
    }
    let cursor = Number(after);
    let closed = false;
    let pumping = false;

    // Drain all events strictly after the cursor, in order, then stop until the
    // next tick. Serialized by `pumping` so sends never interleave or reorder.
    const pump = async () => {
      if (pumping || closed || socket.readyState !== socket.OPEN) return;
      pumping = true;
      try {
        for (;;) {
          const page = await invoke('listEvents', { after: cursor, limit: 100 });
          const batch = page.events ?? [];
          if (!batch.length) break;
          for (const event of batch) {
            if (closed) return;
            if (socket.bufferedAmount > OUTPUT_LIMIT) { socket.close(1013, 'SLOW_CONSUMER'); return; }
            socket.send(JSON.stringify({ type: 'event', event }));
            cursor = event.sequence;
          }
          if (batch.length < 100) break;
        }
      } catch { /* transient upstream timeout: retry on the next tick */ }
      finally { pumping = false; }
    };

    // Heartbeat: terminate a peer that misses two consecutive pings.
    let alive = true;
    socket.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      try { socket.ping(); } catch { /* closing */ }
    }, PING_MS);

    const poll = setInterval(pump, POLL_MS);
    // Client frames are not commands; they are ignored (oversize => ws sends 1009).
    socket.on('close', () => {
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
    });
    pump();
  });

  return () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  };
}

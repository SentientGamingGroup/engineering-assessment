import { WebSocket, WebSocketServer } from 'ws';
const QUEUE_LIMIT = 256 * 1024;
export function attachStream(server, invoke) {
  const sockets = new WebSocketServer({
    server,
    path: '/stream',
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  const cleanups = new Set();
  sockets.on('connection', (socket, req) => {
    socket.on('error', () => {});
    const value =
      new URL(req.url, 'http://localhost').searchParams.get('after') ?? '0';
    if (!/^\d+$/.test(value) || Number(value) > 4294967295) {
      socket.close(1008, 'INVALID_CURSOR');
      return;
    }
    let cursor = Number(value),
      timer,
      alive = true,
      stopped = false;
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 20000);
    const pong = () => {
      alive = true;
    };
    socket.on('pong', pong);
    const cleanup = () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      socket.off('pong', pong);
      cleanups.delete(cleanup);
    };
    cleanups.add(cleanup);
    socket.once('close', cleanup);
    // One cursor-driven loop covers backlog and live delivery, with at most one
    // RPC in flight. There is no subscribe-after-replay race.
    async function poll() {
      if (stopped || socket.readyState !== WebSocket.OPEN) return;
      let wait = 75;
      try {
        const result = await invoke('listEvents', {
          after: cursor,
          limit: 100,
        });
        if (stopped || socket.readyState !== WebSocket.OPEN) return;
        const events = result.events ?? [];
        for (const event of events) {
          if (event.sequence <= cursor) continue;
          const frame = JSON.stringify({ type: 'event', event });
          // Reserve the largest unmasked WebSocket frame header as well.
          if (
            socket.bufferedAmount + Buffer.byteLength(frame) + 10 >
            QUEUE_LIMIT
          ) {
            cleanup();
            socket.close(1013, 'SLOW_CONSUMER');
            const closing = setTimeout(() => socket.terminate(), 1000);
            socket.once('close', () => clearTimeout(closing));
            return;
          }
          socket.send(frame, (error) => {
            if (error) socket.terminate();
          });
          cursor = event.sequence;
        }
        if (events.length === 100) wait = 0;
      } catch {
        // Upstream failures retain the cursor. Commands still receive explicit
        // HTTP errors; a timeout never implies that a round was rejected.
        wait = 250;
      }
      if (!stopped && socket.readyState === WebSocket.OPEN)
        timer = setTimeout(poll, wait);
    }
    void poll();
  });
  return () => {
    for (const cleanup of cleanups) cleanup();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  };
}

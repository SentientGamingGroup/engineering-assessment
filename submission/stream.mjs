import { WebSocketServer } from 'ws';
export function attachStream(server, invoke) {
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
    // TODO: use invoke('listEvents', {after, limit}) to backfill and continue live.
    // Polling gRPC ListEvents is permitted; the browser must receive real WS frames.
    // Add ordered delivery, heartbeat, bounded output and cleanup on disconnect.
  });
  return () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  };
}

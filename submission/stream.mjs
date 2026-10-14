// Ordered WebSocket feed. One shared poller tails gRPC ListEvents into an
// in-memory copy of history; each socket keeps its own cursor and is pumped
// strictly from that copy. Backfill and live delivery are therefore the same
// code path, so there is no replay/live boundary where events can slip through.
import { WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_QUEUED_BYTES = 256 * 1024;
const HEARTBEAT_MS = 20000; // unanswered ping is terminated on the next tick (<= 40s)
const POLL_MS = 50;

export function attachStream(server, invoke) {
  const sockets = new WebSocketServer({
    server, path: '/stream', maxPayload: 4096, perMessageDeflate: false,
  });
  const history = []; // history[i].sequence === i + 1 (sequences are contiguous)
  const peers = new Set();
  let polling = false;
  let closed = false;

  const pump = peer => {
    while (peer.cursor < history.length && peer.socket.readyState === peer.socket.OPEN) {
      const frame = JSON.stringify({ type: 'event', event: history[peer.cursor] });
      if (peer.socket.bufferedAmount + frame.length > MAX_QUEUED_BYTES) {
        peer.socket.close(1013, 'SLOW_CONSUMER'); // client reconnects from its cursor
        return;
      }
      peer.socket.send(frame);
      peer.cursor++;
    }
  };

  // Runs only while someone is listening; stops itself when the last peer leaves.
  async function poll() {
    if (polling) return;
    polling = true;
    let backoff = POLL_MS;
    while (!closed && peers.size > 0) {
      try {
        const page = await invoke('listEvents', { after: history.length, limit: 100 });
        for (const event of page.events ?? []) {
          if (event.sequence === history.length + 1) history.push(event);
        }
        for (const peer of peers) pump(peer);
        backoff = POLL_MS;
        if ((page.events?.length ?? 0) === 100) continue; // more backlog: no sleep
      } catch {
        backoff = Math.min(backoff * 2, 1000); // service down/restarting: sockets stay open
      }
      await delay(backoff);
    }
    polling = false;
  }

  sockets.on('connection', (socket, req) => {
    socket.on('error', () => {});
    const cursor = new URL(req.url, 'http://localhost').searchParams.get('after') ?? '0';
    if (!/^\d+$/.test(cursor) || Number(cursor) > 4294967295) {
      socket.close(1008, 'INVALID_CURSOR');
      return;
    }
    const peer = { socket, cursor: Number(cursor), alive: true };
    const heartbeat = setInterval(() => {
      if (!peer.alive) return socket.terminate();
      peer.alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    socket.on('pong', () => { peer.alive = true; });
    // Messages from clients are not commands; ws already enforces the size cap (1009).
    socket.on('close', () => {
      clearInterval(heartbeat);
      peers.delete(peer);
    });
    peers.add(peer);
    pump(peer);
    poll();
  });

  return () => {
    closed = true;
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  };
}

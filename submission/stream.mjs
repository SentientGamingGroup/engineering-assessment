// WebSocket event feed. The gateway owns no round state: it reads the log through
// gRPC ListEvents. Each socket keeps its own cursor (last sequence sent) and only
// ever sends sequence cursor+1, so backfill and live delivery are the same loop and
// there is no replay/live boundary to race on.
//
// One shared poller tracks the log head and keeps a bounded tail cache so caught-up
// sockets are fed without extra RPCs; lagging sockets page through gRPC themselves.
// Nothing is queued per socket beyond what ws has already buffered, so memory per
// connection is bounded by the high-water mark plus one page.
//
// Slow consumers: above HIGH_WATER a socket gets nothing more until it drains. Staying
// there for STALL_MS, or passing MAX_QUEUED, closes it with 1013 and destroys it
// CLOSE_GRACE_MS later: a stuck reader never reads the close frame, and ws would
// otherwise keep it (and its buffer) for its 30s close timeout.
// Heartbeat: every HEARTBEAT_MS each socket is pinged, and one that hasn't answered
// the previous ping is dropped, so a dead peer goes within two intervals (<60s). If
// its output is backed up, the ping is stuck behind it: that is a slow consumer
// (1013), not a dead one.
import WebSocket, { WebSocketServer } from 'ws';

const PAGE = 100;
const POLL_MS = 50;
const CACHE_LIMIT = 1000;
const HIGH_WATER = 64 * 1024;     // stop sending above this; resume on a later tick
const MAX_QUEUED = 256 * 1024;    // hard cap on buffered output -> 1013
const STALL_MS = 30_000;          // above high water this long -> 1013 slow consumer
const CLOSE_GRACE_MS = 1000;      // after a 1013, destroy the connection this much later
const HEARTBEAT_MS = 25_000;      // a silent peer is terminated within 2 intervals (<60s)

export function attachStream(server, invoke) {
  const sockets = new WebSocketServer({
    server, path: '/stream', maxPayload: 4096, perMessageDeflate: false,
  });
  const clients = new Set();
  let head = 0;
  let recent = []; // contiguous tail of the log ending at `head`
  let polling = false;
  let pollTimer;
  let heartbeatTimer;

  const fetchPage = async after => (await invoke('listEvents', { after, limit: PAGE })).events ?? [];

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      for (;;) {
        const page = await fetchPage(head);
        for (const event of page) {
          if (event.sequence !== head + 1) break;
          recent.push(event);
          head = event.sequence;
        }
        if (page.length < PAGE) break;
      }
      if (recent.length > CACHE_LIMIT) recent = recent.slice(-CACHE_LIMIT);
    } catch { /* service unavailable/slow: next tick retries */ }
    finally { polling = false; }
    for (const client of clients) client.pump();
  };

  const eventsAfter = async cursor => {
    if (cursor >= head) return [];
    const first = recent[0]?.sequence;
    if (first !== undefined && first <= cursor + 1) {
      const start = cursor + 1 - first;
      return recent.slice(start, start + PAGE);
    }
    return fetchPage(cursor);
  };

  const heartbeat = () => {
    for (const client of clients) {
      if (!client.alive) {
        if (client.blockedSince) client.slow(); // the ping is queued behind its backlog
        else client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  };

  const track = (socket, cursor) => {
    const client = { socket, cursor, alive: true, pumping: false, again: false, blockedSince: 0, killTimer: undefined };
    client.slow = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.close(1013, 'SLOW_CONSUMER');
      client.killTimer = setTimeout(() => socket.terminate(), CLOSE_GRACE_MS);
    };
    client.pump = async () => {
      if (client.pumping) { client.again = true; return; }
      client.pumping = true;
      try {
        do {
          client.again = false;
          while (socket.readyState === WebSocket.OPEN) {
            if (socket.bufferedAmount > HIGH_WATER) {
              client.blockedSince ||= Date.now();
              if (Date.now() - client.blockedSince > STALL_MS) client.slow();
              break;
            }
            client.blockedSince = 0;
            const page = await eventsAfter(client.cursor);
            let sent = 0;
            for (const event of page) {
              if (socket.readyState !== WebSocket.OPEN) break;
              if (event.sequence <= client.cursor) continue;
              if (event.sequence !== client.cursor + 1) break; // never skip ahead
              socket.send(JSON.stringify({ type: 'event', event }));
              client.cursor = event.sequence;
              sent++;
              if (socket.bufferedAmount > MAX_QUEUED) {
                client.slow();
                break;
              }
            }
            if (!sent) break;
          }
        } while (client.again && socket.readyState === WebSocket.OPEN);
      } catch { /* gRPC hiccup: the next poll tick pumps again */ }
      finally { client.pumping = false; }
    };
    clients.add(client);
    if (!pollTimer) {
      pollTimer = setInterval(poll, POLL_MS);
      heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    }
    socket.on('pong', () => { client.alive = true; });
    socket.on('message', () => {}); // client frames are not commands; ws enforces 4096 bytes (1009)
    socket.once('close', () => {
      clearTimeout(client.killTimer);
      clients.delete(client);
      socket.removeAllListeners('pong');
      socket.removeAllListeners('message');
      if (!clients.size) {
        clearInterval(pollTimer); clearInterval(heartbeatTimer);
        pollTimer = heartbeatTimer = undefined;
      }
    });
    client.pump();
  };

  sockets.on('error', () => {});
  sockets.on('connection', (socket, req) => {
    socket.on('error', () => {});
    const cursor = new URL(req.url, 'http://localhost').searchParams.get('after') ?? '0';
    if (!/^\d+$/.test(cursor) || Number(cursor) > 4294967295) {
      socket.close(1008, 'INVALID_CURSOR');
      return;
    }
    track(socket, Number(cursor));
  });
  return () => {
    clearInterval(pollTimer); clearInterval(heartbeatTimer);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  };
}

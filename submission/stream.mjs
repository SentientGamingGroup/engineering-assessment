
import { WebSocketServer, WebSocket } from 'ws';

const POLL_INTERVAL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_QUEUED_BYTES = 256 * 1024;

export function attachStream(server, invoke) {
  const sockets = new WebSocketServer({
    server,
    path: '/stream',
    maxPayload: 4096,
    perMessageDeflate: false,
  });

  const clients = new Map();
  let stopped = false;

  function cleanup(socket) {
    const state = clients.get(socket);
    if (!state) return;

    state.closed = true;

    if (state.timer) {
      clearTimeout(state.timer);
    }

    clients.delete(socket);
    socket.removeListener('pong', state.onPong);
    socket.removeListener('close', state.onClose);
    socket.removeListener('error', state.onError);
  }

  async function poll(socket, state) {
    if (
      stopped ||
      state.closed ||
      state.polling ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    state.polling = true;
    let nextDelay = POLL_INTERVAL_MS;

    try {
      // Ask for events after the last event sent on this connection.
      const page = await invoke('listEvents', {
        after: state.cursor,
        limit: 100,
      });

      if (
        stopped ||
        state.closed ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      const events = Array.isArray(page.events)
        ? page.events
        : [];

      for (const event of events) {
        if (
          state.closed ||
          socket.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        // Ignore an event already sent on this connection.
        if (event.sequence <= state.cursor) continue;

        // A missing sequence means the history is inconsistent.
        if (event.sequence !== state.cursor + 1) {
          socket.close(1011, 'EVENT_SEQUENCE_GAP');
          return;
        }

        const message = JSON.stringify({
          type: 'event',
          event,
        });

        const bytes = Buffer.byteLength(message);

        // Don't let a slow browser build up an unlimited queue.
        if (socket.bufferedAmount + bytes > MAX_QUEUED_BYTES) {
          socket.close(1013, 'SLOW_CONSUMER');
          return;
        }

        socket.send(message, error => {
          if (error) socket.terminate();
        });

        state.cursor = event.sequence;
      }

      // If we received a full page, check again immediately
      // so large histories can be replayed without long pauses.
      if (events.length === 100) nextDelay = 0;
    } catch {
      // A temporary service error shouldn't permanently break
      // the connection. Retry and replay from the same cursor.
      nextDelay = 250;
    } finally {
      state.polling = false;

      if (
        !stopped &&
        !state.closed &&
        socket.readyState === WebSocket.OPEN
      ) {
        state.timer = setTimeout(
          () => void poll(socket, state),
          nextDelay,
        );

        state.timer.unref?.();
      }
    }
  }

  sockets.on('connection', (socket, request) => {
    const onError = () => {};
    socket.on('error', onError);

    const rawCursor =
      new URL(request.url, 'http://localhost')
        .searchParams.get('after') ?? '0';

    if (
      !/^\d+$/.test(rawCursor) ||
      Number(rawCursor) > 4294967295
    ) {
      socket.close(1008, 'INVALID_CURSOR');
      socket.once('close', () => {
        socket.removeListener('error', onError);
      });
      return;
    }

    const state = {
      cursor: Number(rawCursor),
      timer: null,
      closed: false,
      polling: false,
      alive: true,
      onError,
      onPong: null,
      onClose: null,
    };

    state.onPong = () => {
      state.alive = true;
    };

    state.onClose = () => cleanup(socket);

    socket.on('pong', state.onPong);
    socket.on('close', state.onClose);

    clients.set(socket, state);

    // Replay old events first, then continue with new ones.
    void poll(socket, state);
  });

  // Ping every 20 seconds. An unresponsive connection is
  // terminated on the next check, within about 40 seconds.
  const heartbeat = setInterval(() => {
    for (const [socket, state] of clients) {
      if (socket.readyState !== WebSocket.OPEN) {
        cleanup(socket);
        continue;
      }

      if (!state.alive) {
        socket.terminate();
        cleanup(socket);
        continue;
      }

      state.alive = false;

      socket.ping(error => {
        if (error) socket.terminate();
      });
    }
  }, HEARTBEAT_INTERVAL_MS);

  heartbeat.unref?.();

  return () => {
    stopped = true;
    clearInterval(heartbeat);

    for (const socket of clients.keys()) {
      cleanup(socket);
      socket.terminate();
    }

    sockets.close();
  };
}

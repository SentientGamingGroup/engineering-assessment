// Ordered event feed over WebSocket with bounded reconnect backoff.
// It always reconnects from the caller's *last applied* cursor, so nothing is missed.
import { backoff } from './api.mjs';

const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 10_000;

export function createFeed({ getCursor, onEvent, onOpen, onStatus }) {
  let socket;
  let timer;
  let attempt = 0;

  function connect() {
    clearTimeout(timer);
    onStatus(attempt ? 'reconnecting' : 'connecting', attempt ? 'Reconnecting…' : 'Connecting…');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${scheme}//${location.host}/stream?after=${getCursor()}`);
    socket.onopen = () => {
      attempt = 0;
      onStatus('live', 'Live');
      onOpen();
    };
    socket.onmessage = message => {
      let data;
      try { data = JSON.parse(message.data); } catch { return; }
      if (data?.type === 'event') onEvent(data.event);
    };
    socket.onclose = () => {
      socket = undefined;
      const wait = backoff(attempt++, RECONNECT_BASE_MS, RECONNECT_CAP_MS);
      onStatus('reconnecting', `Reconnecting in ${Math.ceil(wait / 1000)}s…`);
      timer = setTimeout(connect, wait);
    };
  }

  return {
    start: connect,
    isOpen: () => socket?.readyState === WebSocket.OPEN,
  };
}

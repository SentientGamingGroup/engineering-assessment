// WebSocket event feed from the last applied cursor, reconnecting with bounded
// backoff. On a gap it reconnects from the cursor rather than skipping ahead.
import { backoff } from './util.ts';
import type { RoundEvent } from './types.ts';

export interface FeedListener {
  /** (Re)connected: catch up on anything missed while offline. */
  onOpen(): void;
  /** An event that is not ahead of the cursor (duplicates are the listener's to ignore). */
  onEvent(event: RoundEvent): void;
  onStatus(text: string): void;
}

export class EventFeed {
  private readonly cursor: () => number;
  private readonly listener: FeedListener;
  private socket: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(cursor: () => number, listener: FeedListener) {
    this.cursor = cursor;
    this.listener = listener;
    addEventListener('online', () => {
      if (!this.socket) { this.attempt = 0; this.connect(); }
    });
  }

  connect(): void {
    clearTimeout(this.timer);
    if (this.socket) return;
    this.listener.onStatus('Connecting…');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream?after=${this.cursor()}`);
    this.socket = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.listener.onStatus('Connected');
      this.listener.onOpen();
    };
    ws.onmessage = message => {
      let data;
      try { data = JSON.parse(message.data); } catch { return; }
      const event: RoundEvent | null = data?.type === 'event' ? data.event : null;
      if (!event || !Number.isInteger(event.sequence)) return;
      if (event.sequence > this.cursor() + 1) { // gap: resume from last applied
        ws.close(4000, 'gap');
        return;
      }
      this.listener.onEvent(event);
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      const wait = backoff(this.attempt++);
      this.listener.onStatus(`Disconnected — reconnecting in ${Math.ceil(wait / 1000)}s`);
      this.timer = setTimeout(() => this.connect(), wait);
    };
  }

  /** Drop the connection; it reconnects from the current cursor. */
  restart(reason: string): void {
    this.socket?.close(4001, reason);
  }
}

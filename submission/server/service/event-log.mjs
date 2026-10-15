// Durable append-only event log: one JSON event per line in DATA_DIR/events.jsonl.
// append() returns only after fsync, so callers may acknowledge immediately after it.
import { closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const FILE_NAME = 'events.jsonl';

// Replays the file. A torn final line is an unacknowledged write interrupted by a
// crash and is truncated; a bad line anywhere earlier is corruption and is fatal.
function replay(fd, text) {
  const events = [];
  const total = Buffer.byteLength(text);
  let offset = 0;
  for (const line of text.split('\n')) {
    const end = offset + Buffer.byteLength(line) + 1;
    if (line) {
      let event;
      try { event = JSON.parse(line); } catch { event = undefined; }
      if (!event || event.sequence !== events.length + 1) {
        if (end < total) throw new Error(`Corrupt event log at byte ${offset}`);
        ftruncateSync(fd, offset);
        fsyncSync(fd);
        break;
      }
      events.push(event);
    }
    offset = end;
  }
  return events;
}

export function openEventLog(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, FILE_NAME);
  const fd = openSync(file, 'a+');
  const events = replay(fd, readFileSync(file, 'utf8'));
  let closed = false;

  return {
    get size() { return events.length; },
    replayed: () => events.slice(),
    page: (after, limit) => events.slice(after, after + limit),
    append(type, round) {
      const event = Object.freeze({ sequence: events.length + 1, type, round });
      writeSync(fd, JSON.stringify(event) + '\n');
      fsyncSync(fd);
      events.push(event);
      return event;
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

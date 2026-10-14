// WebSocket feed resource bounds (stream.mjs) over a stub event log: a peer that stops
// reading is closed (1013) and its connection destroyed promptly once its queued output
// passes 256 KiB, instead of holding the backlog in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { attachStream } from '../stream.mjs';

test('a consumer that stops reading is cut off once 256 KiB is queued', async () => {
  // ~10 MB of backlog in ~100 KB frames: far more than the kernel socket buffers absorb.
  const filler = 'x'.repeat(100_000);
  const log = Array.from({ length: 100 }, (_, i) => ({
    sequence: i + 1, type: 'round.accepted', round: { roundId: `r${i}`, requestId: filler },
  }));
  const invoke = async (_method, { after, limit }) => ({ events: log.slice(after, after + limit) });
  const server = createServer();
  const stopStream = attachStream(server, invoke);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const destroyed = new Promise(resolve => server.once('connection', socket => socket.once('close', resolve)));

  // Upgrade, then never read: a paused socket leaves the server's output queued.
  const peer = connect(server.address().port, '127.0.0.1');
  peer.pause();
  peer.write('GET /stream?after=0 HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  try {
    const outcome = await Promise.race([destroyed.then(() => 'destroyed'), delay(5000, 'still open', { ref: false })]);
    assert.equal(outcome, 'destroyed', 'the slow consumer is not left to ws\'s 30s close timeout');
  } finally {
    peer.destroy();
    stopStream();
    server.close();
  }
});

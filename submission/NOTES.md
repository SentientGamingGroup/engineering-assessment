# Notes

## Architecture and state owner
`service.mjs` is the only owner of round and event state. The HTTP/WebSocket
gateway is a thin layer that reaches the service over real gRPC, so the browser
never has a privileged path to state. The flow is browser, HTTP/WS gateway, gRPC
client, RoundService.

The durable source of truth is an append-only JSONL event log under `DATA_DIR`.
In-memory maps (`rounds`, `byRequest`, `pendingByPlayer`, `events`) are rebuilt from
the log on boot. Sequence assignment, the fsync, and the in-memory append all happen
inside one serialized write queue, so no event is visible on the feed (ListEvents or
WebSocket) before it is durable, and sequence numbers are contiguous with no gaps.

## Duplicate handling and the player guard
`startRound` does its checks synchronously, before any await, so Node's single
thread serializes concurrent duplicates with no interleaving. Order matches the
contract: idempotency first (same requestId replays the round, even once completed;
same requestId with a different payload is IDEMPOTENCY_CONFLICT), then the
one-pending-round-per-player guard (ROUND_IN_PROGRESS). A round is acknowledged only
after its accepted event is durable.

## Crash and completion
A timer owned by the service completes rounds, never a client read. On SIGKILL the
log is intact up to the last fsync; on restart, any round with an accepted but no
completed event is rescheduled, and fires at once if already past due. createdAt,
target, and prior results are preserved because they live in the replayed snapshots.
Completion is stamped at max(now, createdAt + delay) so the "completed at least delay
after created" rule holds despite timer jitter and millisecond flooring.

## Gateway deadlines
Every gateway-to-service call carries a GRPC_TIMEOUT_MS deadline (default 300ms).
DEADLINE_EXCEEDED and UNAVAILABLE map to 504 and 503 and do not mean a round was
rejected or completed; the client retries with the same requestId, so a timed-out
start is idempotent.

## WebSocket replay and backpressure
The gateway only has unary gRPC, so the stream is a single cursor-driven poll of
ListEvents. One advancing cursor means backfill and live delivery are the same
mechanism, so there is no gap or duplicate at the boundary and reconnect-from-cursor
is automatic. A pumping flag serializes sends. If bufferedAmount passes 256 KiB the
socket closes 1013; oversize inbound frames close 1009 (ws maxPayload), malformed
cursors close 1008. A ping every 30s terminates a peer that misses two beats. Timers
are cleared on close.

## Client state and timeline
`client/app.mjs` is a four-state machine (idle, pending, revealing, revealed) over a
single requestAnimationFrame timeline with frame-rate-independent timing, so Pause
freezes presentation while the server keeps running. Intent (requestId, playerId,
choice, roundId) is saved before the POST, and the last applied cursor is saved too,
so a refresh or dropped socket resumes the same round and reconciles over HTTP rather
than waiting on a possibly missed event. Events are applied by increasing sequence, so
redelivery is ignored and the score counts each completed round once. Reconnect uses
bounded backoff; reduced motion collapses motion but keeps the same outcome; beacons
are keyboard-selectable with visible focus and textual results.

## One tradeoff
Polling ListEvents every 50ms is simple and gap-proof but adds up to ~50ms of live
latency. A streaming RPC or in-process pub/sub would be push-based and lower latency,
but the unary-only contract and the "polling permitted" guidance made the cursor poll
the right call for the timebox.

## Gaps
- The event log grows unbounded. Production would want compaction and snapshots.
- Single-process service; a single authoritative owner is assumed.
- Client behavior is evidenced in DEMO.md via a headless-browser pass, not a headless
  DOM unit test.

## Actual time
Built in a single working session on 2026-10-15, on the order of a few hours of
wall-clock: reading the brief and the checker, implementation, the checker iteration
loop, a review pass, and the browser evidence in DEMO.md.

## AI and tool use
Built with Claude Code as a pair-programming tool throughout, iterating against the
acceptance checker, and the browser evidence was produced by a headless-Chromium
driver (`evidence/drive.mjs`). The design decisions (the cursor-poll stream, the
synchronous idempotency section, the durable-before-visible feed, the completion-time
clamp) were reviewed and are understood, and I can walk through any part.

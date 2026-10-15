# Beacon Relay — notes

Commands as in SUBMISSION.md; no extra install or codegen. Verified on Node 22.23, 24.21 and 25.9.

**Architecture / state owner.** `browser ─HTTP/WS→ gateway ─gRPC→ RoundService → DATA_DIR/events.jsonl`, two
listeners in one process. `server/service/` is the only state owner: an fsynced append-only event log is
the database, in-memory maps are a projection rebuilt at boot, and a PID lock (`owner.lock`, stale locks
from crashed PIDs are taken over) keeps one owner per DATA_DIR. `server/gateway/` holds no domain state;
it validates with the same `server/common/validation.mjs` the service uses and calls a real gRPC client.
Client: `core/` (pure logic) ← `services/` (HTTP, WebSocket, localStorage) ← `ui/` ← `app.mjs` (controller).
The root `gateway/service/stream.mjs` files only re-export, to keep the starter paths.

**Crash and duplicate handling.** StartRound runs validate → requestId lookup → player guard → append
(fsync) → reply in one synchronous turn, so 20 concurrent duplicates make one round without locks, and
duplicates are resolved before the busy-player check. Same payload returns the current snapshot, a different one
returns ALREADY_EXISTS. The service schedules completion at `createdAt + ROUND_DELAY_MS`. At boot, pending
rounds are rescheduled (overdue → immediately), and completion checks `status === accepted`, so nothing
completes twice. A torn final log line (crash mid-write, never acknowledged) is truncated; earlier
corruption refuses startup.

**Gateway gRPC deadlines.** Every call has a `GRPC_TIMEOUT_MS` (300 ms) deadline. DEADLINE_EXCEEDED → 504
UPSTREAM_TIMEOUT and UNAVAILABLE → 503 UPSTREAM_UNAVAILABLE both mean *unknown outcome*: the client retries the same
requestId with bounded backoff (0.3–5 s), so a retry can only return the original round. Bodies are capped at 8 KiB
(413 + `Connection: close`) and malformed round IDs get 400 INVALID_REQUEST, the same rule as gRPC.

**WebSocket replay / backpressure.** Each socket has a cursor and one pump that pages `ListEvents(after)`
over gRPC. Backfill and live delivery are the same loop, so the boundary cannot drop or repeat events. A
shared 100 ms head poller (running only while sockets exist) nudges the pumps. Output: no fetching while
more than 64 KiB is queued; staying backed up for 10 s, or exceeding 256 KiB, closes with **1013**. Input frames
over 4 KiB → 1009 (`maxPayload`), compression off, client frames ignored. Heartbeat: ping every 25 s, and
a peer that missed a pong is terminated (≤ 50 s). On close, timers and listeners are cleared and the poller stops
with the last socket.

**Client state / timeline lifecycle.** Phases `idle → starting → playing → revealed` (+ `replaying`),
with one `controlsFor()` table for buttons. The intent `{requestId, choice}`, player, round, cursor and
score ledger persist in localStorage *before* the POST, so a refresh resumes the same round; a loader hides the first paint until that state is restored and connected (≤ 1.5 s). A single rAF loop
advances presentation time by clamped deltas (frame-rate independent, background-safe). The pulse orbits a true
circle until the server's target is known, then decelerates on a Hermite curve that ends exactly on it:
1.8–3.0 s after the result (reduced motion: 0.55 s, no orbit). Pause, Skip and Replay change presentation
only; Replay sends nothing. Score counts unique completed roundIds. The WebSocket reconnects with jittered backoff
(0.5–10 s) from the last applied cursor, then reconciles via GET; it polls GET while offline.
ROUND_IN_PROGRESS (another tab) retries the same requestId. Rendering is DOM + CSS transforms: real
`<button>` beacons give keyboard, focus and screen-reader support, and there is no canvas DPR/resize handling to get wrong.

**Tradeoff.** Synchronous fsync per event on the event loop makes the critical section trivially atomic
and durability easy to reason about, but blocks for one fsync per write. That's fine for 20 duplicates and 10 players;
at scale I'd use a single writer with group commit and an explicit in-flight map.

**Gaps.** The log is never compacted (the brief asks to retain full history). The lock can't tell a
reused PID from its crashed owner. A browser whose saved cursor is ahead of a wiped server misses events until
storage is cleared. The slow-peer test pauses a real socket but on loopback only. Browsers tested: see DEMO.md.

**Tests** (`node submission/test.mjs`, 28): service concurrency, dedupe, restart, torn log and lock;
WebSocket backfill race, upstream errors, 1013 on a stalled reader, heartbeat; validation; SIGKILL
system test with WebSocket resume; client timeline, ledger, controls and messages.

**Actual time:** started 2026-10-14 21:00 PKT; total working time about 8 h.

**AI/tool use:** Claude Code (Anthropic) wrote most of the code, tests and notes under my direction. I
reviewed it, ran every check locally and played the game myself. Results above are from local runs.

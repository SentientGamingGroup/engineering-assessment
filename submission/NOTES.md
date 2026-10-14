# Beacon Relay — implementation notes

**Stack:** Go 1.26 gRPC `RoundService` (`roundsvc/`), the supplied Node HTTP/WebSocket
gateway, and a vanilla JS client (DOM buttons + Canvas effects). No frameworks.

```
browser ──HTTP/WS──▶ Node gateway (gateway.mjs, stream.mjs) ──gRPC──▶ Go roundsvc ──▶ DATA_DIR/events.jsonl
```

## Install / run

No extra steps beyond the README commands. `node submission/start.mjs` runs `go build`
the first time (downloads modules listed in `go.mod`/`go.sum`, ~8 s cold), caches the
binary in `submission/build/roundsvc-<source hash>` and reuses it until the Go source
changes. Protobuf bindings in `roundsvc/pb/` are committed (regenerate with `protoc` +
`protoc-gen-go`/`-go-grpc`, mapping `Mrounds.proto=beaconrelay/roundsvc/pb`, because the
contract has no `go_package` and must not be edited). The starter's Node `service.mjs`
stub was removed; Go replaces it.

## State owner, durability and recovery

- One goroutine (`Service.run`) owns all state. RPC handlers send closures over a
  channel, so 20 concurrent duplicates are serialized, not raced — no locks.
- Every change is one JSON line appended to `events.jsonl`. **Group commit:** the owner
  runs every job already queued, fsyncs once, and only then releases those callers, so
  nothing is acknowledged before it is on disk, and N concurrent writes cost one fsync.
  (Measured on this ZFS disk: fsync is usually ~5 ms but stalls 200–500 ms under load;
  one fsync per request made 10 concurrent StartRounds miss the 300 ms deadline.)
  A failed fsync is fail-stop: the process exits and recovery reloads from the log.
- Startup replays the log to rebuild rounds, the `requestId → roundId` index and
  per-player pending rounds, then re-arms timers at `createdAt + delay` (overdue rounds
  fire immediately). `completedAt = max(now, createdAt + delay)`.
- A torn final line (crash mid-write, never acknowledged) is truncated; a malformed
  complete line or sequence gap is real corruption and fails startup loudly.
- Completion is idempotent: only an `accepted` round produces `round.completed`.

## Duplicates and concurrency

`requestId` is resolved first (same payload → original round, even if completed;
changed payload → `ALREADY_EXISTS/IDEMPOTENCY_CONFLICT`), then the one-pending-round-per-
player guard (`FAILED_PRECONDITION/ROUND_IN_PROGRESS`). Different players are independent.

## Gateway gRPC deadlines

Every call has `GRPC_TIMEOUT_MS` (300 ms). `DEADLINE_EXCEEDED`, `CANCELLED` (what a Go
handler reports when the caller's deadline cancels its context) and `UNAVAILABLE` are an
*unknown outcome*: the gateway retries with the **same payload** inside a bounded 1.5 s
budget (StartRound is deduplicated by `requestId`, reads are naturally safe), then
returns 504 `UPSTREAM_TIMEOUT` / 503. The service may still commit a call whose deadline expired; that is exactly why
retries reuse the identity. The client does the same across refreshes.

## WebSocket replay and backpressure

One shared poller tails `ListEvents` (50 ms, no sleep while pages are full) into an
in-memory copy of history; it runs only while a socket is connected. Each socket has its
own cursor and is pumped from that copy, so backfill and live delivery are one code path
and there is no replay/live seam where events can be missed or repeated.
Limits: incoming frames ≤ 4096 B (`ws` closes 1009), compression off, outgoing queue
≤ 256 KiB (`bufferedAmount`, else close **1013**; client resumes from its cursor),
ping every 20 s and terminate if the previous ping is unanswered (dead peer gone ≤ 40 s).
Interval and peer entry are removed on close; shutdown terminates all sockets.

## Client state and timeline lifecycle

`client/state.mjs` is a pure reducer (no DOM/network), unit-tested. Phases:
`idle → submitting → pending → revealing → revealed`, with replay looping
`revealed → revealing`. It ignores replies/events for other requests (stale), events with
`sequence ≤ cursor` (redelivery), and never moves a completed round back to accepted.
Score = sum over **unique completed roundIds** for this player, from events only, so
replay/redelivery cannot add points. Persisted to `localStorage`: player, intent
(`requestId`, choice), cursor, counted roundIds. On reload/reconnect a pending intent is
resubmitted with the same `requestId` and the server returns the original round.
`app.mjs` runs **one** `requestAnimationFrame` loop for the page lifetime; scenes only reset
a clock. Time comes from rAF timestamps, clamped to 100 ms per frame so a background tab
pauses rather than jumping. Reveal is 2.5 s (travel 48 %, impact burst 52 %); reduced
motion uses a 0.6 s fade with the same outcome. Reconnect backoff: 0.5 s doubling to
10 s with jitter. **Rendering choice:** beacons stay real `<button>`s (keyboard, focus,
screen readers for free); a `<canvas>` overlay draws the pulse and reads beacon positions
from layout on resize, at device-pixel ratio.

## Tradeoff

**Polling ListEvents instead of a streaming RPC.** The contract has no server-streaming
method and must not change, so the gateway polls. Cost: up to ~50 ms extra latency and
idle RPCs while sockets are connected. Benefit: no contract change, and ordering/gap-
freedom come from sequence cursors rather than delivery timing. The gateway also keeps
all history in memory, fine for this exercise's size, not for production.

## Harness/contract finding: zero values on the wire

proto3 never encodes a zero-valued plain scalar, and `lib/grpc.mjs` loads with
`defaults: false`, so a standard server makes `choice: 0` (and `nextCursor: 0`) arrive as
*absent*. That broke `check.mjs:29` (`score` expected from `undefined === target`) for
choice-0/target-0 rounds — most full runs — and HTTP rounds lacked the `choice` field
that `docs/API.md` lists. **Resolved without touching the harness:** `roundsvc/codec.go`
writes those scalars explicitly. That is valid protobuf wire format (decoders must accept
it; round-trip tested), values are unchanged, and every client now sees the full public
shape. The client still restores an absent `choice` defensively (`normalizeRound`).

## Gaps

- Firefox/Safari and real devices not tested (see DEMO.md).
- Gateway history cache is unbounded (fine at this scale).
- fsync stalls longer than the 1.5 s gateway budget would still surface as 504
  (an unknown outcome the client retries with the same `requestId`).
- If the Go service dies after startup the launcher exits non-zero instead of restarting
  it; a process manager would restart it and recovery is automatic.
- Audio not implemented (optional, no points).

## Tests

`node submission/test.mjs` runs: Go unit tests with `-race` (concurrent duplicates,
conflict/player guard, single completion after delay, 10 concurrent players never
completing early or twice with correct win/miss scores, restart recovery, torn-tail
truncation, paging, codec round trip); 10 client state/timeline tests (including a miss
staying at 0 points across replay, redelivery and refresh); an end-to-end test that SIGKILLs the
real stack with 10 pending rounds (plus duplicates) and checks each completes exactly
once with a gap-free WebSocket feed and correct cursor resume.

## Time and AI use

About 6.5 hours of working time. AI assistance: Claude Code (Claude Opus) wrote most of
the code and notes in a pair-programming session that I directed and reviewed step
by step. I chose the Go backend, decided against vendoring Go modules, and ran the
reduced-motion browser check myself. Everything was verified by running it: the
tests, the checker, and a browser session against the running server (crash and
reconnect, refresh mid-round, replay, keyboard, phone width).

# Beacon Relay — notes

## Run and requirements
`node submission/start.mjs` builds the Go service when its sources changed, supervises it and
starts the gateway. Needs **Go 1.26** and **Node ≥ 22.18** (the gateway serves the TypeScript
client via `module.stripTypeScriptTypes`; tests import `.ts` directly). Tested on Node 24 /
Go 1.26; Node 24 prints one ExperimentalWarning for type stripping. Go modules are vendored
(`service-go/vendor`), so the build needs no network (~6 s cold). Bindings in
`service-go/roundspb` are generated from the unchanged contract (`go generate`) and committed,
so there is no codegen step.
`GO_SERVICE=external` runs the service separately (debugger). `node submission/test.mjs` runs
`go test` and the Node tests; locally Go 3/3, Node 17/17, checker 9/9, fixtures 4/4.

## Architecture and state owner
- Two processes on 127.0.0.1: the Go **RoundService** (gRPC) and the Node **gateway**
  (HTTP + WebSocket), which reaches it only through a gRPC client. The launcher validates the
  environment, opens HTTP only after gRPC Health answers, forwards SIGINT/SIGTERM (SIGKILL after
  3 s) and exits 1 with the reason if the service fails or dies; a killed launcher closes the
  service's stdin, and the service exits.
- **The Go `Store` is the only state owner**, enforced by an exclusive OS lock on
  `DATA_DIR/lock`: a second service on the same directory fails rather than write at its own
  offset (a restart waits up to 5 s for its predecessor). The port is bound before DATA_DIR is
  touched.
- `DATA_DIR/events.jsonl` is the source of truth: one immutable snapshot per line, **fsynced
  before memory changes and before any reply**. Startup replays it, cuts a torn final line and
  refuses to start on any other corrupt line.

## Duplicates, completion and crashes
- One mutex serializes commands. StartRound resolves `requestId` first (same payload → the
  original round, even completed; changed payload → 409 IDEMPOTENCY_CONFLICT), then allows one
  pending round per player (409 ROUND_IN_PROGRESS). 20 concurrent duplicates make one round.
- The service completes rounds itself: a timer at `createdAt + ROUND_DELAY_MS` completes a round
  only while it is still accepted, so exactly once (re-armed if early, append retried on
  failure). After a restart pending rounds are rescheduled from the stored `createdAt`; overdue
  ones complete at once. Durability covers process kill, not power loss.
- `choice` and `next_cursor` aren't `optional`, so protobuf-go omits 0 and the supplied loader
  would drop `choice` for beacon 0; the service writes explicit zeros (`wire.go`).

## Gateway gRPC deadlines
Each call has a `GRPC_TIMEOUT_MS` deadline (300 ms). DEADLINE_EXCEEDED/UNAVAILABLE mean an
unknown outcome, so the gateway retries the same payload (3 attempts, safe because StartRound is
idempotent and the rest are reads), then returns 504/503 after ~1.1 s at worst. The browser
treats those and network errors as unknown and keeps retrying the same requestId. Input is
validated before any RPC (8 KiB body cap, exact keys, media type) and again in gRPC.

## WebSocket replay and backpressure
- While clients are connected, one poller calls ListEvents every 50 ms and caches a contiguous
  tail (≤ 1000 events). Each socket keeps its own cursor and only sends `cursor + 1`, so backfill
  and live delivery are one loop with no boundary to race: no gaps or repeats.
- Above 64 KiB buffered a socket gets nothing more until it drains; 30 s there, or 256 KiB,
  closes it with 1013 and destroys it 1 s later. A ping every 25 s; no pong by the next tick →
  terminated (≤ 50 s), or 1013 if its output is backed up. Frames ≤ 4096 bytes (1009), no
  compression, client frames ignored, bad cursor → 1008. Timers and listeners stop on close.

## Client state and timeline
- `RoundState` (no DOM, unit-tested): idle → submitting → pending → completed. The requestId
  belongs to the intent: made before Play, rotated only by New Round, a rejection or a server
  reset, so double clicks, retries and refreshes reuse it. Only event `cursor + 1` is applied;
  the score sums this player's unique completed rounds, so redelivery and replay can't add.
- `Game` retries unknown submits (0.5 s doubling to 8 s) and reconciles on each reconnect;
  `EventFeed` resumes from the last applied cursor and treats a gap as a reconnect. Player,
  cursor and score are in localStorage; this tab's intent and round in sessionStorage, so a
  refresh resumes it and tabs don't overwrite each other.
- `Presentation` is the single timeline: drop into the pulse (1.1 s) → visibly waiting for the
  server → flight to the target (0.9 s) → crown, plus a shake on a miss → reveal; the point
  appears at the reveal. Pause and Skip act only on the timeline (Skip waits for a pending
  result). Replay re-runs it with the recorded target and sends nothing. Reduced motion: steps
  fade in place instead of moving. Every control is implemented.
- **Rendering: DOM + Web Animations.** Beacons are real buttons (labels, keyboard, focus).
  Animations are time-based, so frame-rate independent; pause/finish/cancel map onto the
  controls; there is no rAF loop to duplicate in a background tab. The layout is
  percentage-based, so resizing and high-DPI need no canvas handling.

## Tradeoff
The gateway polls ListEvents because the frozen contract has no streaming RPC: up to 50 ms extra
latency and ~20 RPC/s while clients are connected, in exchange for a stateless gateway where
backfill and live delivery share one code path. Likewise one store mutex is held across fsync,
so reads wait for the disk: simpler, and harmless at this scale.

## Gaps
- Resizing the window mid-animation can misplace the pulse until that 1–2 s step ends.
- A new tab doesn't pick up a round started in a closed tab (it still completes and counts).
- History stays in memory (as specified); a fresh gateway reads all of it on its first poll.
- No Go tests for torn or corrupt log replay (checked by hand); no unit tests for `Game` or
  `EventFeed`.
- Harness issues (also in the PR): the checker deletes its temporary GOPATH, which fails on Go's
  read-only module cache (hence `-modcacherw`, now moot with vendoring); and `defaults:false` forces a non-Node service to
  send explicit zeros.

## Time and AI use
- Actual time: TODO(you)
- AI/tools: TODO(you: your own use while building it). Claude Code (Claude Opus 5.5) reviewed
  the submission against the brief, added the DATA_DIR lock, the reduced-motion fades and the
  follow-up fixes (slow-consumer close, keyboard focus, per-tab storage, batched saves, config
  validation) with tests, and drafted these notes and DEMO.md; every change was run against the
  test suite, the checker and the fixtures. TODO(you: what you verified yourself).

# Notes

## Architecture and who owns state

- One process, two listeners, same as the starter: gRPC service + HTTP/WS gateway.
- The gRPC service (`service.mjs`) is the **only** owner of state. The gateway
  keeps nothing — every HTTP call and every WS frame goes through a real local
  gRPC client. That's also why HTTP and gRPC agree on duplicates: both paths
  land in the same `startRound` handler.
- All durable state is one file: `DATA_DIR/events.jsonl`, append-only, one JSON
  event per line. Each line stores a full snapshot of the round *at that
  moment*, so accepted events never "grow" a target later.
- On startup I just replay the file and rebuild the in-memory maps (rounds,
  requestIds, pending-per-player, last sequence). No separate snapshot files,
  no second source of truth to drift.

## Crashes and duplicates

- I only reply 202 (or the gRPC equivalent) **after** the accepted event is
  written. So if the process dies, anything the client ever saw is on disk.
- A SIGKILL can tear the last line of the file. That line was never
  acknowledged, so recovery truncates it off the file before reopening for
  append (otherwise the next event would be glued onto the fragment and brick
  the following restart) — the client's retry recreates the round with the
  same requestId.
- Completions can't happen twice: a round is "completed" only if a completed
  event exists in the log. Recovery only re-arms timers for rounds whose latest
  event is still `accepted`. Overdue ones fire immediately on startup.
- Duplicates: the requestId is reserved *synchronously* (before any await),
  with a fingerprint of playerId+choice. Twenty concurrent duplicates — mixed
  HTTP and gRPC — all wait on the same write and get the same round. Same
  requestId with a different payload is a 409 conflict, even after the round
  completed.
- Order matters: I resolve the requestId first, *then* check if the player is
  busy — so retrying your own pending round never gets blocked by yourself.
- Completion runs on a real timer, never "when someone asks". I add ~25 ms of
  margin because ISO timestamps truncate to milliseconds and I don't want
  `completedAt − createdAt` to come out one millisecond short of the delay.

## Gateway gRPC deadlines

- Every call uses the supplied helper with the `GRPC_TIMEOUT_MS` deadline
  (300 ms default). Timeout → 504 `UPSTREAM_TIMEOUT`, service down → 503
  `UPSTREAM_UNAVAILABLE`.
- Both mean "unknown outcome", not "failed" — so the client retries the **same**
  requestId instead of starting a second round.
- One small fix on the starter: the proto loader drops zero-valued fields on
  the wire, so an empty events page would lose its `nextCursor: 0`. The gateway
  puts it back.

## WebSocket replay and backpressure

- Each connection runs a simple loop: page `ListEvents` after the client's
  cursor until caught up, then keep polling (~120 ms). One monotonic cursor per
  connection means no gaps, no duplicate sequences, and no race between
  backfill and live — the race can't exist in this design.
- Bounds: incoming frames over 4096 → close 1009, bad cursor → 1008, more than
  256 KiB queued on a slow consumer → 1013 (checked before every send,
  counting the frame about to be queued).
- Heartbeat: ping every 20 s, terminate on a missed pong — worst case 40 s,
  inside the 60 s requirement. No ping is sent while a socket is closing. Timers and listeners are cleaned up on close.

## Client state and timeline

- `client/state.mjs` is a pure state machine (no DOM, no network — that's what
  the unit tests drive): idle → pending → animating → revealed. Only server
  events move it forward; the animation never invents a result.
- Events apply only if their sequence is above the last applied cursor.
  Score = server-scored points from a persisted Set of completed roundIds, so
  redelivery, replay and refresh can never double-count.
- Intent (requestId, choice, roundId), cursor and score live in localStorage.
  On refresh I re-ask the server what happened (GET the round, or re-POST the
  same requestId — it's idempotent, and unknown outcomes retry it with the
  same 0.5 s → 8 s capped backoff until resolved). Reconnects back off 0.5 s → 8 s and resume
  from the last applied cursor. Stale replies for an older requestId get
  dropped.
- `client/timeline.mjs` is one requestAnimationFrame loop, driven by elapsed
  time, so it's frame-rate independent and a background tab just fast-forwards
  to the right final state. Pause freezes presentation only — the server keeps
  going. Skip jumps to the recorded result. Replay replays it with no request,
  no event, no score change. Reduced motion gets a short fade with the same
  outcome.
- Renderer: plain DOM + CSS transforms for everything interactive. Three
  buttons and one orb don't need Canvas/WebGL, and DOM gives me HiDPI, resize,
  keyboard focus and reduced-motion basically for free. The only canvas is a
  purely decorative flickering-grid backdrop (`fx.mjs`) — pointer-events off,
  paused with the game, static under reduced motion. Poppins is self-hosted under
  `client/fonts/` and the favicon is served by the gateway — zero network
  dependencies at runtime.

## One tradeoff

The WS feed polls gRPC per connection instead of using in-process pub/sub.
I chose it because the stream layer only has the gateway's gRPC client (which
keeps the gateway honestly decoupled), and because a single cursor loop makes
the replay/live race unrepresentable. The cost is up to ~120 ms extra latency
and O(connections) polling — fine at this workload, would need a push path at
real fan-out.

## Tests and gaps (honest)

- Tests (30, `node submission/test.mjs`): crash/SIGKILL recovery, torn-log
  repair, 20 concurrent duplicates, player guard and 10 parallel players,
  exact HTTP/gRPC contract edges, WebSocket paging/reconnect/outage, client
  state machine and timeline (including frame-rate independence). The browser
  checklist is a separate, optional harness (`submission/browser/`, own
  lockfile): 12/12 in Chrome and Firefox, see DEMO.md.
- Heartbeat termination, the 1013 slow-consumer close and the gateway
  deadline (504 → retry → one round) are covered in `tests/realtime.test.mjs`
  with a shortened heartbeat interval; the production 20 s interval itself is
  reviewed in code.
- Not tested: Safari, physical devices, screen readers.
- If a second session makes the same player busy, the client abandons its local
  intent with a message and lets the feed credit that round when it completes.

## Actual time

About 2 working hours (cap is 8), covering reading and planning;
the service, gateway fix and WebSocket feed; the client state machine,
reconnect and animation; tests plus the end-to-end browser pass (which caught
a miss-scoring bug my unit fixtures had missed — fixed, with a regression
test); a UI redesign; and these notes and the demo evidence.

## AI / tool use

I used Claude Code (Anthropic) heavily — it wrote most of the code and tests
under my direction, phase by phase, and ran the verification each time: the
supplied checker and fixtures, SIGKILL recovery drills, and the scripted
Chrome playthrough behind the `evidence/` screenshots. I set the scope,
reviewed the changes, directed the redesign, and validated by playing the
game. Everything reported here ran locally on my machine, and I'm happy to
explain or modify any part of this code in the walkthrough.

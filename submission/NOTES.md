# Beacon Relay — engineering notes

## Run and verify

Node.js 22+; no secrets, external services, code generation, or additional runtime dependencies.

```sh
npm ci --ignore-scripts
node submission/start.mjs
node submission/test.mjs
node --test fixtures/contract.test.mjs
node scripts/check.mjs
```

Open http://127.0.0.1:4400. The launcher's PORT, GRPC_PORT, DATA_DIR,
ROUND_DELAY_MS and GRPC_TIMEOUT_MS follow the brief. Both TCP listeners bind to
127.0.0.1. Startup errors release resources and exit unsuccessfully.

This workstation supplies an HTTP proxy that also affects the supplied checker's
own gRPC client. For the fixture/checker commands in PowerShell, first set
`$env:NO_GRPC_PROXY = '127.0.0.1,localhost'` (POSIX: `export no_grpc_proxy=127.0.0.1,localhost`).
The launcher and candidate test runner already bypass loopback. Supplied tooling
was not changed. This is an environment prerequisite, not a weakened check.

## Ownership, durability, and duplicates

`service.mjs` alone owns state. HTTP/WebSocket use real local gRPC. Synchronous
mutations write DATA_DIR/state.next and rename it over state.json before updating
visible memory or returning success. Rename is the commit point. Recovery ignores
unfinished replacements and validates/indexes committed history. This targets
process crashes, not power-loss durability.

Events are immutable and globally consecutive. Request deduplication precedes the
player guard: same payload returns the original; changed payload conflicts.
Stored deadlines survive configuration changes. One scheduler completes pending
rounds autonomously, including overdue recovery; completed rounds are never
rescheduled. A PID guard deters accidental second owners and reclaims dead-owner
locks; it is not distributed fencing. Run one launcher per DATA_DIR. PID reuse or
a damaged lock fails conservatively and requires ownership inspection.

## Transport and recovery

HTTP enforces JSON shape, the 8192-byte limit, routes, and error codes. gRPC
validates inputs, including omitted choice=0 and limit=0 defaults. Gateway calls
have finite deadlines (default 300 ms). Timeout/unavailability leaves acceptance
uncertain; retries retain the same request ID.

Each WebSocket uses one sequential ListEvents loop: 100-event catch-up pages,
75 ms live polling, 250 ms upstream-error retries. One cursor avoids a replay/live
handoff race. Compression is disabled; incoming frames ≤4096 bytes and output
≤256 KiB including frame overhead (1013). Ping every 20 seconds; missed pong
terminates at the next tick, approximately 40 seconds after connection. Close
clears polling/heartbeat resources; outstanding RPCs have bounded deadlines.

## Client and presentation

`model.mjs` separates server facts from presentation. One localStorage snapshot
saves player, intent, round, global cursor, and unique-round score ledger.
Duplicates are ignored; gaps reconnect from the last applied cursor. HTTP
reconciliation and bounded retries recover pending work without fresh intent.
Stale replies cannot replace newer work or downgrade completion. Another tab's
pending round can be recovered from server history.

DOM/SVG gives accessible controls and crisp geometry. One RAF owner drives eased
2400 ms travel after completion. Pause/Skip affect presentation; early Skip waits.
Replay reuses the result without StartRound or scoring changes. Hidden tabs stop
presentation/reset frame timing on resume. Refresh restores completed results;
reduced motion uses 180 ms travel.

## Tradeoff, coverage, and disclosure

Whole-history replacement and per-socket polling favor correctness at the stated
workload over scalability. All controls are implemented. [DEMO.md](DEMO.md) records
checks and limits: Safari, physical devices, actual OS suspension, and subjective
human smoothness remain untested.

AI use: ChatGPT implemented/reviewed code drafting, debugging, and notes. Node tests and
Playwright exercised real interfaces/browsers; Prettier formatted source. Assets
are synthetic DOM/SVG. [WORKLOG.md](WORKLOG.md) records the assigned local commit
schedule separately from measured session time and unknown candidate time.
Candidate review/understanding remains required. Work
stays local: no fork, push, PR, or deployment.

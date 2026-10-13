# Beacon Relay

Choose beacon **0, 1 or 2** and press Play. The backend accepts a round, then completes
it after ROUND_DELAY_MS. Animate an energy pulse and reveal the server result.
A matching choice earns one demo point; otherwise zero. No money/accounts are involved.

Implement [the contract](docs/API.md) and [the animation brief](docs/ANIMATION.md).
The target is SHA-256(roundId UTF-8)[0] modulo 3. This intentionally public toy rule
makes results reproducible; production randomness/fairness is outside the exercise.

## Backend requirements

1. Implement **RoundService gRPC** from `contracts/rounds.proto`. The HTTP/WebSocket
   gateway calls the service through an actual local gRPC client. A direct function
   call with a decorative schema is insufficient.
2. Persist acceptance before success. Complete accepted rounds without a browser,
   polling request or animation acknowledgement. Store immutable accepted/completed
   snapshots in ordered durable events.
3. Deduplicate requestId: same payload returns the original round; changed payload
   conflicts. Concurrent duplicates create one round. Allow one pending round per
   player; different players can proceed independently.
4. Recover after abrupt process termination with the same DATA_DIR. Preserve IDs,
   timestamps, outcomes/event order. Pending rounds finish; completed rounds do not
   complete again. Use a single durable state owner.
5. Expose HTTP controls/snapshots and an ordered **WebSocket** feed. Backfill after a
   cursor then continue live without gaps or repeated sequence numbers. Disconnects
   and restarts must not strand rounds or change results.
6. Validate HTTP/gRPC inputs. Apply a finite gateway gRPC deadline. A timeout is an
   unknown outcome: retry the same requestId rather than starting another round.
   Bound bodies, WebSocket frames/queued output; clean up timers/listeners on close.

## Client requirements

- Selection, Play, pending/animating/revealed states, Pause/Resume, Skip, Replay and
  New Round. Explain any unfinished control.
- Replay the recorded result with **no new StartRound request**, score update or
  completion event. Pause/Skip affect presentation only.
- Guard double clicks, late replies and stale events. Retain current intent, player,
  round and last applied cursor across refresh. Reconnect with bounded backoff and
  reconcile the current round.
- Show connection status and score based on unique completed rounds for that player.
  Redelivery/replay must not increment it. A visual reset cannot erase server history.
- Follow the animation brief. Supplied shapes or your own synthetic assets are enough.

## Tests and scope

Add tests catching duplicate completion, reconnect gaps and state-transition errors.
Include one meaningful client state/timeline test and one crash/concurrency test.
Leave supplied contracts/tooling/workflow unchanged; report harness defects in the PR.

One authoritative service and one gateway suffice. They may share an OS process with
separate listeners, as in the starter. Local file storage is enough; process termination,
not power-loss durability, is tested. Workload: 20 duplicates and 10 distinct players.
No cloud deployment, payments, authentication, distributed locking, extra microservices
or load test is required. Keep the one-day timebox.

## Runtime

`node submission/start.mjs` starts everything from the root and stays alive. Go
launchers must forward shutdown and report startup failures. All service state lives
in DATA_DIR. Bind both listeners to 127.0.0.1.

- PORT: HTTP/WebSocket port, default **4400**.
- GRPC_PORT: round-service port, default **4402**.
- DATA_DIR: persistent directory, default **./data/service**.
- ROUND_DELAY_MS: time from acceptance to eligibility for completion, default **1200**.
- GRPC_TIMEOUT_MS: gateway call deadline, default **300** milliseconds.

The checker allows 60 seconds for cold startup. No completion before the configured
delay; finish within 2 seconds after it on this small workload. Overdue pending rounds
complete when service recovers. Timelines do not change this server deadline.

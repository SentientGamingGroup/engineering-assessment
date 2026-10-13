# Contract — synthetic Beacon Relay

gRPC owns rounds/events; HTTP/WebSocket are gateway interfaces over the same state.
`contracts/rounds.proto` defines the wire schema. The supplied loader uses camelCase
fields, numeric uint32 and **no default fields**. Never expose a pending target/score.

## Round and events

Accepted Round (exact public fields):

```json
{"roundId":"opaque-id","requestId":"intent_1","playerId":"player_1","choice":0,"status":"accepted","createdAt":"2026-01-01T00:00:00.000Z"}
```

Completed Round retains immutable fields and adds status=completed, target (0–2),
score (0 or 1), completedAt (ISO UTC). Round IDs match [A-Za-z0-9_-]{1,128}.
Synthetic target = SHA-256(roundId UTF-8)[0] modulo 3. Score=1 exactly when choice=target.
IDs, timestamps and target stay stable across retries/restarts.

Event: {sequence, type, round}. Sequence starts at 1, increases by one globally.
Types: round.accepted, round.completed. Round is an immutable snapshot **at the event**.
Exactly one accepted and one completed event per finished round, in that order.
Retain this small exercise's entire history; production retention is out of scope.

## HTTP

- GET /health → 200 {"ok":true} only when both listeners are ready.
- GET / → playable client; local assets can be served under /client/.
- POST /rounds → 202 Round (also on same-request replay of a completed round).
  JSON must contain exactly requestId, playerId, choice. IDs match
  [A-Za-z0-9_-]{1,64}; choice is an integer 0–2. Object order is irrelevant.
  Require application/json (charset allowed); body ≤8192 bytes.
- GET /rounds/:roundId → 200 Round; unknown ID → 404 ROUND_NOT_FOUND.
- GET /events?after=0&limit=100 → 200 {"events":[],"nextCursor":0}.
  Up to limit events strictly after after, ordered. nextCursor is the last returned
  sequence, or supplied after when empty. after integer 0–4294967295; limit integer
  1–100. Defaults: after=0, limit=100.

Errors: {"error":{"code":"..."}}. Codes/statuses:
400 INVALID_REQUEST; 400 INVALID_CURSOR; 409 IDEMPOTENCY_CONFLICT;
409 ROUND_IN_PROGRESS; 413 BODY_TOO_LARGE; 415 UNSUPPORTED_MEDIA_TYPE;
404 NOT_FOUND for unknown routes; 405 METHOD_NOT_ALLOWED for a wrong method on a
known route. Invalid input creates no state. Resolve requestId duplicates before
checking player activity.

gRPC DEADLINE_EXCEEDED → 504 UPSTREAM_TIMEOUT; UNAVAILABLE → 503 UPSTREAM_UNAVAILABLE.
These do not mean a round was rejected or completed.

## gRPC

Implement Health, StartRound, GetRound, ListEvents with the same rules as HTTP.
Helpers provide wire bindings/client/deadlines; domain behavior is your work.
The browser uses HTTP/WebSocket; native gRPC is between gateway and service.

Application errors use exact status/details:
- INVALID_ARGUMENT (3): INVALID_REQUEST or INVALID_CURSOR.
- NOT_FOUND (5): ROUND_NOT_FOUND.
- ALREADY_EXISTS (6): IDEMPOTENCY_CONFLICT.
- FAILED_PRECONDITION (9): ROUND_IN_PROGRESS.

An omitted direct-gRPC choice is protobuf's default **0** (valid); HTTP JSON still
requires choice. Both string IDs are required. A gRPC limit=0 means omitted/default
100; limit>100 fails. Wire uint32 bounds after; HTTP limit=0 remains invalid.
Health returns {"ok":true}. Ignore client-supplied outcome fields; never trust them.

References: [official Node gRPC guide](https://grpc.io/docs/languages/node/basics/),
[deadlines](https://grpc.io/docs/guides/deadlines/) and
[status codes](https://grpc.io/docs/guides/status-codes/).

## WebSocket

Connect ws://127.0.0.1:PORT/stream?after=N (default 0). Malformed cursor → close **1008**.
After upgrade, send all events after N then live events exactly once per connection,
in increasing sequence order:

```json
{"type":"event","event":{"sequence":1,"type":"round.accepted","round":{"roundId":"...","requestId":"...","playerId":"...","choice":0,"status":"accepted","createdAt":"..."}}}
```

No ready frame is required. A replay/live race must not miss new events. Reconnect
with the **last applied** cursor; defensively ignore already applied events.
Client WebSocket messages are not commands. Incoming frames ≤**4096 bytes**
(oversize → 1009), compression disabled, queued output ≤**256 KiB**
(slow consumer → 1013). Ping/pong must stop an unresponsive peer within 60 seconds.
Clean up timers/listeners on close; document heartbeat/queue behavior. The checker
tests protocol behavior; slow-peer/lifecycle handling is also reviewed in code.

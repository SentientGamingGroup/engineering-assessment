# Beacon Relay — Engineering Notes

## Architecture and state ownership

The application uses Node.js for both the authoritative round service
and the HTTP/WebSocket gateway, with separate gRPC and HTTP listeners.

`service.mjs` is the single owner of round state. The browser never
chooses the official target or score. The gateway calls the service
through the supplied gRPC client.

The client is built with HTML, CSS and JavaScript. SVG or external
game assets are not required; the scene uses CSS shapes and a
requestAnimationFrame-driven energy pulse.

## Persistence and duplicate handling

Round history is stored in an append-only JSON Lines event log under
`DATA_DIR`. The service replays this log during startup to rebuild its
round index, request index, pending-player index and event sequence.

The accepted event is written before a successful response is returned.
Completion records the server-derived target, score and completion time
in a separate event. Accepted and completed snapshots are immutable.

State-changing service operations are serialized through a promise
queue. Repeated request IDs with identical payloads return the original
round. Reusing an ID with a different player or choice returns a
conflict. A player can have only one unfinished round at a time.

After restart, unfinished rounds are rescheduled and completed rounds
are not completed again. The implementation targets abrupt process
termination, not power-loss durability or multiple service processes.

## Gateway and gRPC deadlines

The HTTP gateway uses the supplied gRPC helper and applies the
`GRPC_TIMEOUT_MS` deadline (300 ms by default). Deadline expiry is
reported as an upstream timeout. The client retries an uncertain
request with the same request ID rather than creating a new intent.

HTTP and gRPC inputs are validated, and gateway errors are mapped to
the contract's HTTP status and error codes.

## WebSocket replay and resource limits

The WebSocket gateway polls the gRPC event history and delivers events
in sequence order. A connection supplies an `after` cursor to replay
missed events before continuing with live updates.

Incoming frames are limited to 4096 bytes, compression is disabled,
and queued outgoing data is bounded at 256 KiB. The gateway uses
ping/pong heartbeats and cleans up connection timers and listeners.

The client persists its last applied cursor and ignores duplicate
events. After reconnecting, it catches up through the HTTP event
endpoint and reconciles the current round with the server.

## Client state and animation lifecycle

The client maintains idle, pending, animating and revealed states.
It saves the player, request intent, current round and cursor in
local storage.

The pulse animation is presentation only. The target is revealed only
after a completed server result is available. Pause and Skip do not
change the server round. Replay uses the existing completed result
without creating a new round. The score counts unique completed
rounds for the current player.

The animation uses requestAnimationFrame and frame-time deltas, caps
large frame deltas, pauses presentation while the page is hidden, and
supports reduced-motion preferences.

## Tradeoff and known gaps

JSON Lines persistence and a single-process state owner keep this
exercise focused and recoverable without external infrastructure.
WebSocket polling was chosen over a separate event broker because the
workload is small and the existing gRPC ListEvents API supports replay.

The two candidate tests cover animation timeline behavior and
concurrent duplicate requests with recovery after forced termination.
The supplied acceptance checker also passes all nine groups.

**Testing gaps:** Mobile behavior was tested using Chrome DevTools emulation rather than a physical device. Keyboard-only operation and reduced-motion behavior were tested in Chrome DevTools, and Firefox was tested locally. Safari was not tested because it was unavailable in my Windows environment.

## AI and Development Tools

ChatGPT was used for implementation guidance, code drafting, debugging assistance, and test scaffolding. I integrated the suggested changes into the starter project, ran the application locally, and verified the implementation using the candidate tests and supplied acceptance checker. I am prepared to explain the architecture, key implementation decisions, limitations, and test results during the technical walkthrough.

**Actual working time:** Approximately 1 hour.

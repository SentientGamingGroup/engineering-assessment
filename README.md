# Sentient Gaming Group — Senior engineering assessment

Build **Beacon Relay**, a fictional browser mini-game with animated play, a
WebSocket event feed and an authoritative gRPC round service. Choose one of three
beacons and reveal which beacon the server selected. A match earns one demo point.
This exercise and its assets were created for recruitment; all rules/data are synthetic.

We assess senior ownership across presentation, interaction and backend behavior:
smooth transitions, correct controls, duplicate requests, reconnects and recovery.

## One-day timebox

- Deliver within **24 hours of the agreed start**, with **at most 8 working hours**
  including reading, implementation, tests and notes. Stop and document gaps.
- This is an **unpaid coding assessment** as part of the interview process.
  No payment is provided for completing it. Agree the exact start time and
  submission deadline with the recruiter before starting.
- Suggested budget: 30 minutes reading; 3 hours service/persistence; 1.5 hours
  gateway/WebSockets; 2 hours client/animation; 1 hour tests/notes.
- Frontend: JavaScript or TypeScript, renderer of your choice. Backend: Node.js or Go.
  The starter uses Node.js. Go candidates may retain the Node gateway and implement
  the gRPC service in Go. No framework is required.
- Node.js **22+** is required for tooling. CI supplies Node.js 24 and Go 1.26.

Read [ASSIGNMENT.md](ASSIGNMENT.md), [the contract](docs/API.md),
[the animation brief](docs/ANIMATION.md) and [SUBMISSION.md](SUBMISSION.md).

## Starter and commands

```sh
npm ci --ignore-scripts
node --test fixtures/contract.test.mjs
node submission/start.mjs
```

Open **http://127.0.0.1:4400**. The starter serves a simple stage, opens a WebSocket
and starts a real gRPC service on port 4402. Assignment methods deliberately
return UNIMPLEMENTED; controls and animation are unfinished.

```sh
node submission/test.mjs
node scripts/check.mjs
```

The full acceptance checker **must fail on the untouched starter**. It uses temporary
ports/storage and checks the actual HTTP, WebSocket and gRPC interfaces.
`node scripts/check.mjs --starter` checks scaffolding only. Supplied dependencies
are locked; install scripts are unnecessary. Put additional dependencies/lockfiles
under `submission/` and document installation.

## Assessment, 100 points

- **Backend correctness/recovery — 30:** authoritative results, durable state,
  idempotency, concurrency, crash recovery and valid gRPC behavior.
- **Realtime behavior — 25:** genuine WebSocket delivery, ordered replay, reconnects,
  gRPC boundary/deadlines and bounded connection resources.
- **Animation/game functions — 25:** complete transitions, responsive stage, working
  controls, result synchronization, replay and reduced motion.
- **Meaningful tests — 10:** failure, concurrency, restart and client state tests.
- **Engineering judgment — 10:** clear ownership, focused code, tradeoffs and notes.

Core backend/reconnect failures prevent a strong pass even with impressive visuals.
Animation quality is assessed by playing the submission; automated checks alone
are insufficient. Extra infrastructure earns no points. AI tools are allowed:
disclose use and be ready to explain/modify your work in a 20–30 minute walkthrough.

## Submission

Fork this repository, create `assessment/<your-handle>`, and open a PR into
**SentientGamingGroup/engineering-assessment:main**. No other Sentient access is needed.
Public forks/PRs are visible; submit your own solution. Candidate implementations
will remain open for review, will not be merged into the starter and will not be
used as production deliverables.

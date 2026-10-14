# Beacon Relay — demo evidence

> **TODO(you) before submitting:** fill in every `TODO` from real browser runs. Results are
> only claimed once filled in.

## Recording

**Screen recording (MP4, 2.4 MB):** attached to the pull request description, where it plays
inline at full quality.

Shot list, in order (about 2–3 minutes):
1. Desktop 1280×720: select a beacon, Play, a match (crown on your beacon, +1) and a miss
   (crown on the target, your beacon shakes, no point).
2. Pause during the drop, Resume; Skip before the result arrives; Replay.
3. Refresh during a round: the same round comes back and reveals the same result.
4. Connection loss: stop the server mid-animation, show "Disconnected — reconnecting", restart.
5. Keyboard-only round with the focus ring visible.
6. Reduced motion: Play and Replay fade in place, nothing travels.
7. Mobile 390×844: one full round.

## Environment

| | |
|---|---|
| Browser(s) and version | TODO |
| OS / device | TODO |
| Date | TODO |
| Not available | TODO (e.g. Safari: no macOS device) |

Setup: `node submission/start.mjs`, open http://127.0.0.1:4400. To make the waiting phase
easy to see, start with `ROUND_DELAY_MS=4000`. For connection loss stop the server (Ctrl+C,
or `kill -9` for an abrupt stop) and start it again with the same `DATA_DIR`.

## Manual results

| # | Case | Steps | Expected | Result |
|---|---|---|---|---|
| 1 | Desktop 1280×720 | DevTools device toolbar, Responsive 1280×720. Play a match and a miss. | Nothing clipped (beacons, rings, crown). Drop → wait → flight → crown; the animation itself is about 2.7 s and overlaps the server delay. Text names your choice, the target and the point. | TODO |
| 2 | Mobile 390×844 | Device toolbar at 390×844 (or a phone). One round. | Nothing clipped, controls wrap, no horizontal scroll. | TODO |
| 3 | Keyboard only | Tab to a beacon, Enter/Space; Tab to Play, Enter; continue with the keyboard. | Visible focus ring. After Play focus is on Pause, after the reveal on New Round; New Round returns focus to Play. | TODO |
| 4 | Reduced motion | DevTools → Rendering → Emulate `prefers-reduced-motion: reduce` (or the OS setting). Play, then Replay. | Nothing travels, scales or shakes; pulse and crown fade in place. Same result, text and score. Replay visibly runs (~1 s). | TODO |
| 5 | Rapid clicks | Click Play many times quickly; click beacons during the round. | One round. Any repeated POST in the Network tab carries the same `requestId`. Beacons are disabled during the round. | TODO |
| 6 | Pause / Resume / Skip | With `ROUND_DELAY_MS=4000`: Pause during the drop, wait past the delay, Resume. Next round: Skip before the result. | Pause freezes the scene and says the server keeps going; the result is shown only after Resume. Skip says it will show the result as soon as it arrives, then reveals at once. The score never changes from Pause or Skip. | TODO |
| 7 | Replay | After a result, Replay twice. | Same target; text starts "Replay:"; no request in the Network tab; score unchanged. | TODO |
| 8 | Refresh during a round | Play, refresh during the drop or the wait. | Comes back on the same round (any POST reuses the same `requestId`), reveals the same result, scores it once. | TODO |
| 9 | Connection loss during animation | Play, stop the server during the drop, restart it after a few seconds. | Header shows "Disconnected — reconnecting in Ns"; the pulse keeps waiting and no result is invented. After restart it reconnects, the round completes (overdue → at once) and reveals; at most one point. | TODO |
| 10 | Two tabs (optional) | Play in tab A, open tab B. | B starts idle with the same score; Play in B while A's round is pending shows the "round in progress" notice. | TODO |

## Untested

- TODO(you): browsers, devices or cases you could not run.
- Screen readers were not tested.
- TODO(you): say whether high-DPI and mobile were checked on real devices or only emulated.

## Automated checks (not a substitute for the runs above)

- `node submission/test.mjs` (Go 3/3, Node 17/17), `node scripts/check.mjs` (9/9) and
  `node --test fixtures/contract.test.mjs` (4/4) pass locally.
- The client code was also run headlessly in jsdom against a live server, with animations
  stubbed (not committed). It covered keyboard focus moves, per-tab storage, a reduced-motion
  replay that moves nothing but lasts ~1 s, batched saves, refresh mid-round and a new tab.
  jsdom has no layout or rendering, hence the manual runs.

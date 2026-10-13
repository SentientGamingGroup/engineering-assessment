# DEMO — manual evidence

App under test: `node submission/start.mjs` → http://127.0.0.1:4400
Automated baseline at the time of this pass: `scripts/check.mjs` 9/9
groups, `submission/test.mjs` 30/30, fixtures 4/4.

**How this pass was run (disclosure):** the checklist below was played by a
scripted Playwright session (driven by Claude Code) against a real server
process with default settings (`ROUND_DELAY_MS=1200`), once in Chrome and once
in Firefox. The script kills and restarts that process for the connection-loss
case, and checks every result against server truth (`/events`), not just the
DOM. Both browsers: **12/12**. The harness is committed so you can rerun it:

```sh
npm ci --prefix submission/browser --ignore-scripts      # optional, evidence only
node submission/browser/pass.mjs                         # installed Google Chrome
npx --prefix submission/browser playwright-core install firefox
BROWSER=firefox node submission/browser/pass.mjs         # Playwright Firefox
```

It exits non-zero on any failure and prints where it saved its screenshots.
The game itself needs only the root `npm ci`.

## Environment

| | |
|---|---|
| Primary browser | Google Chrome 155.0.8059.40 (headless, via Playwright `channel: 'chrome'`), macOS 26 |
| Secondary browser | Firefox 130.0 (Playwright build, headless): 12/12 |
| Desktop viewport | 1280×720 at devicePixelRatio 2 (Retina) |
| Mobile viewport | 390×844, devicePixelRatio 3, touch (+ mobile emulation in Chrome) |

## Manual checklist (ANIMATION.md evidence list)

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Happy path, desktop 1280×720 | Charge loop while pending, eased travel, distinct match/miss, textual result, score +1 only on match | ✅ Pending ~35 ms after click; pulse position changes frame to frame; presentation 2.2 s (2211 ms) after completion; lit target, outcome and score equal the server's round. |
| 2 | Mobile 390×844 | Stage not clipped, beacons reachable, same sequence | ✅ No horizontal scroll; stage, beacons and controls inside the viewport and stage; tap-to-play; same sequence (screenshots 11 and 14). |
| 3 | Keyboard-only play | Full round via Tab/Enter, visible focus | ✅ Tab reaches beacon 03, focus ring visible, Enter selects (`aria-pressed=true`), Tab → Play → Enter plays a round with choice 2; reveal matches the server. |
| 4 | Reduced motion | Minimal motion, same outcome and score | ✅ `prefers-reduced-motion: reduce`: presentation ~306 ms instead of ~2.2 s, with no charge loop; same server outcome and score. |
| 5 | Rapid clicks | One round only; selection locked while pending | ✅ 20 synchronous Play clicks → 1 `POST /rounds`, 1 requestId, 1 `round.accepted` event; clicks on another beacon mid-round ignored. |
| 6 | Pause / Resume | Frozen in place, resumes, outcome unchanged | ✅ Paused 3.5 s (longer than the whole 2.2 s run): pulse transform unchanged, still animating, button reads "Resume"; Resume finishes with the server outcome. |
| 7 | Skip | Immediate reveal; while pending waits, never invents | ✅ Skip mid-travel revealed in ~40 ms. Skip while pending stayed pending ("Waiting for the relay — revealing as soon as it lands."), then a short ~310 ms reveal after server completion. Both match the server. |
| 8 | Replay | Re-runs identically; no POST, no score change | ✅ Replay animates again; `POST /rounds` count, server event count and score all unchanged; same target lit. |
| 9 | Refresh during a round | Intent/round restored, reconciles, no double count | ✅ Refresh while pending → reconciled and revealed. Refresh mid-animation → revealed. Refresh after reveal → lit target and result text shown. Same playerId; exactly 2 rounds / 2 requestIds on the server; score equals the server's. |
| 10 | Connection loss during animation | Reconnecting with backoff; no stranded round, no duplicate score | ✅ Server SIGKILLed while pending: status → "Reconnecting", client stays pending (no invented result) through the overdue delay; after restart the round completes server-side and the client reveals it. Server killed mid-animation: reveal finishes locally, client reconnects, score equals the server's. 2 accepted / 2 completed events. |
| 11 | New Round / visual reset | Back to selection; score and history retained | ✅ Back to idle, beacons and Play enabled, stage cleared; score kept; server history intact. |
| 12 | Two players | Concurrent play, independent scores | ✅ Two browser contexts with separate playerIds play at the same time (no `ROUND_IN_PROGRESS`); both reveal; each score equals that player's server score. |

## Screenshots

In [evidence/](evidence/):

1. [Idle — selection state, desktop](evidence/01-idle-desktop.jpg)
2. [Pending — charging pulse, "Connected" pill](evidence/02-pending-charging.jpg)
3. [Travel mid-animation](evidence/03-travel.jpg)
4. [Paused mid-travel (pulse frozen)](evidence/04-paused-mid-travel.jpg)
5. [Reveal — result pill, lit target, pulse absorbed](evidence/05-reveal-round1.jpg)
6. [Reveal after a mid-round refresh](evidence/06-reveal-after-refresh.jpg)
7. [Reconnecting after the server was killed mid-round](evidence/07-reconnecting.jpg)
8. [Reveal after server restart/recovery](evidence/08-reveal-after-recovery.jpg)
9. [Mobile 390×844, reduced-motion reveal](evidence/09-mobile-reduced-motion-reveal.jpg)
10. [How-to-play panel open](evidence/10-how-to-play.jpg)
11. [Mobile 390×844 at DPR 3 — reveal (Chrome)](evidence/11-mobile-dpr3-reveal.jpg)
12. [Desktop 1280×720 at DPR 2 — travel (Chrome)](evidence/12-desktop-dpr2-travel.jpg)
13. [Desktop 1280×720 — reveal (Firefox)](evidence/13-firefox-desktop-reveal.jpg)
14. [Mobile 390×844 — reveal (Firefox)](evidence/14-firefox-mobile-reveal.jpg)

## Untested cases

**Untested:** Safari, physical mobile devices, screen readers, and
background-tab behaviour in a visible (non-headless) browser.

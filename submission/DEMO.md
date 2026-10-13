# Beacon Relay — demo evidence

## Recorded environment and results

Windows, Node 24.19.0. Browser interactions were automated in real headless
Chromium 154.0.8037.58 and Firefox 157.0; they were not a manual human play session.
Desktop viewport: 1280×720 at DPR 1. Mobile viewport: 390×844 at DPR 2.
Mobile is viewport emulation, not a physical phone.

The assigned local commit schedule is recorded in [WORKLOG.md](WORKLOG.md).
Commit dates were adjusted separately from the actual implementation and evidence
capture times. The reports below retain their original generation timestamps;
the history rewrite did not regenerate or retime browser evidence.

- Supplied wire/scaffolding fixtures: 4 passing tests.
- Candidate backend/client/WebSocket suite: 19 passing tests, including a real
  no-pong peer terminated in approximately 40 seconds.
- Supplied acceptance checker: 9 passing groups.
- Browser checks: 13 passing groups per browser; details and versions are in
  [Chromium report](evidence/browser-report.json) and
  [Firefox report](evidence/firefox-browser-report.json).

| Scenario                          | Recorded result                                                  |
| --------------------------------- | ---------------------------------------------------------------- |
| Desktop selection and layout      | Beacons and controls usable; no horizontal overflow              |
| Keyboard-only selection/start     | Number keys, Tab, and Enter select and start correctly           |
| Rapid starts                      | 20 synthetic extra clicks create one accepted round              |
| Pause/Resume                      | Pulse position holds; presentation resumes                       |
| Pause before completion           | Server completes while presentation stays paused                 |
| Skip pending/completed            | Pending waits for the real result; completed reveals immediately |
| Replay                            | No POST, new events, or additional points                        |
| New Round                         | Selection returns; score history remains                         |
| Refresh pending round             | Same request/round identity is restored                          |
| Offline submission                | Original request identity is retried after reconnection          |
| Connection loss during travel     | Recorded result remains stable; feed reconnects                  |
| Abrupt server restart             | Accepted round recovers with one completion                      |
| Delayed HTTP acceptance           | Old reply cannot overwrite the newer intent/round                |
| Simulated hidden/resumed document | Presentation freezes and resumes with one animation owner        |
| Mobile and reduced motion         | Beacons remain inside stage; 180 ms travel preserves outcome     |
| Runtime errors                    | No uncaught browser errors                                       |

## Screenshots and visual review

These capture the real service/client during the browser checks. Animation was
paused partway through travel to capture a stable frame. Screenshots are full-page
captures at the stated viewport widths; the footer may require vertical scrolling.
Images were visually reviewed for selection, pulse/path alignment, distinct target
styling, result text, control layout, and clipping at both viewport sizes.

| State              | Chromium                                   | Firefox                                            |
| ------------------ | ------------------------------------------ | -------------------------------------------------- |
| Selection, desktop | [Image](evidence/01-selection-desktop.png) | [Image](evidence/firefox-01-selection-desktop.png) |
| Animation, desktop | [Image](evidence/02-animation-desktop.png) | [Image](evidence/firefox-02-animation-desktop.png) |
| Result, desktop    | [Image](evidence/03-result-desktop.png)    | [Image](evidence/firefox-03-result-desktop.png)    |
| Selection, mobile  | [Image](evidence/04-selection-mobile.png)  | [Image](evidence/firefox-04-selection-mobile.png)  |
| Result, mobile     | [Image](evidence/05-result-mobile.png)     | [Image](evidence/firefox-05-result-mobile.png)     |

## Reproduce browser evidence

Runtime/candidate tests only need the root install. Browser validation adds an
optional development dependency, locked entirely under submission/:

```sh
npm ci --prefix submission --ignore-scripts
npm exec --prefix submission -- playwright install chromium firefox
node submission/browser-test.mjs
```

On Windows the script uses installed Google Chrome when available; otherwise it
uses Playwright Chromium. Set BROWSER_EXECUTABLE for another Chromium executable.
For Firefox in PowerShell:

```powershell
$env:BROWSER = 'firefox'
node submission/browser-test.mjs
Remove-Item Env:BROWSER
```

Each browser run uses temporary ports/storage, writes its screenshots/report, and
stops its own process tree. Set HEADED=1 to watch the checks in a visible browser.

## Human review runbook and remaining limits

Start `node submission/start.mjs`, open http://127.0.0.1:4400, and:

1. At 1280×720, select with 1/2/3 or arrow keys; Tab to Play and press Enter.
2. Watch the waiting feedback, eased travel, and match/miss reveal. Replay once.
3. Pause before completion, wait, then Resume; repeat using Skip before completion.
4. Use New Round and verify that the total score does not reset.
5. Start and immediately refresh. Confirm the same round finishes.
6. Toggle DevTools Offline during a round, then restore connectivity.
7. Background and resume the tab during travel; confirm one coherent presentation.
8. Repeat at 390×844 and with OS/browser reduced-motion enabled.

Untested: Safari, physical touch devices, screen-reader behavior, and subjective
smoothness judged by a human playing the game. Background-tab handling has unit
coverage for the animation lifecycle and code review, but actual OS tab-suspension
behavior has not been verified; browser tests simulate visibility changes. No audio is included. Power-loss durability,
distributed writers, and large-scale load are outside the assessment scope.

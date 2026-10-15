# Demo evidence

## Run
```sh
npm ci --ignore-scripts
node submission/start.mjs
# open http://127.0.0.1:4400
```

## Environment
- Browser: Chrome/Chromium 155.0.8059.79, headless.
- OS: macOS 26.5.2.
- Viewports: desktop 1280x720 and mobile 390x844.

## How this was tested
I drove the running client with a small headless-Chromium script
(`evidence/drive.mjs`, puppeteer-core), one isolated context per scenario, against
`node submission/start.mjs` with `ROUND_DELAY_MS=1200`. The screenshots are real
captures from that run and the table is the script's actual output.

To reproduce: start the server, `pnpm add puppeteer-core` in a scratch folder, then
`node evidence/drive.mjs`.

## Screenshots (`submission/evidence/`)
- `01-selection.png` - a beacon selected, Play enabled.
- `02-pending.png` - round in flight, no outcome shown yet.
- `03-reveal.png` - reveal: pulse at the server's target, match/miss, point and score.
- `04-mobile.png` - 390x844 layout, no clipping.
- `05-reduced-motion.png` - reveal under reduced motion.

## Results (13/13 pass, Chrome 155)
| Scenario | Expected | Result |
|---|---|---|
| Select beacon (desktop) | aria-pressed set | pass |
| Pending after Play | waiting shown, no early outcome | pass |
| Reveal | match/miss, target, point and score | pass |
| Replay | same result, score unchanged, no new round | pass |
| Mobile 390x844 | no horizontal overflow | pass (0px) |
| Reduced motion | reveals correctly, no error | pass |
| Keyboard (1-3 select, Enter plays) | plays to reveal | pass |
| Rapid Play clicks | one round only (score delta <= 1) | pass |
| Refresh mid-round | recovers and reveals | pass |
| Pause / Resume | server still completes | pass |
| Skip | reveals completed result at once | pass |
| New Round | back to selection, score kept | pass |
| Connection loss mid-round | reconnects and reconciles | pass |

## Not covered
- Safari and Firefox were not run, only Chromium 155. No browser-specific issues
  are expected (plain DOM, standard APIs) but this is not verified.
- Animation feel is best judged by opening the page directly; the driver checks
  behavior and state, not subjective smoothness.
- Backend behavior is covered separately by `node submission/test.mjs` and
  `node scripts/check.mjs`.

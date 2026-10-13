# Beacon Relay — Manual Demo Evidence

## Environment

- OS: Windows
- Browser: Desktop Chrome
- Exact browser version: 155.0.8059.40 (Official Build) (64-bit) (cohort: Stable)
- Desktop viewport: 1920 × 963
- Mobile viewport: verified at 390 × 844
- Local URL: http://127.0.0.1:4400

## Automated tests

- `node submission/test.mjs`: 2 tests passed.
- `node scripts/check.mjs`: all 9 acceptance groups passed.
- JavaScript syntax checks for the client, timeline, gateway and test
  files passed.

## Manual results

- Started the local application and verified the health endpoint.
- Played rounds and observed both matches and misses.
- Confirmed that the displayed target and score come from the server.
- Confirmed replay uses an existing result without creating a new round.
- Confirmed the client recovers an unfinished round after refreshing.
- Confirmed rapid Play clicks do not create duplicate rounds.
- Stopped and restarted the local server and confirmed reconnection and
  recovery of the existing round.

## Visual evidence

- Selection: `evidence/Selection.JPG`
- Animation: `evidence/Animation.JPG`
- Result: `evidence/Result-Miss.JPG`
- Result: `evidence/Result-Match.JPG`

## Browser, viewport, and accessibility checks

- Desktop viewport at exactly 1280 × 720: Tested.
- Mobile viewport at exactly 390 × 844: Tested using Chrome DevTools device emulation, no physical mobile device was tested.
- Keyboard-only operation and visible focus: Tested.
- Reduced-motion preference: Tested in Chrome DevTools. The animation is shorter, while the server result and score remain accurate.
- Safari: Not tested; Safari was unavailable in my Windows environment.
- Firefox: Tested locally.
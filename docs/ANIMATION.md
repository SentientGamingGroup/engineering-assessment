# Animation and game functions

Create a small finished game scene: three labelled beacons and a travelling energy
pulse. DOM, SVG, Canvas or WebGL are all acceptable. Explain your rendering choice.
Simple synthetic shapes suffice; no particular asset format or technique is required.

## Sequence

1. **Idle:** select a labelled beacon and Play.
2. **Anticipation:** immediate feedback; guard starts while acceptance is unresolved.
   Show pending/reconnecting honestly.
3. **Travel:** coherent pulse motion with easing. If the server is slow, remain
   visibly waiting; never invent a result.
4. **Reveal:** after server completion, finish at its target, show a distinct
   match/miss effect, selection, target and point. Main presentation: about
   **2–3 seconds**, excluding backend delay.
5. **Replay/reset:** replay exactly that result; New Round returns to selection.

Use frame-rate-independent timing and one active timeline. Resize/high-DPI rendering
must not clip the stage. Background/resumed tabs must not create multiple loops or
show a wrong outcome. Clean up old animations before replacing them.

## Controls and robustness

- Play, Pause/Resume, Skip, Replay and New Round work in relevant states.
  Pause affects presentation only; the server continues. Skip immediately reveals
  a completed result or waits for completion. Neither changes scoring.
- Disable conflicting controls. Rapid clicks/network retries retain the same request
  identity; stale replies cannot replace a newer round. Completion redelivery never
  awards points twice.
- Preserve current intent/round across refresh. Reconnect/reconcile on connection
  loss. Do not discard pending work merely because the connection drops.
- Label controls, support keyboard selection/play, visible focus and textual results.
  Honor prefers-reduced-motion with minimal/shorter motion and the same outcome.
  Audio is optional and earns no extra points.

## Evidence

Add submission/DEMO.md: manual results, browser/version, viewport and untested cases.
Include a short screen recording **or** a few screenshots of selection, animation
and result; keep binary evidence small or link it in the PR.

Exercise desktop **1280×720**, mobile **390×844**, keyboard-only play, reduced
motion, rapid clicks, replay, refresh during a round and connection loss during
animation. Use a desktop Chromium browser and Safari/Firefox if available; record
unavailable browsers/devices honestly. No device lab/deployment is required.

Reviewers assess smoothness, readable timing, complete transitions, synchronization
with server state and working controls. Static artwork alone is insufficient;
elaborate artwork is unnecessary.

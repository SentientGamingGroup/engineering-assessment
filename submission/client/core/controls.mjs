// Which controls are usable in each app phase. One table, so conflicting
// controls can't be enabled by an overlooked branch.
export const isAnimating = phase => phase === 'starting' || phase === 'playing' || phase === 'replaying';

export function controlsFor({ phase, paused = false, hasSelection = true, hasResult = false }) {
  const animating = isAnimating(phase);
  return {
    select: phase === 'idle',
    play: phase === 'idle' && hasSelection,
    pause: animating,
    pauseLabel: paused ? 'Resume' : 'Pause',
    skip: animating,
    replay: phase === 'revealed' && hasResult,
    newRound: phase === 'revealed',
  };
}

// Keyboard shortcuts as a pure mapping, so they work page-wide in every browser
// (Safari does not focus buttons on click or Tab by default) and can be unit-tested.
import { isAnimating } from './controls.mjs';

// Returns the action for a key press, or null to let the browser handle it.
// `target`: 'beacon' | 'button' | 'other' — what currently has focus.
export function keyAction(key, phase, target = 'other') {
  if (['1', '2', '3'].includes(key)) return { type: 'select', choice: Number(key) - 1 };
  if (key === 'ArrowLeft' || key === 'ArrowUp') return { type: 'move', delta: -1 };
  if (key === 'ArrowRight' || key === 'ArrowDown') return { type: 'move', delta: 1 };
  switch (key.toLowerCase()) {
    case 'p': return { type: 'pause' };
    case 's': return { type: 'skip' };
    case 'r': return { type: 'replay' };
    case 'n': return { type: 'newRound' };
    case 'enter':
      if (target === 'beacon') return { type: 'play' }; // radio group: Enter plays the focused beacon
      if (target === 'button') return null; // native button activation
      if (phase === 'idle') return { type: 'play' };
      if (phase === 'revealed') return { type: 'newRound' };
      return null;
    case ' ':
      if (target === 'button' || target === 'beacon') return null; // native activation / selection
      return isAnimating(phase) ? { type: 'pause' } : null;
    default: return null;
  }
}

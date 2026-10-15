// Persists the client's durable intent across refresh: who I am, what I asked for,
// the round it produced, whether it was revealed and how far the feed was applied.
const KEY = 'beacon-relay/v1';
const FIELDS = ['playerId', 'selection', 'intent', 'round', 'revealed', 'ledger'];

export function loadSaved() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

export function save(state) {
  const snapshot = Object.fromEntries(FIELDS.map(field => [field, state[field]]));
  try { localStorage.setItem(KEY, JSON.stringify(snapshot)); } catch { /* storage unavailable (private mode) */ }
}

// Random identifiers that satisfy the contract pattern [A-Za-z0-9_-]{1,64}.
export function randomId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

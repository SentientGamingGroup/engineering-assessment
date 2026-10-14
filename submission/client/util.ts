export const newId = (prefix: string): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
};

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Bounded exponential backoff with jitter: ~0.5s, 1s, 2s … capped at 8s. */
export const backoff = (attempt: number): number => Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() / 2);

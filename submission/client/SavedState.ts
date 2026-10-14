/** Web Storage persistence. Failures (private mode, quota) only lose convenience, never rounds. */
export class SavedState {
  // A getter: even reading window.localStorage can throw when storage is blocked.
  private readonly storage: () => Storage;
  private readonly key: string;

  constructor(storage: () => Storage, key: string) {
    this.storage = storage;
    this.key = key;
  }

  load(): unknown {
    try { return JSON.parse(this.storage().getItem(this.key) ?? 'null'); } catch { return null; }
  }

  save(value: unknown): void {
    try { this.storage().setItem(this.key, JSON.stringify(value)); } catch { /* private mode */ }
  }
}

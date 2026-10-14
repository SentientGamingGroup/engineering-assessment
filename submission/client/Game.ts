// Wires RoundState to the network, storage and view, and owns the two client
// workflows: submitting a round, and reconciling after every (re)connect.
import { EventFeed } from './EventFeed.ts';
import { RoundApi } from './RoundApi.ts';
import { RoundState } from './RoundState.ts';
import { SavedState } from './SavedState.ts';
import { View } from './View.ts';
import { backoff, newId, sleep } from './util.ts';

/** Feed events can arrive in bursts (a catch-up replays history): save them at most this often. */
const SAVE_MS = 200;

export class Game {
  // The player, cursor and score belong to the browser: localStorage, written together
  // so a saved cursor always matches its results. The intent and current round belong
  // to the tab: sessionStorage survives its refresh, and another tab can't overwrite
  // them. Two tabs playing at once meet the server's one-pending-round-per-player rule.
  private readonly shared = new SavedState(() => localStorage, 'beacon-relay:v1');
  private readonly tab = new SavedState(() => sessionStorage, 'beacon-relay:v1:tab');
  private readonly api = new RoundApi();
  private readonly state: RoundState;
  private readonly view: View;
  private readonly feed: EventFeed;
  private readonly inflight = new Set<string>(); // requestIds with a submit loop running
  private retrying: string | undefined; // requestId whose submit is retrying after an unknown outcome
  private replayed = false; // Replay pressed for the current result (presentation only)
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(root: Document) {
    // Tab fields override shared ones (an older single-key save still restores its round).
    this.state = RoundState.restore(Object.assign({}, this.shared.load(), this.tab.load()), newId);
    this.view = new View(root, {
      select: choice => this.update(this.state.select(choice)),
      play: () => this.play(),
      replay: () => this.replay(),
      newRound: () => this.newRound(),
    });
    this.feed = new EventFeed(() => this.state.cursor, {
      onOpen: () => void this.reconcile(),
      onEvent: event => this.update(this.state.applyEvent(event), 'soon'), // already-applied sequences are ignored
      onStatus: text => this.view.setConnection(text),
    });
    // A pending feed save must not be lost to a refresh or a tab the browser discards.
    addEventListener('pagehide', () => this.flushSave());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushSave(); });
  }

  start(): void {
    this.save(); // persist a newly created player/intent key right away
    this.render();
    void this.reconcile();
    this.feed.connect();
  }

  // --- Controls ----------------------------------------------------------------

  private play(): void {
    if (!this.state.play()) return; // not idle (e.g. a second click): the round is already started
    this.replayed = false;
    this.update(true);
    void this.submit();
  }

  /** Re-show the recorded result: no request, no score change. */
  private replay(): void {
    if (this.state.phase !== 'completed') return;
    this.replayed = true;
    this.render();
    this.view.replay(this.state);
  }

  private newRound(): void {
    if (!this.state.newRound()) return;
    this.replayed = false;
    this.update(true);
    this.view.focusPlay();
  }

  // --- Workflows -----------------------------------------------------------------

  /** POST until accepted or rejected; an unknown outcome retries the same requestId. */
  private async submit(): Promise<void> {
    const round = this.state.round;
    if (this.state.phase !== 'submitting' || this.inflight.has(round!.requestId)) return;
    const { requestId, choice } = round!;
    const stillOurs = () => this.state.round?.requestId === requestId && this.state.phase === 'submitting';
    this.inflight.add(requestId);
    try {
      for (let attempt = 0; stillOurs(); attempt++) {
        const result = await this.api.startRound(requestId, this.state.playerId, choice);
        if (result.kind === 'accepted') { this.update(this.state.applyRound(result.round)); return; }
        if (result.kind === 'rejected') { this.update(this.state.rejected(requestId, result.code)); return; }
        this.retrying = requestId;
        this.render();
        await sleep(backoff(attempt));
      }
    } finally {
      this.inflight.delete(requestId);
      if (this.retrying === requestId) this.retrying = undefined; // a newer submit may own it now
      this.render();
    }
  }

  /**
   * Runs on start and whenever the feed (re)connects. The feed itself delivers
   * completions, so there is no polling: this only catches up after a disconnect.
   */
  private async reconcile(): Promise<void> {
    if (!await this.checkCursor()) return; // reconnects from 0, then reconciles again
    if (this.state.phase === 'submitting') void this.submit();
    else await this.refreshRound();
  }

  /**
   * A cursor the server doesn't have (DATA_DIR wiped, or another server on this
   * origin) would make every event look already applied.
   */
  private async checkCursor(): Promise<boolean> {
    if (!this.state.cursor || await this.api.hasEvent(this.state.cursor) !== false) return true;
    this.update(this.state.resync());
    this.feed.restart('resync');
    return false;
  }

  private async refreshRound(): Promise<void> {
    if (this.state.phase !== 'pending') return;
    const result = await this.api.getRound(this.state.round!.roundId!);
    if (result.kind === 'found') this.update(this.state.applyRound(result.round));
    else if (result.kind === 'missing') {
      // The server no longer knows our round: its history was reset (e.g. DATA_DIR wiped).
      this.state.serverReset();
      this.update(true);
      this.feed.restart('server reset');
    }
    // unknown: the next reconnect reconciles again
  }

  // --- Plumbing ------------------------------------------------------------------

  /** Save and re-render after a change; feed events save 'soon' (batched), everything else now. */
  private update(changed: boolean, when: 'now' | 'soon' = 'now'): void {
    if (!changed) return;
    if (when === 'now') this.save();
    else this.saveTimer ??= setTimeout(() => this.save(), SAVE_MS);
    this.render();
  }

  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const { round, intentKey, choice, ...shared } = this.state.toJSON();
    this.shared.save(shared);
    this.tab.save({ round, intentKey, choice });
  }

  private flushSave(): void {
    if (this.saveTimer !== undefined) this.save();
  }

  private render(): void {
    const retrying = this.retrying !== undefined && this.retrying === this.state.round?.requestId;
    this.view.render(this.state, { retrying, replayed: this.replayed });
  }
}

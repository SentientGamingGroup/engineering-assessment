// The one active presentation timeline. It owns the order of the round's animations
// (drop into the pulse -> visibly wait for the server -> fly to the target -> land ->
// reveal) and is the only thing Pause/Skip act on. It never touches game state:
// pausing or skipping changes what is shown and when, not the result or the score.
//
// It knows nothing about the DOM: View supplies the effects as Motions (a Web Animation
// satisfies the interface), so the sequencing can be tested in Node with fakes.
import type { Choice } from './types.ts';

/** A running animation step. finished rejects when it is cancelled. */
export interface Motion {
  readonly finished: Promise<unknown>;
  pause(): void;
  play(): void;
  finish(): void;
  cancel(): void;
}

/** Page effects. Under reduced motion they fade in place instead of moving, so every step stays visible. */
export interface StageEffects {
  showPulse(choice: Choice): void;
  hidePulse(): void;
  /** The chosen beacon's colour drops into the pulse. */
  morph(choice: Choice): Motion;
  /** A pausable pause. */
  delay(ms: number): Motion;
  /** The pulse flies from its spot to the target beacon. */
  flight(target: Choice): Motion;
  /** Landing effects: crown on the target, head-shake on a missed choice. */
  land(target: Choice, choice: Choice): Motion[];
  /** Crowns sink away (before a replay). */
  uncrown(): Motion[];
}

export class Presentation {
  private readonly stage: StageEffects;
  private readonly onChange: () => void;
  private readonly live = new Set<Motion>();
  private token = 0; // bumped by every new sequence and cancel; stale sequences stop
  private _running = false;
  private _paused = false;
  private _skipping = false;

  constructor(stage: StageEffects, onChange: () => void) {
    this.stage = stage;
    this.onChange = onChange;
  }

  get running(): boolean { return this._running; }
  get paused(): boolean { return this._paused; }
  get skipping(): boolean { return this._skipping; }

  /**
   * A live round. `outcome` resolves with the server's target once the round completes;
   * until then the pulse stays visibly waiting (a result is never invented). With
   * `fromWaiting` (a refresh mid-round) the drop is skipped and the pulse just waits.
   */
  async playRound(choice: Choice, outcome: Promise<Choice>, reveal: () => void, fromWaiting = false): Promise<void> {
    const token = this.begin();
    this.stage.showPulse(choice);
    if (!fromWaiting && !(await this.step(token, this.stage.morph(choice)))) return;
    let target: Choice;
    try { target = await outcome; } catch { return; } // abandoned (e.g. rejected): cancel() cleans up
    if (token !== this.token) return;
    await this.flyAndReveal(token, target, choice, reveal);
  }

  /** Replay a recorded result: same steps, known target, no request or score change. */
  async replay(choice: Choice, target: Choice, reveal: () => void): Promise<void> {
    const token = this.begin();
    for (const motion of this.stage.uncrown()) this.track(motion);
    this.stage.showPulse(choice);
    if (!(await this.step(token, this.stage.morph(choice)))) return;
    if (!(await this.step(token, this.stage.delay(500)))) return;
    await this.flyAndReveal(token, target, choice, reveal);
  }

  pause(): void {
    if (!this._running || this._paused || this._skipping) return;
    this._paused = true;
    for (const motion of this.live) motion.pause();
    this.onChange();
  }

  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    for (const motion of this.live) motion.play();
    this.onChange();
  }

  /** Reveal now if the result is known, otherwise the moment it arrives. */
  skip(): void {
    if (!this._running || this._skipping) return;
    this._skipping = true;
    this._paused = false;
    for (const motion of [...this.live]) motion.finish();
    this.onChange();
  }

  /** Stop and clear the current sequence (New Round, a rejected round, a newer sequence). */
  cancel(): void {
    this.token++;
    for (const motion of [...this.live]) motion.cancel();
    this.live.clear();
    this.stage.hidePulse();
    if (this._running || this._paused || this._skipping) {
      this._running = this._paused = this._skipping = false;
      this.onChange();
    }
  }

  private async flyAndReveal(token: number, target: Choice, choice: Choice, reveal: () => void): Promise<void> {
    if (!(await this.step(token, this.stage.flight(target)))) return;
    this.stage.hidePulse();
    for (const motion of this.stage.land(target, choice)) this.track(motion); // not awaited: the reveal is now
    reveal();
    this._running = this._paused = this._skipping = false;
    this.onChange();
  }

  private begin(): number {
    this.cancel();
    this._running = true;
    this.onChange();
    return this.token;
  }

  /** Run one step; false when the sequence was cancelled or replaced meanwhile. */
  private async step(token: number, motion: Motion): Promise<boolean> {
    if (token !== this.token) { motion.cancel(); return false; }
    this.track(motion);
    try { await motion.finished; } catch { return false; }
    return token === this.token;
  }

  /** Register a motion so Pause/Skip/cancel reach it; one started while paused starts paused. */
  private track(motion: Motion): void {
    this.live.add(motion);
    const forget = () => this.live.delete(motion);
    motion.finished.then(forget, forget);
    if (this._skipping) motion.finish();
    else if (this._paused) motion.pause();
  }
}

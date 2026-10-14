// The DOM: the starter markup from index.html, a text status and the stage effects.
// Presentation (Presentation.ts) owns the animation sequence; View supplies the effects
// as Web Animations and decides what to show when (e.g. the result only once revealed).
import { Presentation } from './Presentation.ts';
import { BEACONS } from './types.ts';
import type { Motion, StageEffects } from './Presentation.ts';
import type { Choice } from './types.ts';
import type { Phase, RoundState } from './RoundState.ts';

export interface ViewActions {
  select(choice: Choice): void;
  play(): void;
  replay(): void;
  newRound(): void;
}

/** Presentation-only flags owned by Game, not RoundState. */
export interface ViewFlags {
  retrying: boolean;
  replayed: boolean;
}

const NOTICES: Record<string, string> = {
  ROUND_IN_PROGRESS: 'This player already has a round in progress (another tab?). Try again shortly.',
  SERVER_RESET: 'The server history was reset, so your round and score were cleared.',
  IDEMPOTENCY_CONFLICT: 'That request was already used with different details.',
  INVALID_REQUEST: 'The server rejected the request.',
};

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Reduced motion: each step fades in place, shorter than the move it replaces. */
const FADE_MS = 250;

export class View {
  private readonly beacons: HTMLButtonElement[];
  private readonly stage: HTMLElement;
  private readonly pulse: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly replayButton: HTMLButtonElement;
  private readonly newRoundButton: HTMLButtonElement;
  private readonly result: HTMLElement;
  private readonly score: HTMLElement;
  private readonly connection: HTMLElement;
  private readonly controls: HTMLButtonElement[];
  private readonly presentation: Presentation;
  private state: RoundState | undefined;
  /** Keyboard focus was on a control that got disabled and still needs a new home. */
  private owesFocus = false;
  /** The "+N" floating above the score, while it is showing. */
  private floating: { element: HTMLElement; gain: number } | undefined;
  private flags: ViewFlags = { retrying: false, replayed: false };
  private lastChoice: Choice | undefined;
  private lastPhase: Phase | undefined;
  private lastScore: number | undefined;
  /** The live round being presented (requestId) and how its outcome reaches the sequence. */
  private presented: { requestId: string; resolve: (target: Choice) => void; reject: () => void } | undefined;
  /** requestId whose result has been revealed; a completed round shows its result only then. */
  private revealed: string | undefined;
  private replaying = false; // a replay sequence is running (its result text waits for its own reveal)

  constructor(root: Document, actions: ViewActions) {
    const $ = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
    this.beacons = [...root.querySelectorAll<HTMLButtonElement>('.beacon')];
    this.stage = $('.stage');
    $('.orbit').hidden = true;
    this.pulse = $('.pulse');
    this.pulse.hidden = true;
    this.playButton = $('#play');
    this.pauseButton = $('#pause');
    this.skipButton = $('#skip');
    this.replayButton = $('#replay');
    this.newRoundButton = $('#new');
    this.result = $('#result');
    this.score = $('#score');
    this.connection = $('#connection');
    this.controls = [...this.beacons, this.playButton, this.pauseButton, this.skipButton, this.replayButton, this.newRoundButton];
    this.presentation = new Presentation(this.effects(), () => this.refresh());

    this.beacons.forEach((beacon, i) => beacon.addEventListener('click', () => actions.select(i as Choice)));
    this.playButton.addEventListener('click', () => actions.play());
    this.pauseButton.addEventListener('click', () => {
      if (this.presentation.paused) this.presentation.resume(); else this.presentation.pause();
    });
    this.skipButton.addEventListener('click', () => this.presentation.skip());
    this.replayButton.addEventListener('click', () => actions.replay());
    this.newRoundButton.addEventListener('click', () => actions.newRound());
  }

  render(state: RoundState, flags: ViewFlags): void {
    const focused = document.activeElement; // before any control is disabled below
    this.state = state;
    this.flags = flags;
    const phase = state.phase;
    const round = state.round;
    const waiting = phase === 'submitting' || phase === 'pending';

    // Drive the presentation from round transitions.
    if (waiting && this.presented?.requestId !== round!.requestId) {
      this.present(round!.requestId, round!.choice, this.lastPhase !== 'idle'); // a refresh mid-round just waits
    } else if (phase === 'completed' && this.presented?.requestId === round!.requestId) {
      this.presented.resolve(round!.target!);
    } else if (phase === 'idle' && this.presented) { // rejected, reset or New Round
      this.presented.reject();
      this.presented = undefined;
      this.presentation.cancel();
    }
    if (phase === 'completed' && !this.presented) this.revealed = round!.requestId; // nothing presenting: show it
    if (phase !== 'completed') this.replaying = false;
    if (phase === 'idle' && this.lastPhase === 'completed') {
      this.presentation.cancel(); // e.g. New Round during a replay
      this.uncrownAll();
    }

    const shownChoice = round?.choice ?? state.choice;
    this.beacons.forEach((beacon, i) => {
      beacon.setAttribute('aria-pressed', String(shownChoice === i));
      beacon.disabled = phase !== 'idle';
    });
    const choiceChanged = this.lastChoice !== undefined && state.choice !== this.lastChoice;
    if (phase === 'idle' && (choiceChanged || this.lastPhase === 'completed')) this.nudgePlay(); // new selection or New Round
    this.lastChoice = state.choice;
    this.lastPhase = phase;
    if (!this.stage.classList.contains('ready')) this.boot();
    this.refresh(focused);
  }

  setConnection(text: string): void {
    this.connection.textContent = text;
  }

  /** Replay the recorded result (presentation only: no request, no score change). */
  replay(state: RoundState): void {
    const round = state.round;
    if (!round || round.target === undefined || this.presentation.running) return;
    this.replaying = true;
    void this.presentation.replay(round.choice, round.target, () => { this.replaying = false; });
    this.refresh();
  }

  focusPlay(): void {
    this.playButton.focus();
  }

  // --- What is shown --------------------------------------------------------------

  /** Controls, score and status text: re-run on round changes and on presentation changes. */
  private refresh(focused = document.activeElement): void {
    const state = this.state;
    if (!state) return;
    const phase = state.phase;
    const round = state.round;
    const p = this.presentation;
    const shown = phase === 'completed' && this.revealed === round!.requestId;

    this.playButton.disabled = phase !== 'idle';
    this.pauseButton.disabled = !p.running || p.skipping;
    this.pauseButton.textContent = p.paused ? 'Resume' : 'Pause'; // the label is the state; no aria-pressed too
    this.skipButton.disabled = !p.running || p.skipping;
    this.replayButton.disabled = !shown || p.running;
    this.newRoundButton.disabled = !shown || p.running;
    this.stage.classList.toggle('paused', p.paused);

    if (shown && !p.running) this.beacons[round!.target!].classList.add('crowned'); // e.g. after a refresh

    // The current round's point is counted only once its result is revealed.
    const hidden = phase === 'completed' && !shown ? round!.score ?? 0 : 0;
    this.setScore(state.score - hidden);
    // A live region re-announces on every write, and refresh runs on every feed event.
    const text = this.statusText(state, shown);
    if (this.result.textContent !== text) this.result.textContent = text;
    this.keepFocus(focused);
  }

  /**
   * A focused control that gets disabled (Play once pressed, Skip once revealed) would
   * drop keyboard focus to <body>. Hand it to the most useful enabled control, or to the
   * first one enabled later (e.g. after a Skip that waits for the result).
   */
  private keepFocus(focused: Element | null): void {
    const active = document.activeElement;
    if (focused instanceof HTMLButtonElement && focused.disabled && this.controls.includes(focused)) this.owesFocus = true;
    else if (active && active !== document.body && !(active instanceof HTMLButtonElement && active.disabled)) this.owesFocus = false; // focus moved on
    if (!this.owesFocus) return;
    const next = [this.pauseButton, this.skipButton, this.newRoundButton, this.replayButton, this.playButton].find(b => !b.disabled);
    if (next) {
      next.focus();
      this.owesFocus = false;
    }
  }

  private statusText(state: RoundState, shown: boolean): string {
    const round = state.round;
    const p = this.presentation;
    const paused = p.paused ? ' Paused — the server keeps going.' : '';
    switch (state.phase) {
      case 'idle':
        return (state.notice ? `${NOTICES[state.notice] ?? `Round not started (${state.notice}).`} ` : '')
          + `Selected beacon ${BEACONS[state.choice]}. Press Play.`;
      case 'submitting':
        return `Sending your choice (${BEACONS[round!.choice]})…${this.flags.retrying ? ' Connection trouble — retrying the same request.' : ''}${paused}`;
      case 'pending':
        return `Accepted — waiting for the server result…${p.skipping ? ' It will be shown as soon as it arrives.' : ''}${paused}`;
      case 'completed':
        if (!shown) return `Result received — revealing…${paused}`;
        if (this.replaying) return `Replaying the recorded result…${paused}`;
        return `${this.flags.replayed ? 'Replay: ' : ''}${round!.score ? 'Match! +1 point.' : 'Miss. No point.'}`
          + ` You chose ${BEACONS[round!.choice]}; the signal was ${BEACONS[round!.target!]}.`;
    }
  }

  /** Start presenting a live round; its outcome arrives through render() on completion. */
  private present(requestId: string, choice: Choice, fromWaiting: boolean): void {
    this.presented?.reject();
    let resolve!: (target: Choice) => void;
    let reject!: () => void;
    const outcome = new Promise<Choice>((res, rej) => { resolve = res; reject = rej; });
    outcome.catch(() => {}); // abandoned rounds are expected
    this.presented = { requestId, resolve, reject };
    void this.presentation.playRound(choice, outcome, () => {
      this.revealed = requestId;
      this.presented = undefined;
      this.refresh();
    }, fromWaiting);
  }

  // --- Stage effects (Web Animations; fades in place under reduced motion) ------------

  private effects(): StageEffects {
    return {
      showPulse: choice => {
        this.pulse.style.setProperty('--accent', this.accent(choice));
        this.beacons[choice].classList.add('drained'); // its colour is now the pulse
        this.pulse.hidden = false;
      },
      hidePulse: () => {
        this.cancelPulseMotion();
        this.pulse.hidden = true;
        this.beacons.forEach(beacon => beacon.classList.remove('drained'));
      },
      // Reduced motion: nothing travels, scales or shakes, but every step still shows.
      morph: choice => (reducedMotion() ? this.fadePulse(0, 1) : this.morph(this.beacons[choice])),
      delay: ms => this.pulse.animate([], { duration: ms }), // a still hold: no motion either way
      flight: target => (reducedMotion() ? this.fadePulse(1, 0) : this.flight(this.beacons[target])),
      land: (target, choice) => {
        this.beacons[target].classList.add('crowned');
        if (reducedMotion()) return [this.crownFade(this.beacons[target])];
        const motions: Motion[] = [this.crownRise(this.beacons[target])];
        if (choice !== target) motions.push(this.wiggle(this.beacons[choice])); // the wrong choice shakes its head
        return motions;
      },
      uncrown: () => this.uncrownAll(),
    };
  }

  private accent(choice: Choice): string {
    return getComputedStyle(this.beacons[choice]).getPropertyValue('--accent').trim();
  }

  private cancelPulseMotion(): void {
    for (const animation of this.pulse.getAnimations()) if (!(animation instanceof CSSAnimation)) animation.cancel();
  }

  /**
   * The chosen beacon's background becomes a drop of water that travels into the pulse:
   * it shrinks on the way, lands, then zooms in and out elastically before settling.
   * FLIP: animate from the beacon's box to the pulse's own position.
   */
  private morph(beacon: HTMLElement): Animation {
    this.cancelPulseMotion();
    const from = beacon.getBoundingClientRect();
    const to = this.pulse.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const size = from.width / to.width;
    const frame = (t: number, scale: number, offset: number, easing: string): Keyframe => ({
      transform: `translate(${dx * t}px, ${dy * t}px) scale(${scale})`, offset, easing,
    });
    return this.pulse.animate([
      frame(1, size, 0, 'ease-in'),               // the beacon's background
      frame(0.75, size * 0.45, 0.22, 'ease-out'), // gathers into a drop
      frame(0, 1.9, 0.55, 'ease-out'),            // lands big
      frame(0, 0.7, 0.68, 'ease-in-out'),         // zoom out
      frame(0, 1.25, 0.8, 'ease-in-out'),         // zoom in
      frame(0, 0.92, 0.9, 'ease-in-out'),
      frame(0, 1, 1, 'linear'),                   // settled
    ], { duration: 1100 });
  }

  /** The pulse flies to the target beacon and merges into it (held until hidePulse). */
  private flight(beacon: HTMLElement): Animation {
    this.cancelPulseMotion();
    const from = this.pulse.getBoundingClientRect();
    const to = beacon.getBoundingClientRect();
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    return this.pulse.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 1, easing: 'cubic-bezier(.5, 0, .2, 1)' },
      { transform: `translate(${dx}px, ${dy}px) scale(1.4)`, opacity: 1, offset: 0.75, easing: 'ease-out' },
      { transform: `translate(${dx}px, ${dy}px) scale(${to.width / from.width})`, opacity: 0 },
    ], { duration: 900, fill: 'forwards' });
  }

  /** Reduced motion: the pulse fades where it is instead of travelling (held until hidePulse). */
  private fadePulse(from: number, to: number): Animation {
    this.cancelPulseMotion();
    return this.pulse.animate([{ opacity: from }, { opacity: to }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' });
  }

  /** Reduced motion: the crown fades in place instead of rising. */
  private crownFade(beacon: HTMLElement): Animation {
    return beacon.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out', pseudoElement: '::after' });
  }

  /** The crown rises from behind the beacon with a bounce (cropped by the circle in CSS). */
  private crownRise(beacon: HTMLElement): Animation {
    return beacon.animate([
      { '--crown-y': '-110%' }, { '--crown-y': '12%', offset: 0.55 }, { '--crown-y': '-5%', offset: 0.75 },
      { '--crown-y': '2%', offset: 0.9 }, { '--crown-y': '0%' },
    ], { duration: 700, easing: 'ease-out', pseudoElement: '::after' });
  }

  /** Crowns sink back behind their beacons (fade under reduced motion); returns the running motions. */
  private uncrownAll(): Motion[] {
    const motions: Motion[] = [];
    const reduced = reducedMotion();
    for (const beacon of this.beacons) {
      if (!beacon.classList.contains('crowned') || beacon.dataset.uncrowning) continue;
      beacon.dataset.uncrowning = '1';
      // A small lift, then down until the circle crops it away.
      const out = beacon.animate(reduced ? [{ opacity: 1 }, { opacity: 0 }] : [
        { '--crown-y': '0%' }, { '--crown-y': '10%', offset: 0.3 }, { '--crown-y': '-110%' },
      ], { duration: reduced ? FADE_MS : 450, easing: 'ease-in', fill: 'forwards', pseudoElement: '::after' });
      const done = () => {
        beacon.classList.remove('crowned');
        out.cancel(); // drop the fill now that the class no longer shows the crown
        delete beacon.dataset.uncrowning;
      };
      out.finished.then(done, () => delete beacon.dataset.uncrowning);
      motions.push(out);
    }
    return motions;
  }

  /** A head-shake for the wrong choice (stronger than the Play nudge). */
  private wiggle(element: HTMLElement): Animation {
    return element.animate([
      { transform: 'translateX(0) rotate(0)' }, { transform: 'translateX(-7px) rotate(-3deg)' },
      { transform: 'translateX(7px) rotate(3deg)' }, { transform: 'translateX(-5px) rotate(-2deg)' },
      { transform: 'translateX(4px) rotate(1.5deg)' }, { transform: 'translateX(-2px) rotate(-.5deg)' },
      { transform: 'translateX(0) rotate(0)' },
    ], { duration: 750, easing: 'ease-in-out' });
  }

  // --- Small UI touches ----------------------------------------------------------------

  /**
   * Until the first render the stage shows a neutral state (see .stage:not(.ready) in
   * style.css), so the starter markup's default selection never flashes. The first
   * render then applies the restored state instantly; transitions only switch on
   * (.booted) a frame later, so nothing animates from the default to the saved state.
   */
  private boot(): void {
    this.stage.classList.add('ready');
    requestAnimationFrame(() => requestAnimationFrame(() => this.stage.classList.add('booted')));
  }

  /** Show the score, popping it (with a floating "+N") when it goes up. */
  private setScore(value: number): void {
    // Update only the number's text node, so a floating "+N" child survives re-renders.
    const number = this.score.firstChild;
    if (number?.nodeType === Node.TEXT_NODE) { if (number.nodeValue !== String(value)) number.nodeValue = String(value); }
    else this.score.prepend(String(value));
    if (this.lastScore !== undefined && value > this.lastScore) this.bumpScore(value - this.lastScore);
    this.lastScore = value;
  }

  /**
   * Pop the score and float a "+N" above it. Gains that land while a "+N" is still
   * floating (a catch-up replays history in a burst) add to it instead of stacking more.
   */
  private bumpScore(gain: number): void {
    if (this.floating?.element.isConnected) {
      this.floating.gain += gain;
      this.floating.element.textContent = `+${this.floating.gain}`;
      return;
    }
    this.score.classList.remove('bump');
    void this.score.offsetWidth; // reflow so the animation restarts
    this.score.classList.add('bump');
    // Reduced motion: the pop is a colour flash and nothing floats (a hidden "+N"
    // would never get the animationend that removes it).
    if (reducedMotion()) return;
    const element = Object.assign(document.createElement('span'), { className: 'score-plus', textContent: `+${gain}` });
    element.setAttribute('aria-hidden', 'true');
    element.addEventListener('animationend', () => element.remove());
    this.score.append(element);
    this.floating = { element, gain };
  }

  /** Draw attention to Play after a new selection; restarts if already running. */
  private nudgePlay(): void {
    this.playButton.classList.remove('nudge');
    void this.playButton.offsetWidth; // reflow so the animation restarts
    this.playButton.classList.add('nudge');
  }
}

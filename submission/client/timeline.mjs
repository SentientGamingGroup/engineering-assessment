// One animation owner. Restarting never creates a second requestAnimationFrame chain.
export class AnimationLoop {
  constructor(
    step,
    request = (callback) => requestAnimationFrame(callback),
    cancel = (key) => cancelAnimationFrame(key),
  ) {
    this.step = step;
    this.request = request;
    this.cancel = cancel;
    this.active = false;
    this.frame = null;
    this.last = null;
  }
  start() {
    if (this.active) return;
    this.active = true;
    this.last = null;
    this.frame = this.request((time) => this.advance(time));
  }
  advance(time) {
    this.frame = null;
    if (!this.active) return;
    const delta = this.last === null ? 0 : Math.max(0, time - this.last);
    this.last = time;
    if (this.step(delta, time) === false) this.stop();
    if (this.active) this.frame = this.request((next) => this.advance(next));
  }
  stop() {
    this.active = false;
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null;
    this.last = null;
  }
}

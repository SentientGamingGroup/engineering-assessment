// Everything outside the stage animation: buttons, beacon selection state, HUD,
// connection badge and text. Receives plain values; owns no game state.
const $ = selector => document.querySelector(selector);

export function createView() {
  const stage = $('#stage');
  const beacons = [...document.querySelectorAll('.beacon')];
  const buttons = { play: $('#play'), pause: $('#pause'), skip: $('#skip'), replay: $('#replay'), newRound: $('#new') };

  function bumpable(id, value, bump) {
    const el = $(`#${id}`);
    if (el.textContent === String(value)) return;
    el.textContent = value;
    el.classList.remove('bump');
    if (!bump) return;
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('bump');
  }

  return {
    stage,
    beacons,
    buttons,

    setPhase(phase) { stage.dataset.phase = phase; },

    renderControls(controls, selectedIndex) {
      beacons.forEach((beacon, i) => {
        const selected = i === selectedIndex;
        beacon.setAttribute('aria-checked', String(selected));
        beacon.setAttribute('aria-disabled', String(!controls.select));
        beacon.tabIndex = selected ? 0 : -1;
      });
      buttons.play.disabled = !controls.play;
      buttons.pause.disabled = !controls.pause;
      buttons.pause.textContent = controls.pauseLabel;
      buttons.skip.disabled = !controls.skip;
      buttons.replay.disabled = !controls.replay;
      buttons.newRound.disabled = !controls.newRound;
      // Keep keyboard focus on something usable when the focused control gets disabled.
      if (document.activeElement?.disabled) Object.values(buttons).find(b => !b.disabled)?.focus();
    },

    renderStats({ score, rounds, streak }, animate = true) {
      bumpable('score', score, animate && score > 0);
      bumpable('rounds', rounds, false);
      bumpable('streak', streak, false);
    },

    setCore({ title, sub, pop }) {
      const titleEl = $('#core-title');
      titleEl.textContent = title;
      titleEl.style.transform = `scale(${pop})`;
      $('#core-sub').textContent = sub;
    },

    setNote(text) { $('#stage-note').textContent = text; },

    setResult(text, tone = '') {
      const el = $('#result');
      el.textContent = text;
      el.className = tone;
    },

    setConnection(kind, text) {
      const el = $('#connection');
      el.dataset.state = kind;
      el.textContent = text;
    },

    setPlayer(playerId) { $('#player').textContent = `as ${playerId.slice(0, 8)}`; },

    // Hide the loader once the first fully restored frame has been painted.
    reveal() {
      if (!document.body.classList.contains('loading')) return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.classList.remove('loading');
        $('main').removeAttribute('aria-busy');
      }));
    },
  };
}

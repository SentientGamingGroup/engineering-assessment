// Ambient flickering-grid background for the stage (canvas, vanilla port of
// the common "flickering grid" effect). Purely decorative: pointer-events off,
// DPR/resize aware, holds still while the game is paused and renders a static
// frame under prefers-reduced-motion.
export function attachFlickerGrid(canvas, {
  squareSize = 3,
  gridGap = 8,
  flickerChance = 0.3,       // per-square chance per second
  color = '83, 224, 196',    // theme teal (rgb)
  maxOpacity = 0.22,
} = {}) {
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const cell = squareSize + gridGap;
  let width = 0, height = 0, cols = 0, rows = 0;
  let squares = new Float32Array(0);
  let frame = 0, last = 0;

  const resize = () => {
    const dpr = devicePixelRatio || 1;
    width = canvas.parentElement.clientWidth;
    height = canvas.parentElement.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(width / cell);
    rows = Math.ceil(height / cell);
    squares = Float32Array.from({ length: cols * rows }, () => Math.random() * maxOpacity);
    draw();
  };
  const draw = () => {
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        ctx.fillStyle = `rgba(${color}, ${squares[i * rows + j]})`;
        ctx.fillRect(i * cell, j * cell, squareSize, squareSize);
      }
    }
  };
  const tick = now => {
    frame = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (canvas.closest('.paused')) return; // Pause holds the ambience too
    for (let k = 0; k < squares.length; k++) {
      if (Math.random() < flickerChance * dt) squares[k] = Math.random() * maxOpacity;
    }
    draw();
  };
  const start = () => {
    cancelAnimationFrame(frame);
    resize();
    if (!reduced.matches) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  new ResizeObserver(resize).observe(canvas.parentElement);
  reduced.addEventListener?.('change', start);
  start();
}

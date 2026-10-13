export function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function easeInOut(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

export function mixPoint(from, to, progress) {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

export function frameDelta(previousNow, now, cap = 100) {
  if (previousNow === null) return 0;
  return Math.max(0, Math.min(cap, now - previousNow));
}

export function timelineStage(
  elapsed,
  approachMs,
  travelMs,
  hasResult,
) {
  if (elapsed < approachMs) return 'approach';
  if (elapsed < travelMs) return 'travel';
  return hasResult ? 'reveal' : 'waiting';
}
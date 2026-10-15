// Easing curves, p in [0, 1].
export const easeInOut = p => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
export const easeOut = p => 1 - (1 - p) ** 3;
export const easeOutBack = p => 1 + 2.2 * (p - 1) ** 3 + 1.2 * (p - 1) ** 2;

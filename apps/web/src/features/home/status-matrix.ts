/**
 * The sidebar's working mark: a 3 by 3 dot matrix where a short trail steps
 * round the eight outer dots. `status-matrix` in `styles/globals.css` holds the
 * same step, cycle, and opacities as keyframes; each dot runs it with the
 * delay this file gives it.
 */

/** The outer cells as `[column, row]`, clockwise from the top left. */
export const MATRIX_PATH = [
  [0, 0],
  [1, 0],
  [2, 0],
  [2, 1],
  [2, 2],
  [1, 2],
  [0, 2],
  [0, 1],
] as const;

/** How long the trail's head stays on one dot. */
export const MATRIX_STEP_MS = 120;
export const MATRIX_CYCLE_MS = MATRIX_PATH.length * MATRIX_STEP_MS;

/** The head's opacity, then each dot behind it. */
export const MATRIX_TRAIL = [1, 0.7, 0.45] as const;
/** Every dot the trail is not on, the centre included. */
export const MATRIX_REST = 0.22;

/** The opacity of the path's `index`-th dot `timeMs` into the animation. */
export function matrixOpacity(index: number, timeMs: number): number {
  const dots = MATRIX_PATH.length;
  const head = Math.floor(timeMs / MATRIX_STEP_MS);
  const behind = (((head - index) % dots) + dots) % dots;
  return MATRIX_TRAIL[behind] ?? MATRIX_REST;
}

/**
 * The delay that puts the `index`-th dot at its place in the cycle. Negative,
 * so every dot is mid-cycle from its first frame.
 */
export function matrixDelayMs(index: number): number {
  return index * MATRIX_STEP_MS - MATRIX_CYCLE_MS;
}

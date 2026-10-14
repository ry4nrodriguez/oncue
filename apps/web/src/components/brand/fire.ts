/**
 * The wordmark's fire colours, shared by Home's field (`AsciiField.tsx`) and
 * `FireWordmark.tsx`.
 */

export type Rgb = readonly [number, number, number];
export type Ramp = readonly Rgb[];

// Fire ramp: neutral base texture, then ember edge through to a hot core.
export const LIGHT_RAMP: Ramp = [
  [224, 214, 206],
  [166, 40, 6],
  [214, 58, 8],
  [245, 82, 12],
  [255, 132, 48],
  [255, 176, 92],
];

// On a dark canvas the base texture has to sit just above the background and the
// core has to glow, so both ends move rather than the palette simply inverting.
export const DARK_RAMP: Ramp = [
  [56, 50, 46],
  [150, 38, 8],
  [214, 58, 8],
  [245, 82, 12],
  [255, 142, 62],
  [255, 196, 120],
];

// Resting wordmark: present but never loud. Fire washing over it wins.
export const WORD_NEUTRAL_LIGHT = "rgba(28,28,27,0.30)";
export const WORD_NEUTRAL_DARK = "rgba(237,237,236,0.26)";
export const WORD_FLAME_FLOOR = 0.1;

export const FRAME_MS = 1000 / 30;
export const ALPHA_STEPS = 6;
export const MAX_ALPHA = 0.88;
export const DARK_MAX_ALPHA = 0.95;
export const MIN_ALPHA = 0.03;

export type Bucket = { style: string; xs: number[]; ys: number[]; glyphs: string[] };

// One fill style per colour/alpha pair so a frame sets fillStyle 36 times, not 10,000.
export function makeBuckets(ramp: Ramp, maxAlpha: number): Bucket[] {
  const buckets: Bucket[] = [];
  for (const [r, g, b] of ramp) {
    for (let step = 1; step <= ALPHA_STEPS; step += 1) {
      // Non-linear so the ambient grid stays a whisper while cores burn hard.
      const alpha = (MIN_ALPHA + (step / ALPHA_STEPS) ** 1.6 * (maxAlpha - MIN_ALPHA)).toFixed(3);
      buckets.push({ style: `rgba(${r},${g},${b},${alpha})`, xs: [], ys: [], glyphs: [] });
    }
  }
  return buckets;
}

/**
 * The bucket a wordmark cell burns in for a given flame, or `null` when the
 * flame is too faint and the cell rests in the neutral colour.
 */
export function wordCellBucket(
  buckets: readonly Bucket[],
  rampLength: number,
  flame: number,
): Bucket | null {
  if (flame <= WORD_FLAME_FLOOR) {
    return null;
  }
  const tone = Math.min(0.999, 0.35 + flame * 0.65);
  const alpha = Math.min(ALPHA_STEPS - 1, Math.floor(flame ** 0.6 * ALPHA_STEPS));
  return buckets[Math.floor(tone * rampLength) * ALPHA_STEPS + alpha] ?? null;
}

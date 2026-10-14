import { useEffect, useRef } from "react";
import {
  ALPHA_STEPS,
  type Bucket,
  DARK_MAX_ALPHA,
  DARK_RAMP,
  FRAME_MS,
  LIGHT_RAMP,
  MAX_ALPHA,
  makeBuckets,
  WORD_NEUTRAL_DARK,
  WORD_NEUTRAL_LIGHT,
  wordCellBucket,
} from "@/components/brand/fire";
import { WORDMARK, WORDMARK_COLS, WORDMARK_ROWS } from "@/components/brand/wordmark-bitmap";
import { matchesMedia } from "@/lib/media";
import { useTheme } from "@/lib/theme";

// Glyph ramp from empty to dense.
const GLYPHS = [" ", "·", "·", ":", ":", "+", "+", "*", "×", "#", "#", "@"];

// Letterforms and fire colours are shared (`wordmark-bitmap.ts`, `fire.ts`).

const CELL = 13;
const FONT_SIZE = 11;

// Two fire masses drifting on slow Lissajous paths so they cross the whole canvas
// without ever repeating the same route.
const BLOBS = [
  { ax: 0.46, ay: 0.4, sx: 2.1, sy: 1.35, px: 0, py: 0, radius: 0.36, power: 1 },
  { ax: 0.44, ay: 0.38, sx: 1.55, sy: 2.45, px: 2.2, py: 1.1, radius: 0.27, power: 0.82 },
];

export function AsciiField({
  className,
  wordmark = false,
  wordmarkBottom = 0,
}: {
  className?: string;
  wordmark?: boolean | undefined;
  wordmarkBottom?: number | undefined;
}) {
  const { resolved } = useTheme();
  const dark = resolved === "dark";

  const ref = useRef<HTMLCanvasElement | null>(null);
  // Held in a ref so re-measuring the layout never tears down the canvas.
  const wordRef = useRef({ on: wordmark, bottom: wordmarkBottom });

  useEffect(() => {
    wordRef.current = { on: wordmark, bottom: wordmarkBottom };
  }, [wordmark, wordmarkBottom]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    // Non-null aliases so the inner draw functions typecheck under strict mode.
    const el: HTMLCanvasElement = canvas;
    const context: CanvasRenderingContext2D = ctx;

    const ramp = dark ? DARK_RAMP : LIGHT_RAMP;
    const buckets = makeBuckets(ramp, dark ? DARK_MAX_ALPHA : MAX_ALPHA);
    const wordBucket: Bucket = {
      style: dark ? WORD_NEUTRAL_DARK : WORD_NEUTRAL_LIGHT,
      xs: [],
      ys: [],
      glyphs: [],
    };
    const reduceMotion = matchesMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = el.clientWidth;
      height = el.clientHeight;
      el.width = Math.floor(width * dpr);
      el.height = Math.floor(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.font = `${FONT_SIZE}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textBaseline = "top";
    }

    function draw(seconds: number) {
      context.clearRect(0, 0, width, height);
      wordBucket.xs.length = 0;
      wordBucket.ys.length = 0;
      wordBucket.glyphs.length = 0;
      for (const bucket of buckets) {
        bucket.xs.length = 0;
        bucket.ys.length = 0;
        bucket.glyphs.length = 0;
      }

      const cols = Math.ceil(width / CELL);
      const rows = Math.ceil(height / CELL);
      const shortSide = Math.min(width, height) || 1;
      const drift = seconds * 0.055;

      const sources = BLOBS.map((blob) => ({
        x: width * (0.5 + blob.ax * Math.sin(drift * blob.sx + blob.px)),
        y: height * (0.5 + blob.ay * Math.cos(drift * blob.sy + blob.py)),
        radius: blob.radius * shortSide,
        power: blob.power,
      }));

      // Quiet ellipse sized to the composer stack, in pixels, so the calm area
      // hugs the content instead of scaling with the window.
      const centerX = width / 2;
      const centerY = height / 2;

      const word = wordRef.current;
      const wordStartCol = Math.round((cols - WORDMARK_COLS) / 2);
      const wordStartRow = Math.max(0, Math.round(word.bottom / CELL) - WORDMARK_ROWS);

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const px = col * CELL;
          const py = row * CELL;

          // Warping the radius per position breaks the circle into a flame edge.
          const warp =
            1 +
            0.26 * Math.sin(px * 0.011 + py * 0.014 + seconds * 0.9) +
            0.16 * Math.sin(px * 0.023 - py * 0.019 - seconds * 0.6);

          let mass = 0;
          for (const source of sources) {
            const dx = px - source.x;
            const dy = (py - source.y) * 1.15;
            const distance = Math.hypot(dx, dy) / (source.radius * warp);
            if (distance >= 1) {
              continue;
            }
            mass += (1 - distance * distance) ** 1.3 * source.power;
          }

          // Ragged, flickering edges so the mass reads as fire rather than a disc.
          const turbulence =
            0.58 +
            0.28 * Math.sin(col * 0.21 + row * 0.17 - seconds * 1.6) +
            0.17 * Math.sin(col * 0.09 - row * 0.31 + seconds * 1.1);

          const flame = Math.min(1, mass * turbulence * 1.35);
          // Ambient floor keeps a whisper of grid everywhere so the fire sits in
          // a surface rather than floating on blank paper.
          const heat = 0.07 + 0.93 * flame;

          const quietX = 470;
          const quietY = 320;
          const quiet = Math.hypot((px - centerX) / quietX, (py - centerY) / quietY);
          const vignette = 0.42 + 0.58 * Math.min(1, Math.max(0, (quiet - 0.85) / 0.5));

          // Wordmark cells always draw: neutral at rest, fire while a mass is
          // passing through them.
          if (word.on) {
            const wordRow = row - wordStartRow;
            const wordCol = col - wordStartCol;
            if (
              wordRow >= 0 &&
              wordRow < WORDMARK_ROWS &&
              wordCol >= 0 &&
              wordCol < WORDMARK_COLS &&
              WORDMARK[wordRow]?.[wordCol] === true
            ) {
              const hot = wordCellBucket(buckets, ramp.length, flame);
              if (hot) {
                hot.xs.push(px);
                hot.ys.push(py);
                hot.glyphs.push("##");
                continue;
              }
              wordBucket.xs.push(px);
              wordBucket.ys.push(py);
              wordBucket.glyphs.push("##");
              continue;
            }
          }

          const weight = heat * vignette;
          if (weight <= 0.012) {
            continue;
          }

          // Slow pulse rotates the whole field between ember and core tones.
          const tone = Math.min(0.999, Math.max(0, heat + 0.08 * Math.sin(seconds * 0.45)));

          const colorIndex = Math.floor(tone * ramp.length);
          const alphaStep = Math.min(ALPHA_STEPS - 1, Math.floor(weight ** 0.7 * ALPHA_STEPS));
          const bucket = buckets[colorIndex * ALPHA_STEPS + alphaStep];
          if (!bucket) {
            continue;
          }
          bucket.xs.push(px);
          bucket.ys.push(py);
          bucket.glyphs.push(
            GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(heat * GLYPHS.length))] ?? " ",
          );
        }
      }

      for (const bucket of [...buckets, wordBucket]) {
        if (bucket.xs.length === 0) {
          continue;
        }
        context.fillStyle = bucket.style;
        for (let i = 0; i < bucket.xs.length; i += 1) {
          context.fillText(bucket.glyphs[i] ?? "", bucket.xs[i] ?? 0, bucket.ys[i] ?? 0);
        }
      }
    }

    function tick(now: number) {
      frame = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) {
        return;
      }
      last = now;
      draw(now / 1000);
    }

    resize();
    if (reduceMotion) {
      draw(0);
    } else {
      frame = requestAnimationFrame(tick);
    }

    const observer = new ResizeObserver(() => {
      resize();
      if (reduceMotion) {
        draw(0);
      }
    });
    observer.observe(el);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [dark]);

  return (
    <div className={className} aria-hidden="true">
      <canvas ref={ref} className="h-full w-full" />
    </div>
  );
}

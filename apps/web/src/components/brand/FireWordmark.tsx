/**
 * The animated ASCII wordmark on the screens before Home (sign-in, blocked,
 * setup): Home's letters (`wordmark-bitmap.ts`) and fire ramps (`fire.ts`)
 * with one mass sweeping back and forth across the word. Kept cheap: 29 by 7
 * cells, at most 30 frames a second, paused while hidden, and a single still
 * frame under reduced motion.
 */
import { useEffect, useRef } from "react";
import {
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
import { cn } from "@/lib/utils";

/** Home's cell size, so the flame's ragged edge has the same grain here. */
const HOME_CELL = 13;
/** One sweep across the word and back, in seconds. */
const SWEEP_SECONDS = 9;

const MASSES = [
  { amplitude: 0.62, phase: 0, radius: 0.42, power: 1, bob: 1.7 },
  { amplitude: 0.55, phase: Math.PI, radius: 0.3, power: 0.7, bob: 1.3 },
];

/**
 * How hot the fire is at one cell of the word at `seconds`, from 0 to 1. The
 * warp and turbulence terms are Home's (`AsciiField.tsx`), measured in Home's
 * cell size so the flame's edge looks the same at a smaller size.
 */
export function flameAt(col: number, row: number, seconds: number): number {
  const width = WORDMARK_COLS * HOME_CELL;
  const height = WORDMARK_ROWS * HOME_CELL;
  const px = col * HOME_CELL;
  const py = row * HOME_CELL;
  const angle = (seconds / SWEEP_SECONDS) * Math.PI * 2;

  const warp =
    1 +
    0.26 * Math.sin(px * 0.011 + py * 0.014 + seconds * 0.9) +
    0.16 * Math.sin(px * 0.023 - py * 0.019 - seconds * 0.6);

  let mass = 0;
  for (const source of MASSES) {
    const x = width * (0.5 + source.amplitude * Math.sin(angle + source.phase));
    const y = height * (0.5 + 0.3 * Math.sin(angle * source.bob + source.phase));
    const dx = px - x;
    const dy = (py - y) * 1.15;
    const distance = Math.hypot(dx, dy) / (source.radius * width * warp);
    if (distance < 1) {
      mass += (1 - distance * distance) ** 1.3 * source.power;
    }
  }

  const turbulence =
    0.58 +
    0.28 * Math.sin(col * 0.21 + row * 0.17 - seconds * 1.6) +
    0.17 * Math.sin(col * 0.09 - row * 0.31 + seconds * 1.1);

  return Math.min(1, mass * turbulence * 1.35);
}

export interface FireWordmarkProps {
  readonly className?: string;
}

export function FireWordmark({ className }: FireWordmarkProps) {
  const { resolved } = useTheme();
  const dark = resolved === "dark";
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d") ?? null;
    if (canvas === null || context === null) {
      return;
    }
    const el: HTMLCanvasElement = canvas;
    const ctx: CanvasRenderingContext2D = context;

    const ramp = dark ? DARK_RAMP : LIGHT_RAMP;
    const buckets = makeBuckets(ramp, dark ? DARK_MAX_ALPHA : MAX_ALPHA);
    const neutral: Bucket = {
      style: dark ? WORD_NEUTRAL_DARK : WORD_NEUTRAL_LIGHT,
      xs: [],
      ys: [],
      glyphs: [],
    };
    const reduceMotion = matchesMedia("(prefers-reduced-motion: reduce)");
    let cell = 0;
    let frame = 0;
    let last = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = el.clientWidth;
      const height = el.clientHeight;
      el.width = Math.floor(width * dpr);
      el.height = Math.floor(height * dpr);
      cell = width / WORDMARK_COLS;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `${Math.max(1, cell * 0.85)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textBaseline = "top";
    }

    function draw(seconds: number) {
      ctx.clearRect(0, 0, el.width, el.height);
      for (const bucket of [...buckets, neutral]) {
        bucket.xs.length = 0;
        bucket.ys.length = 0;
        bucket.glyphs.length = 0;
      }
      for (let row = 0; row < WORDMARK_ROWS; row += 1) {
        for (let col = 0; col < WORDMARK_COLS; col += 1) {
          if (WORDMARK[row]?.[col] !== true) {
            continue;
          }
          const bucket =
            wordCellBucket(buckets, ramp.length, flameAt(col, row, seconds)) ?? neutral;
          bucket.xs.push(col * cell);
          bucket.ys.push(row * cell);
          bucket.glyphs.push("##");
        }
      }
      for (const bucket of [...buckets, neutral]) {
        if (bucket.xs.length === 0) {
          continue;
        }
        ctx.fillStyle = bucket.style;
        for (let i = 0; i < bucket.xs.length; i += 1) {
          ctx.fillText(bucket.glyphs[i] ?? "", bucket.xs[i] ?? 0, bucket.ys[i] ?? 0);
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
      // One still frame, with the fire resting in the middle of the word.
      draw(0);
    } else {
      frame = requestAnimationFrame(tick);
    }

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            resize();
            if (reduceMotion) {
              draw(0);
            }
          });
    observer?.observe(el);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [dark]);

  return (
    <div
      role="img"
      aria-label="OnCue"
      className={cn("mx-auto w-full max-w-[290px]", className)}
      style={{ aspectRatio: `${WORDMARK_COLS} / ${WORDMARK_ROWS}` }}
    >
      <canvas ref={ref} className="block h-full w-full" data-testid="fire-wordmark" />
    </div>
  );
}

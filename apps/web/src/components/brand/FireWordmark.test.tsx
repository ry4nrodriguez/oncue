import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/lib/theme";
import { FireWordmark, flameAt } from "./FireWordmark";
import { WORDMARK, WORDMARK_COLS, WORDMARK_ROWS } from "./wordmark-bitmap";

const INKED = WORDMARK.flat().filter(Boolean).length;

/** A 2D context that records what was drawn, since jsdom has no canvas. */
function fakeContext() {
  const drawn: { style: string; glyph: string }[] = [];
  let fillStyle = "";
  return {
    drawn,
    context: {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      set font(_value: string) {},
      set textBaseline(_value: string) {},
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string) {
        fillStyle = value;
      },
      fillText: (glyph: string) => drawn.push({ style: fillStyle, glyph }),
    },
  };
}

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query === "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

let fake: ReturnType<typeof fakeContext>;

beforeEach(() => {
  fake = fakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    fake.context as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FireWordmark", () => {
  it("names the product once, for assistive technology", () => {
    stubReducedMotion(true);
    render(<FireWordmark />, { wrapper: ThemeProvider });
    expect(screen.getAllByRole("img", { name: "OnCue" })).toHaveLength(1);
  });

  it("draws one still frame of every inked cell, and schedules nothing, under reduced motion", () => {
    stubReducedMotion(true);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    render(<FireWordmark />, { wrapper: ThemeProvider });

    expect(fake.drawn).toHaveLength(INKED);
    expect(fake.drawn.every((cell) => cell.glyph === "##")).toBe(true);
    // The still frame still shows fire on some letters and rest on others.
    const styles = new Set(fake.drawn.map((cell) => cell.style));
    expect(styles.size).toBeGreaterThan(1);
    expect(raf).not.toHaveBeenCalled();
  });

  it("animates otherwise, and stops when it leaves the page", () => {
    stubReducedMotion(false);
    const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const { unmount } = render(<FireWordmark />, { wrapper: ThemeProvider });

    expect(raf).toHaveBeenCalledTimes(1);
    unmount();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("renders nothing to the canvas, without throwing, when there is no 2D context", () => {
    stubReducedMotion(true);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(<FireWordmark />, { wrapper: ThemeProvider });
    expect(fake.drawn).toHaveLength(0);
  });
});

describe("flameAt", () => {
  it("stays between 0 and 1", () => {
    for (let seconds = 0; seconds < 20; seconds += 0.7) {
      for (let row = 0; row < WORDMARK_ROWS; row += 1) {
        for (let col = 0; col < WORDMARK_COLS; col += 1) {
          const flame = flameAt(col, row, seconds);
          expect(flame).toBeGreaterThanOrEqual(0);
          expect(flame).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  /** Back and forth: within one sweep the fire reaches both ends of the word. */
  it("washes across the whole word within one sweep", () => {
    const hottestColumnAt = (seconds: number) => {
      let best = 0;
      let bestFlame = -1;
      for (let col = 0; col < WORDMARK_COLS; col += 1) {
        const flame = flameAt(col, 3, seconds);
        if (flame > bestFlame) {
          bestFlame = flame;
          best = col;
        }
      }
      return best;
    };
    const columns = Array.from({ length: 36 }, (_unused, i) => hottestColumnAt(i * 0.25));
    expect(Math.min(...columns)).toBeLessThan(WORDMARK_COLS / 4);
    expect(Math.max(...columns)).toBeGreaterThan((WORDMARK_COLS * 3) / 4);
  });
});

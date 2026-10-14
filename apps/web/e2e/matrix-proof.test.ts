import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MATRIX_CYCLE_MS,
  MATRIX_PATH,
  MATRIX_REST,
  MATRIX_STEP_MS,
  MATRIX_TRAIL,
  matrixOpacity,
} from "../src/features/home/status-matrix";
import { analyseMatrix, headOf, isStepEdge, type MatrixSample, thinSamples } from "./matrix-proof";

const FRAME_MS = 1000 / 60;

/** What the mark shows `t` ms in, as a browser would report it. */
function frameAt(t: number): number[] {
  return MATRIX_PATH.map((_, index) => matrixOpacity(index, t));
}

function sampled(frame: (t: number) => number[], durationMs = 3000): MatrixSample[] {
  const samples: MatrixSample[] = [];
  for (let t = 0; t <= durationMs; t += FRAME_MS) {
    samples.push({ t, opacities: frame(t) });
  }
  return samples;
}

describe("analyseMatrix", () => {
  it("passes the real animation, from any starting phase", () => {
    for (const offset of [0, 50, MATRIX_CYCLE_MS - 1]) {
      const verdict = analyseMatrix(sampled((t) => frameAt(t + offset)));
      expect(verdict.reasons).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(verdict.offFrame).toBe(0);
      expect(verdict.largestJump).toBe(1);
      expect(verdict.stepsTaken).toBeGreaterThanOrEqual(2 * MATRIX_PATH.length);
      expect(Math.abs((verdict.msPerStep ?? 0) - MATRIX_STEP_MS)).toBeLessThan(2);
    }
  });

  it("fails a mark that holds one frame", () => {
    const verdict = analyseMatrix(sampled(() => frameAt(0)));
    expect(verdict.ok).toBe(false);
    expect(verdict.stepsTaken).toBe(0);
    expect(verdict.msPerStep).toBeNull();
    expect(verdict.reasons.join(" ")).toMatch(/never moved/);
  });

  it("fails a mark that runs backwards", () => {
    const verdict = analyseMatrix(sampled((t) => frameAt(10 * MATRIX_CYCLE_MS - t)));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/jumped 7 dots/);
  });

  it("fails a mark that runs at the wrong speed", () => {
    const verdict = analyseMatrix(sampled((t) => frameAt(t / 2), 6000));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toMatch(/^a step took 2[34]\d\.\d ms, not 120$/);
  });

  it("fails dots that show anything but the trail", () => {
    const verdict = analyseMatrix(
      sampled((t) => (t < 100 ? MATRIX_PATH.map(() => 1) : frameAt(t))),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.offFrame).toBe(6);
    expect(verdict.reasons.join(" ")).toMatch(
      /6 samples were not a frame of the trail \(first at 0 ms/,
    );
  });

  it("accepts one sample caught on the instant of a step, and refuses two in a row", () => {
    // The step from the first dot to the second, read with the old head
    // already dimmed and the new one not yet lit.
    const torn = frameAt(0).map((opacity, index) =>
      index === 0 ? matrixOpacity(0, MATRIX_STEP_MS) : opacity,
    );
    expect(headOf(torn)).toBeNull();
    expect(isStepEdge(torn)).toBe(true);
    const tearAt = (indexes: readonly number[]) =>
      sampled(frameAt).map((sample, index) =>
        indexes.includes(index) ? { ...sample, opacities: torn } : sample,
      );

    const once = analyseMatrix(tearAt([7]));
    expect(once.reasons).toEqual([]);
    expect(once.onEdge).toBe(1);
    expect(once.offFrame).toBe(0);

    const stuck = analyseMatrix(tearAt([7, 8]));
    expect(stuck.ok).toBe(false);
    expect(stuck.onEdge).toBe(1);
    expect(stuck.offFrame).toBe(1);
    expect(stuck.reasons.join(" ")).toMatch(/1 samples were not a frame of the trail/);
  });

  it("fails a mark seen for less than two laps", () => {
    const verdict = analyseMatrix(sampled(frameAt, 1000));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/fewer than 2 laps of 8/);
  });

  it("does not judge the path between samples a step or more apart", () => {
    // A stalled page: one sample every three steps still goes round, unjudged for jumps.
    const samples: MatrixSample[] = [];
    for (let t = 0; t <= 6000; t += 3 * MATRIX_STEP_MS) {
      samples.push({ t, opacities: frameAt(t) });
    }
    const verdict = analyseMatrix(samples);
    expect(verdict.largestJump).toBe(0);
    expect(verdict.reasons).toEqual([]);
  });
});

describe("headOf and thinSamples", () => {
  it("names the dot the head is on, and refuses anything that is not a frame", () => {
    expect(headOf(frameAt(0))).toBe(0);
    expect(headOf(frameAt(3 * MATRIX_STEP_MS + 5))).toBe(3);
    expect(headOf(frameAt(0).slice(1))).toBeNull();
    expect(headOf(MATRIX_PATH.map(() => 0))).toBeNull();
    // A whole frame is its own edge; dots that never appear together are not.
    expect(isStepEdge(frameAt(0))).toBe(true);
    expect(isStepEdge(frameAt(0).slice(1))).toBe(false);
    expect(isStepEdge(MATRIX_PATH.map(() => 1))).toBe(false);
  });

  it("keeps one sample per interval for a readable table", () => {
    const thinned = thinSamples(sampled(frameAt, 500), MATRIX_STEP_MS);
    expect(thinned.map((row) => row.head)).toEqual([0, 1, 2, 3, 4]);
    expect(thinned[0]?.opacities).toBe(frameAt(0).join(" "));
  });
});

describe("the stylesheet's keyframes", () => {
  it("run the step, cycle, and opacities the proof judges against", () => {
    // A plain path: Vite rewrites `new URL(path, import.meta.url)` into an asset URL.
    const css = readFileSync(
      fileURLToPath(import.meta.url).replace(/e2e\/[^/]+$/, "src/styles/globals.css"),
      "utf8",
    );
    const keyframes = /@keyframes status-matrix \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const stops = [...keyframes.matchAll(/([\d.%,\s]+)\{\s*opacity:\s*([\d.]+);/g)].map(
      (match) => ({
        at: (match[1] ?? "").split(",").map((part) => Number.parseFloat(part)),
        opacity: Number(match[2]),
      }),
    );
    const stepPercent = 100 / MATRIX_PATH.length;
    expect(stops).toEqual([
      ...MATRIX_TRAIL.map((opacity, index) => ({ at: [index * stepPercent], opacity })),
      { at: [MATRIX_TRAIL.length * stepPercent, 100], opacity: MATRIX_REST },
    ]);
    expect(css).toContain(`animation: status-matrix ${MATRIX_CYCLE_MS}ms step-end infinite;`);
  });
});

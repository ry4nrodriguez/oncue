import { describe, expect, it } from "vitest";
import {
  MATRIX_CYCLE_MS,
  MATRIX_PATH,
  MATRIX_REST,
  MATRIX_STEP_MS,
  MATRIX_TRAIL,
  matrixDelayMs,
  matrixOpacity,
} from "./status-matrix";

describe("the working mark's matrix", () => {
  it("walks the eight outer cells once each, every step to a neighbour", () => {
    const cells = MATRIX_PATH.map(([column, row]) => `${column},${row}`);
    expect(new Set(cells).size).toBe(8);
    expect(cells).not.toContain("1,1");
    for (const [index, [column, row]] of MATRIX_PATH.entries()) {
      const [nextColumn, nextRow] = MATRIX_PATH[(index + 1) % MATRIX_PATH.length] ?? [1, 1];
      expect(Math.abs(nextColumn - column) + Math.abs(nextRow - row)).toBe(1);
    }
  });

  it("lights the head and fades the dots behind it", () => {
    // At the start the head is on the first dot and the trail lies behind it.
    expect(MATRIX_PATH.map((_, index) => matrixOpacity(index, 0))).toEqual([
      1,
      MATRIX_REST,
      MATRIX_REST,
      MATRIX_REST,
      MATRIX_REST,
      MATRIX_REST,
      MATRIX_TRAIL[2],
      MATRIX_TRAIL[1],
    ]);
    // One step on, everything has moved one dot round.
    expect(matrixOpacity(1, MATRIX_STEP_MS)).toBe(1);
    expect(matrixOpacity(0, MATRIX_STEP_MS)).toBe(MATRIX_TRAIL[1]);
    expect(matrixOpacity(7, MATRIX_STEP_MS)).toBe(MATRIX_TRAIL[2]);
    expect(matrixOpacity(6, MATRIX_STEP_MS)).toBe(MATRIX_REST);
    // A level holds for its whole step, and the cycle repeats.
    expect(matrixOpacity(0, MATRIX_STEP_MS - 1)).toBe(1);
    expect(matrixOpacity(3, 5 * MATRIX_CYCLE_MS + 3 * MATRIX_STEP_MS)).toBe(1);
  });

  it("delays each dot to its place in the cycle, never past the first frame", () => {
    expect(matrixDelayMs(0)).toBe(-MATRIX_CYCLE_MS);
    expect(matrixDelayMs(7)).toBe(-MATRIX_STEP_MS);
    for (const [index] of MATRIX_PATH.entries()) {
      expect(matrixDelayMs(index)).toBeLessThan(0);
      // A dot's own clock at the page's time 0 shows what `matrixOpacity` says.
      expect(matrixOpacity(0, -matrixDelayMs(index))).toBe(matrixOpacity(index, 0));
    }
  });
});

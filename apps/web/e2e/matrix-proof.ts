/**
 * Checks that the sidebar's working mark animates as designed. `analyseMatrix`
 * judges per-frame samples of the outer dots' opacities and passes only when
 * every sample is a frame of the trail (`status-matrix.ts`), the head moves on
 * one dot at a time at the designed speed, and it goes round at least twice.
 *
 * Each dot runs its own animation, so a sample taken on the instant of a step
 * may read some dots before it and some after. One such sample is the step
 * being caught mid-change; two in a row is a mark stuck between frames.
 */

import { MATRIX_PATH, MATRIX_STEP_MS, matrixOpacity } from "../src/features/home/status-matrix";

export interface MatrixSample {
  /** Milliseconds since sampling began. */
  readonly t: number;
  /** The outer dots' opacities, in path order. */
  readonly opacities: readonly number[];
}

export interface MatrixVerdict {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly samples: number;
  /** Samples that matched no frame of the trail. */
  readonly offFrame: number;
  /** Samples caught on the instant of a step, each dot on one side of it. */
  readonly onEdge: number;
  /** How many dots the head moved on over the whole sampling. */
  readonly stepsTaken: number;
  /** The measured time a step took, or `null` when the head moved fewer than twice. */
  readonly msPerStep: number | null;
  /** The furthest the head moved between two samples less than a step apart. */
  readonly largestJump: number;
}

/** A computed opacity counts as a level within this much of it. */
export const OPACITY_TOLERANCE = 0.01;
export const MIN_LAPS = 2;
/** The measured step may differ from the designed one by this fraction. */
export const SPEED_TOLERANCE = 0.15;

/** The path dot the trail's head is on in these opacities, or `null` when they are no frame of it. */
export function headOf(opacities: readonly number[]): number | null {
  if (opacities.length !== MATRIX_PATH.length) {
    return null;
  }
  for (let head = 0; head < MATRIX_PATH.length; head += 1) {
    const at = head * MATRIX_STEP_MS;
    const matches = opacities.every(
      (opacity, index) => Math.abs(opacity - matrixOpacity(index, at)) <= OPACITY_TOLERANCE,
    );
    if (matches) {
      return head;
    }
  }
  return null;
}

/** Whether every dot shows what it shows just before or just after some step. */
export function isStepEdge(opacities: readonly number[]): boolean {
  if (opacities.length !== MATRIX_PATH.length) {
    return false;
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= OPACITY_TOLERANCE;
  for (let head = 0; head < MATRIX_PATH.length; head += 1) {
    const before = head * MATRIX_STEP_MS;
    const after = before + MATRIX_STEP_MS;
    const matches = opacities.every(
      (opacity, index) =>
        near(opacity, matrixOpacity(index, before)) || near(opacity, matrixOpacity(index, after)),
    );
    if (matches) {
      return true;
    }
  }
  return false;
}

export function analyseMatrix(samples: readonly MatrixSample[]): MatrixVerdict {
  const reasons: string[] = [];
  const dots = MATRIX_PATH.length;
  let offFrame = 0;
  let firstOffFrame: MatrixSample | null = null;
  let onEdge = 0;
  let lastWasEdge = false;
  let stepsTaken = 0;
  let largestJump = 0;
  let firstMove: number | null = null;
  let lastMove: number | null = null;
  let stepsSinceFirstMove = 0;
  let previous: { head: number; t: number } | null = null;

  for (const sample of samples) {
    const head = headOf(sample.opacities);
    if (head === null) {
      if (isStepEdge(sample.opacities) && !lastWasEdge) {
        onEdge += 1;
        lastWasEdge = true;
      } else {
        offFrame += 1;
        firstOffFrame ??= sample;
      }
      continue;
    }
    lastWasEdge = false;
    if (previous !== null && head !== previous.head) {
      const moved = (head - previous.head + dots) % dots;
      stepsTaken += moved;
      // Samples a step or more apart say nothing about how the head got there.
      if (sample.t - previous.t < MATRIX_STEP_MS) {
        largestJump = Math.max(largestJump, moved);
      }
      if (firstMove === null) {
        firstMove = sample.t;
      } else {
        stepsSinceFirstMove += moved;
      }
      lastMove = sample.t;
    }
    previous = { head, t: sample.t };
  }

  const msPerStep =
    firstMove !== null && lastMove !== null && stepsSinceFirstMove > 0
      ? (lastMove - firstMove) / stepsSinceFirstMove
      : null;

  if (firstOffFrame !== null) {
    reasons.push(
      `${offFrame} samples were not a frame of the trail (first at ${Math.round(firstOffFrame.t)} ms: ${firstOffFrame.opacities.join(" ")})`,
    );
  }
  if (stepsTaken === 0) {
    reasons.push("the head never moved: not an animation");
  } else if (stepsTaken < MIN_LAPS * dots) {
    reasons.push(`the head moved ${stepsTaken} dots, fewer than ${MIN_LAPS} laps of ${dots}`);
  }
  if (largestJump > 1) {
    reasons.push(`the head jumped ${largestJump} dots within one step: not one dot at a time`);
  }
  if (
    msPerStep !== null &&
    Math.abs(msPerStep - MATRIX_STEP_MS) > MATRIX_STEP_MS * SPEED_TOLERANCE
  ) {
    reasons.push(`a step took ${msPerStep.toFixed(1)} ms, not ${MATRIX_STEP_MS}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    samples: samples.length,
    offFrame,
    onEdge,
    stepsTaken,
    msPerStep: msPerStep === null ? null : Math.round(msPerStep * 10) / 10,
    largestJump,
  };
}

/** Every `everyMs`-th moment of the samples, for a table a person can read. */
export function thinSamples(
  samples: readonly MatrixSample[],
  everyMs: number,
): { t: number; head: number | null; opacities: string }[] {
  const out: { t: number; head: number | null; opacities: string }[] = [];
  let next = 0;
  for (const sample of samples) {
    // A fixed grid, so a frame that lands late does not push every later row back.
    if (sample.t >= next - 0.5) {
      out.push({
        t: Math.round(sample.t),
        head: headOf(sample.opacities),
        opacities: sample.opacities.join(" "),
      });
      while (next - 0.5 <= sample.t) {
        next += everyMs;
      }
    }
  }
  return out;
}

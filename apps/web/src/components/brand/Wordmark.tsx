/**
 * The wordmark, small and still: Home's letterforms as one SVG of cells, since
 * the sidebar is always mounted and a canvas would burn frames. Drawn in
 * `currentColor`.
 */

import { WORDMARK, WORDMARK_COLS, WORDMARK_ROWS } from "./wordmark-bitmap";

export interface WordmarkProps {
  /** Side of one bitmap cell, in pixels. */
  readonly cell?: number;
  readonly className?: string;
}

export function Wordmark({ cell = 2, className }: WordmarkProps) {
  return (
    <svg
      role="img"
      aria-label="OnCue"
      viewBox={`0 0 ${WORDMARK_COLS} ${WORDMARK_ROWS}`}
      width={WORDMARK_COLS * cell}
      height={WORDMARK_ROWS * cell}
      className={className}
      // Whole-pixel cells; smoothing would blur them.
      shapeRendering="crispEdges"
    >
      {WORDMARK.flatMap((cells, row) =>
        cells.map((inked, col) =>
          inked ? (
            <rect
              // The grid is a fixed bitmap, so position is the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed bitmap grid
              key={`${row}-${col}`}
              x={col}
              y={row}
              width={1}
              height={1}
              fill="currentColor"
            />
          ) : null,
        ),
      )}
    </svg>
  );
}

/**
 * The OnCue wordmark as a bitmap, shared by Home's fire field and the
 * sidebar's small mark. Seven rows, five columns per letter, one blank column
 * between, and only the letters the word needs.
 */

const LETTERS: Record<string, readonly string[]> = {
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  n: [".....", ".....", "#.##.", "##..#", "#...#", "#...#", "#...#"],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  u: [".....", ".....", "#...#", "#...#", "#...#", "#..##", ".##.#"],
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
};

const WORD = ["O", "n", "C", "u", "e"];

export const WORDMARK_ROWS = 7;

/** Row-major, `true` where a cell is inked. */
export const WORDMARK: readonly (readonly boolean[])[] = Array.from(
  { length: WORDMARK_ROWS },
  (_unused, row) =>
    WORD.flatMap((letter, index) => {
      const cells = [...(LETTERS[letter]?.[row] ?? "")].map((cell) => cell === "#");
      return index < WORD.length - 1 ? [...cells, false] : cells;
    }),
);

export const WORDMARK_COLS = WORDMARK[0]?.length ?? 0;

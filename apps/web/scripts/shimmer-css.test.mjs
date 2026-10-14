// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The shimmer loops without a seam only if the keyframes move the highlight
 * layer by exactly one tile. With a tile of S percent of the width, position
 * p puts the tile at (100 - S) * p / 100 percent, so one tile of travel is a
 * change in p of S / (S - 100) * 100. This reads the real stylesheet.
 */
const css = readFileSync(
  fileURLToPath(new URL("../src/styles/globals.css", import.meta.url)),
  "utf8",
);

function block(name) {
  const start = css.indexOf(name);
  expect(start, `${name} is in globals.css`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let at = css.indexOf("{", start); at < css.length; at += 1) {
    if (css[at] === "{") {
      depth += 1;
    } else if (css[at] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(start, at + 1);
      }
    }
  }
  throw new Error(`${name} is not closed`);
}

/** The first layer's x position in a keyframe, as a percentage. */
function firstLayerX(keyframes, frame) {
  const match = new RegExp(`${frame}\\s*{\\s*background-position:\\s*(-?[\\d.]+)%?\\s`).exec(
    keyframes,
  );
  expect(match, `the ${frame} frame sets background-position`).not.toBeNull();
  return Number(match?.[1]);
}

describe("the shimmer loop", () => {
  const keyframes = block("@keyframes shimmer-sweep");
  const utility = block("@utility shimmer");

  it("moves the highlight layer by exactly one tile, left to right", () => {
    const size = Number(/background-size:\s*([\d.]+)%/.exec(utility)?.[1]);
    expect(size).toBeGreaterThan(100);
    const from = firstLayerX(keyframes, "from");
    const to = firstLayerX(keyframes, "to");
    // Left to right: the tile's offset, (100 - size) * p, rises as p falls.
    expect(from).toBeGreaterThan(to);
    expect(from - to).toBeCloseTo((size / (size - 100)) * 100, 6);
  });

  it("tiles the highlight along x, so the next sweep follows the last", () => {
    expect(utility).toMatch(/background-repeat:\s*repeat-x,\s*no-repeat;/);
  });

  it("runs at a constant speed, forever", () => {
    expect(utility).toMatch(/animation:\s*shimmer-sweep\s+[\d.]+m?s\s+linear\s+infinite;/);
  });

  it("stands still under reduced motion", () => {
    const reduced = block("@media (prefers-reduced-motion: reduce)");
    expect(reduced).toMatch(/\.shimmer\s*{[^}]*animation:\s*none;/);
  });
});

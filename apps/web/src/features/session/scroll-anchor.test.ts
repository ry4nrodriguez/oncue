import { afterEach, describe, expect, it, vi } from "vitest";
import { captureScroll, restoreScroll } from "./scroll-anchor";

afterEach(() => {
  document.body.innerHTML = "";
});

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    x: 0,
    y: top,
  } as DOMRect;
}

/** A scroller with rows of `height`, whose rects follow its `scrollTop`. */
function scroller(keys: readonly string[], height: () => number) {
  const element = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(element, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  element.getBoundingClientRect = () => rect(0, 500);
  keys.forEach((key, index) => {
    const row = document.createElement("div");
    row.dataset.timelineKey = key;
    row.getBoundingClientRect = () => rect(index * height() - scrollTop, height());
    element.append(row);
  });
  document.body.append(element);
  return element;
}

describe("scroll anchor", () => {
  it("anchors the first row still visible and puts it back after rows grow", () => {
    let height = 100;
    const element = scroller(["a", "b", "c", "d"], () => height);
    element.scrollTop = 120;
    const snapshot = captureScroll(element, false);
    expect(snapshot).toEqual({ kind: "anchor", key: "b", offset: -20 });
    height = 200;
    restoreScroll(element, snapshot, () => {});
    expect(element.scrollTop).toBe(220);
    // Nothing moved since, so a second restore leaves it.
    restoreScroll(element, snapshot, () => {});
    expect(element.scrollTop).toBe(220);
  });

  it("sends a reader at the bottom back to the bottom", () => {
    const element = scroller(["a"], () => 100);
    const toBottom = vi.fn();
    const snapshot = captureScroll(element, true);
    expect(snapshot).toEqual({ kind: "bottom" });
    restoreScroll(element, snapshot, toBottom);
    expect(toBottom).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a scroller, a visible row, or the anchored row", () => {
    expect(captureScroll(null, false)).toBeNull();
    expect(captureScroll(undefined, true)).toBeNull();
    const empty = scroller([], () => 100);
    expect(captureScroll(empty, false)).toBeNull();

    const element = scroller(["a"], () => 100);
    element.scrollTop = 900;
    expect(captureScroll(element, false)).toBeNull();

    const toBottom = vi.fn();
    restoreScroll(null, { kind: "bottom" }, toBottom);
    restoreScroll(element, null, toBottom);
    restoreScroll(element, { kind: "anchor", key: "gone", offset: 0 }, toBottom);
    expect(toBottom).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(900);
  });
});

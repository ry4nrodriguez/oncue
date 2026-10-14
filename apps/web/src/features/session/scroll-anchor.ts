/**
 * Keeps the reading position when the side panel reflows the timeline.
 * `use-stick-to-bottom` handles only a reader at the bottom; otherwise the
 * first visible row is noted with its offset and restored after the reflow.
 */

export type ScrollSnapshot =
  | { readonly kind: "bottom" }
  | { readonly kind: "anchor"; readonly key: string; readonly offset: number };

const ROW_SELECTOR = "[data-timeline-key]";

/** The reading position before a layout change, or null with nothing to anchor to. */
export function captureScroll(
  scroller: HTMLElement | null | undefined,
  atBottom: boolean,
): ScrollSnapshot | null {
  if (scroller == null) {
    return null;
  }
  if (atBottom) {
    return { kind: "bottom" };
  }
  const top = scroller.getBoundingClientRect().top;
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top) {
      return { kind: "anchor", key: row.dataset.timelineKey ?? "", offset: rect.top - top };
    }
  }
  return null;
}

/**
 * Restores the reading position. If the anchored row is gone (a reconnect can
 * replace the view), the scroll is left alone.
 */
export function restoreScroll(
  scroller: HTMLElement | null | undefined,
  snapshot: ScrollSnapshot | null,
  scrollToBottom: () => void,
): void {
  if (scroller == null || snapshot === null) {
    return;
  }
  if (snapshot.kind === "bottom") {
    scrollToBottom();
    return;
  }
  const row = [...scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)].find(
    (candidate) => candidate.dataset.timelineKey === snapshot.key,
  );
  if (row === undefined) {
    return;
  }
  const drift = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const delta = drift - snapshot.offset;
  if (delta !== 0) {
    scroller.scrollTop += delta;
  }
}

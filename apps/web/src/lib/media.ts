/**
 * `matchMedia` is optional: jsdom omits it, and older embedded webviews do too.
 * A missing media API means "no preference", never a crash.
 */
export function matchesMedia(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(query).matches;
}

export function watchMedia(query: string, onChange: (matches: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const list = window.matchMedia(query);
  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  list.addEventListener("change", handler);
  return () => list.removeEventListener("change", handler);
}

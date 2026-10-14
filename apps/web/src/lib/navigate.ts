/**
 * External navigation goes through this one function so tests can replace
 * it; jsdom does not implement `window.location.assign`.
 */
export function navigateTo(url: string): void {
  window.location.assign(url);
}

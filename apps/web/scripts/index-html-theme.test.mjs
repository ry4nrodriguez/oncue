// @vitest-environment node
/**
 * `index.html` paints the canvas colour and sets `data-theme` before the app
 * loads, so a dark-mode visitor sees no white frame before the loading
 * screen. These hold its two colours to `tokens.css` and its theme choice to
 * what `ThemeProvider` decides (`src/lib/theme.tsx`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const TOKENS = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

function canvasToken(selector) {
  const start = TOKENS.indexOf(`${selector} {`);
  const block = TOKENS.slice(start, TOKENS.indexOf("}", start));
  return block.match(/--canvas:\s*(#[0-9a-f]+);/i)?.[1];
}

function inlineScript() {
  const match = HTML.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error("index.html has no inline theme script");
  }
  return match[1];
}

/** Runs the inline script against a stand-in window and returns the theme it set. */
function themeFor({ stored, systemDark, storageThrows = false, noMatchMedia = false }) {
  const dataset = {};
  const window = {
    localStorage: {
      getItem: (key) => {
        if (storageThrows) {
          throw new Error("blocked");
        }
        return key === "oncue.theme" ? stored : null;
      },
    },
    matchMedia: noMatchMedia
      ? undefined
      : (query) => ({ matches: systemDark && query === "(prefers-color-scheme: dark)" }),
  };
  const document = { documentElement: { dataset } };
  new Function("window", "document", inlineScript())(window, document);
  return dataset.theme;
}

describe("index.html before the app loads", () => {
  it("paints the light and dark canvas colours tokens.css defines", () => {
    const light = HTML.match(/html\s*{[^}]*background-color:\s*(#[0-9a-f]+)/i)?.[1];
    const dark = HTML.match(
      /html\[data-theme="dark"\]\s*{[^}]*background-color:\s*(#[0-9a-f]+)/i,
    )?.[1];
    expect(light).toBe(canvasToken(":root"));
    expect(dark).toBe(canvasToken('[data-theme="dark"]'));
  });

  it("follows the stored preference, else the system, as ThemeProvider does", () => {
    expect(themeFor({ stored: "dark", systemDark: false })).toBe("dark");
    expect(themeFor({ stored: "light", systemDark: true })).toBe("light");
    expect(themeFor({ stored: "system", systemDark: true })).toBe("dark");
    expect(themeFor({ stored: null, systemDark: true })).toBe("dark");
    expect(themeFor({ stored: null, systemDark: false })).toBe("light");
  });

  it("falls back to the system when storage is blocked, and to light with no media API", () => {
    expect(themeFor({ stored: "light", systemDark: true, storageThrows: true })).toBe("dark");
    expect(themeFor({ stored: null, systemDark: true, noMatchMedia: true })).toBe("light");
  });

  it("draws nothing itself: the root is empty until the loading screen mounts", () => {
    expect(HTML).toMatch(/<div id="root"><\/div>/);
  });
});

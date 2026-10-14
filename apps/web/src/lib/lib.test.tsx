import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesMedia, watchMedia } from "./media";
import { ThemeProvider, useTheme } from "./theme";
import { cn } from "./utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function Probe() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="resolved">{resolved}</span>
      <button type="button" onClick={() => setPreference("dark")}>
        dark
      </button>
    </div>
  );
}

describe("media", () => {
  it("reports no preference when matchMedia is missing", () => {
    expect(matchesMedia("(prefers-color-scheme: dark)")).toBe(false);
    expect(watchMedia("(prefers-color-scheme: dark)", () => {})()).toBeUndefined();
  });

  it("reads and watches a query when matchMedia exists", () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const removeEventListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: (_: string, handler: (event: MediaQueryListEvent) => void) =>
          listeners.push(handler),
        removeEventListener,
      })),
    );

    expect(matchesMedia("(prefers-color-scheme: dark)")).toBe(true);

    const seen: boolean[] = [];
    const stop = watchMedia("(prefers-color-scheme: dark)", (value) => seen.push(value));
    listeners[0]?.({ matches: false } as MediaQueryListEvent);
    stop();

    expect(seen).toEqual([false]);
    expect(removeEventListener).toHaveBeenCalled();
  });
});

describe("ThemeProvider", () => {
  it("defaults to following the system and stamps the document", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("preference").textContent).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("remembers an explicit choice", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "dark" }).click();
    });

    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("oncue.theme")).toBe("dark");
  });

  it("restores a stored preference", () => {
    window.localStorage.setItem("oncue.theme", "dark");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("preference").textContent).toBe("dark");
  });

  it("ignores a stored value it does not recognise", () => {
    window.localStorage.setItem("oncue.theme", "chartreuse");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("preference").textContent).toBe("system");
  });

  it("refuses to be used outside the provider", () => {
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
  });
});

describe("cn", () => {
  it("merges conflicting tailwind classes, last one winning", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-text", false, undefined, "font-medium")).toBe("text-text font-medium");
  });
});

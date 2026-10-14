import { createContext, type ReactNode, use, useCallback, useEffect, useState } from "react";
import { matchesMedia, watchMedia } from "./media";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "oncue.theme";

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Private mode and blocked storage both land here; the default is fine.
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return matchesMedia("(prefers-color-scheme: dark)");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStored);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => watchMedia("(prefers-color-scheme: dark)", setSystemDark), []);

  const resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;

  // tokens.css keys off this attribute, so every token switches at once.
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage is a convenience here, never a source of truth.
    }
  }, []);

  return <ThemeContext value={{ preference, resolved, setPreference }}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const value = use(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }
  return value;
}

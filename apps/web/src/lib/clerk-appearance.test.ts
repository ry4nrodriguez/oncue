import { describe, expect, it } from "vitest";
import { CLERK_APPEARANCE } from "./clerk-appearance";

/**
 * The `styles/tokens.css` names the sign-in form may read. Each is defined in
 * both themes there; anything outside this list is a colour the form invented.
 */
const THEME_TOKENS = new Set([
  "--canvas",
  "--surface",
  "--border",
  "--text",
  "--muted",
  "--hover",
  "--positive",
  "--caution",
  "--danger",
]);

/** Every `var(--name)` a value reads, walking nested style objects. */
function varsIn(value: unknown): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1] as string);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(varsIn);
  }
  return [];
}

/** The custom properties the appearance itself declares, such as `--oncue-border`. */
function declaredIn(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) =>
    key.startsWith("--") ? [key, ...declaredIn(inner)] : declaredIn(inner),
  );
}

describe("CLERK_APPEARANCE", () => {
  it("reads only theme tokens and adds no colour of its own", () => {
    const declared = new Set(declaredIn(CLERK_APPEARANCE));
    const read = varsIn(CLERK_APPEARANCE).filter((name) => !declared.has(name));

    expect(read.length).toBeGreaterThan(0);
    expect(read.filter((name) => !THEME_TOKENS.has(name))).toEqual([]);
    expect(JSON.stringify(CLERK_APPEARANCE)).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it("never reads the accent: the composer's send is the one accent in the app", () => {
    expect(varsIn(CLERK_APPEARANCE).some((name) => name.startsWith("--accent"))).toBe(false);
  });

  it("gives the primary and social buttons the neutral bordered chrome, not a fill", () => {
    for (const button of [
      CLERK_APPEARANCE.elements.formButtonPrimary,
      CLERK_APPEARANCE.elements.socialButtonsBlockButton,
    ]) {
      expect(button.backgroundColor).toBe("transparent");
      expect(button.backgroundImage).toBe("none");
      expect(button.boxShadow).toContain("var(--oncue-border)");
      // Clerk's sheen over a solid button, a grey fill on the dark theme.
      expect(button["&::after"].backgroundImage).toMatch(/^none/);
    }
  });

  it("draws no card, border, or shadow around the form", () => {
    const { cardBox, card } = CLERK_APPEARANCE.elements;
    expect(cardBox).toMatchObject({
      boxShadow: "none",
      border: "none",
      backgroundColor: "transparent",
    });
    expect(card).toMatchObject({
      boxShadow: "none",
      border: "none",
      backgroundColor: "transparent",
    });
  });

  /**
   * Clerk sets its own `--border` on its buttons, so the element styles read
   * aliases declared on the root box, where `--border` is still ours.
   */
  it("reads the aliased tokens inside Clerk's elements and declares them on the root box", () => {
    const { rootBox, ...rest } = CLERK_APPEARANCE.elements;
    const readInside = new Set(varsIn(rest));
    for (const name of readInside) {
      expect(name.startsWith("--oncue-")).toBe(true);
      expect(Object.keys(rootBox)).toContain(name);
    }
  });

  it("hides Clerk's heading, so the panel's wordmark is the one place OnCue is named", () => {
    expect(CLERK_APPEARANCE.elements.headerTitle).toEqual({ display: "none" });
  });

  it("turns off Clerk's development-mode strip", () => {
    expect(CLERK_APPEARANCE.options.unsafe_disableDevelopmentModeWarnings).toBe(true);
  });
});

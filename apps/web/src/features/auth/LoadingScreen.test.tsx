import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/lib/theme";
import { LoadingLabel, LoadingScreen } from "./LoadingScreen";

afterEach(cleanup);

describe("LoadingScreen", () => {
  it("announces itself as busy, with the one wordmark and a quiet label", () => {
    render(<LoadingScreen />, { wrapper: ThemeProvider });

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("auth-loading")).toBe(status);
    // The product named once, by the animated wordmark, above the label.
    const marks = screen.getAllByRole("img", { name: "OnCue" });
    expect(marks).toHaveLength(1);
    const label = screen.getByText("Loading");
    expect(marks[0]?.compareDocumentPosition(label)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The product's shimmer, which stands still under reduced motion.
    expect(label.className).toContain("shimmer");
    expect(label.className).toContain("text-muted-foreground");
  });

  it("sits on the page's own background with nothing drawn around it", () => {
    render(<LoadingScreen />, { wrapper: ThemeProvider });
    const status = screen.getByRole("status");
    expect(status.className).toContain("bg-canvas");
    const classes = [...status.querySelectorAll("[class]")]
      .map((element) => element.getAttribute("class") ?? "")
      .join(" ");
    expect(classes).not.toMatch(/\bborder\b|\bshadow-|\bbg-(panel|button|accent)\b/);
  });
});

describe("LoadingLabel", () => {
  it("is the same label, for the sign-in panel while Clerk's form mounts", () => {
    render(<LoadingLabel className="py-2" />);
    const label = screen.getByText("Loading");
    expect(label.className).toContain("shimmer");
    expect(label.className).toContain("py-2");
  });
});

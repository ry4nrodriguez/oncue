import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAUTION_AT,
  ContextMeter,
  ContextMeterAtRest,
  contextLabel,
  DANGER_AT,
} from "./ContextMeter";
import type { ContextMeterView } from "./context-meter";

afterEach(() => {
  cleanup();
});

/** Base UI opens a popover from the pointer sequence, not a bare `click`. */
function pointerClick(element: Element) {
  fireEvent.pointerDown(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}

/** The owner's reference: 623.3k of 1M, most of it conversation. */
const EXACT: ContextMeterView = {
  used: 623_300,
  window: 1_000_000,
  breakdown: {
    kind: "exact",
    categories: [
      { id: "system", label: "System prompt", tokens: 9_400 },
      { id: "tools", label: "Tools", tokens: 20_100 },
      { id: "oncueTools", label: "OnCue tools", tokens: 1_900 },
      { id: "conversation", label: "Conversation", tokens: 591_900 },
    ],
  },
  compactsAt: 968_000,
  costLow: false,
  costUsd: 0.4321,
  costPartial: false,
  costLongContext: false,
  note: null,
};

const EMPTY: ContextMeterView = {
  used: null,
  window: 1_000_000,
  breakdown: { kind: "none" },
  compactsAt: null,
  costLow: false,
  costUsd: null,
  costPartial: false,
  costLongContext: false,
  note: null,
};

async function openPopover(): Promise<HTMLElement> {
  pointerClick(screen.getByTestId("context-meter"));
  return screen.findByTestId("context-meter-popover");
}

describe("the context meter's trigger", () => {
  it("is a button named by its share of the window, showing the percent", () => {
    render(<ContextMeter meter={EXACT} />);
    const gauge = screen.getByRole("button", { name: "Context: 62% of 1M used" });
    expect(gauge.getAttribute("data-percent")).toBe("62");
    expect(gauge.textContent).toBe("62%");
    expect(screen.getByTestId("context-meter-fill").getAttribute("class")).toContain(
      "text-muted-foreground",
    );
  });

  it("names the state before an answer, and without a known window", () => {
    expect(contextLabel(EMPTY)).toBe("Context: no answer yet, 1M window");
    expect(contextLabel({ ...EMPTY, window: null })).toBe("Context: no answer yet");
    expect(contextLabel({ ...EXACT, window: null })).toBe("Context: 623.3k tokens used");
    render(<ContextMeter meter={EMPTY} />);
    expect(screen.queryByTestId("context-meter-fill")).toBeNull();
    expect(screen.getByTestId("context-meter").textContent).toBe("Context");
  });

  it.each([
    [CAUTION_AT, "text-caution"],
    [DANGER_AT, "text-danger"],
  ])("turns the ring to a warning at %i percent", (percent, ring) => {
    render(<ContextMeter meter={{ ...EXACT, used: percent * 10_000 }} />);
    expect(screen.getByTestId("context-meter-fill").getAttribute("class")).toContain(ring);
  });

  it("reads 0% before a chat starts, as a reading with nothing to open", () => {
    render(<ContextMeterAtRest />);
    const gauge = screen.getByRole("img", { name: "Context: 0% used" });
    expect(gauge.textContent).toBe("0%");
    // An empty ring: the track, and no fill.
    expect(gauge.querySelectorAll("circle")).toHaveLength(1);
    expect(screen.queryByTestId("context-meter-fill")).toBeNull();
    expect(gauge.getAttribute("title")).toBe("The context is empty until the first answer");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not open while disabled", async () => {
    render(<ContextMeter meter={EXACT} disabled />);
    pointerClick(screen.getByTestId("context-meter"));
    await waitFor(() => {
      expect(screen.queryByTestId("context-meter-popover")).toBeNull();
    });
  });
});

describe("the popover, collapsed", () => {
  it("gives used / window (percent), one segment per part over the free track, and the cost", async () => {
    render(<ContextMeter meter={EXACT} />);
    const popover = await openPopover();
    expect(popover.getAttribute("aria-label")).toBe("Context window");
    const toggle = within(popover).getByTestId("context-meter-toggle");
    expect(toggle.textContent).toContain("Context window");
    expect(toggle.textContent).toContain("623.3k / 1M (62%)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const segments = within(popover)
      .getByTestId("context-meter-bar")
      .querySelectorAll("[data-segment]");
    expect([...segments].map((segment) => segment.getAttribute("data-segment"))).toEqual([
      "system",
      "tools",
      "oncueTools",
      "conversation",
    ]);
    expect((segments[3] as HTMLElement).className).toContain("bg-meter-conversation");
    expect((segments[3] as HTMLElement).style.width).toBe("59.19%");
    // Mounted but hidden, so the header's aria-controls names a real element.
    const rows = within(popover).getByTestId("context-meter-rows");
    expect(rows.hidden).toBe(true);
    expect(toggle.getAttribute("aria-controls")).toBe(rows.id);
    expect(within(popover).getByTestId("context-meter-cost").textContent).toBe("≈ $0.43");
    expect(popover.textContent).toContain("at list prices");
    expect(within(popover).getByTestId("context-meter-compaction").textContent).toBe(
      "344.7k until auto-compact",
    );
    expect(popover.textContent).not.toMatch(/cache read|plan limit|session tokens/i);
  });
});

describe("the popover, expanded", () => {
  it("lists each part with its colour, tokens, and share of the window, then free space", async () => {
    render(<ContextMeter meter={EXACT} />);
    const popover = await openPopover();
    fireEvent.click(within(popover).getByTestId("context-meter-toggle"));
    expect(within(popover).getByTestId("context-meter-toggle").getAttribute("aria-expanded")).toBe(
      "true",
    );
    const rows = within(popover).getByTestId("context-meter-rows").querySelectorAll("li");
    expect([...rows].map((row) => row.textContent)).toEqual([
      "System prompt9.4k0.9%",
      "Tools20.1k2.0%",
      "OnCue tools1.9k0.2%",
      "Conversation591.9k59.2%",
      "Free space376.7k37.7%",
    ]);
    expect(within(popover).getByTestId("context-meter-row-free").getAttribute("data-value")).toBe(
      "376700",
    );
    fireEvent.click(within(popover).getByTestId("context-meter-toggle"));
    expect(within(popover).getByTestId("context-meter-rows").hidden).toBe(true);
  });

  it("shows the size as one part with free space when there is no breakdown", async () => {
    render(<ContextMeter meter={{ ...EXACT, breakdown: { kind: "pending" }, window: null }} />);
    const popover = await openPopover();
    fireEvent.click(within(popover).getByTestId("context-meter-toggle"));
    const rows = within(popover).getByTestId("context-meter-rows").querySelectorAll("li");
    expect([...rows].map((row) => row.textContent)).toEqual(["Used623.3k"]);
    expect(popover.textContent).toContain("623.3k tokens");
  });
});

describe("the popover's plain lines", () => {
  it.each([
    [{ kind: "pending" } as const, "Breakdown appears after the next answer."],
    [{ kind: "unavailable" } as const, "Breakdown unavailable for now."],
    [
      { kind: "unsupported", provider: "openai" } as const,
      "A breakdown isn't available for this provider.",
    ],
    [{ kind: "none" } as const, "No breakdown for this answer."],
  ])("says why a breakdown is missing: %j", async (breakdown, text) => {
    render(<ContextMeter meter={{ ...EXACT, breakdown }} />);
    const popover = await openPopover();
    expect(within(popover).getByTestId("context-meter-status").textContent).toBe(text);
    expect(
      within(popover).getByTestId("context-meter-bar").querySelector("[data-segment='used']"),
    ).not.toBeNull();
  });

  it("before the first answer: the window alone, no cost, no compaction line", async () => {
    render(<ContextMeter meter={EMPTY} />);
    const popover = await openPopover();
    expect(popover.textContent).toContain("1M window");
    expect(within(popover).getByTestId("context-meter-status").textContent).toBe(
      "Fills once the agent answers in this conversation.",
    );
    expect(within(popover).queryByTestId("context-meter-cost")).toBeNull();
    expect(within(popover).queryByTestId("context-meter-compaction")).toBeNull();
    cleanup();
    render(<ContextMeter meter={{ ...EMPTY, window: null }} />);
    expect((await openPopover()).textContent).not.toContain("window ");
  });

  it("marks a partial or low estimate", async () => {
    render(
      <ContextMeter
        meter={{ ...EXACT, costPartial: true, costLongContext: true, costLow: true }}
      />,
    );
    const popover = await openPopover();
    expect(popover.textContent).toContain("leaving out models without a listed price");
    expect(popover.textContent).toContain("Calls past 272k input tokens cost more");
    expect(popover.textContent).toContain("recorded without cache counts");
  });

  it("never counts below zero to auto-compact", async () => {
    render(<ContextMeter meter={{ ...EXACT, compactsAt: 600_000 }} />);
    const popover = await openPopover();
    expect(within(popover).getByTestId("context-meter-compaction").textContent).toBe(
      "0 until auto-compact",
    );
  });

  it.each([
    [{ kind: "fresh_after_resume" } as const, "started this conversation over from a summary"],
    [
      { kind: "compacted", from: 161_902, to: 32_002 } as const,
      "compacted the conversation, from 161.9k to 32k tokens",
    ],
  ])("notes %j", async (note, text) => {
    render(<ContextMeter meter={{ ...EXACT, note }} />);
    const popover = await openPopover();
    expect(within(popover).getByTestId("context-meter-note").textContent).toContain(text);
  });
});

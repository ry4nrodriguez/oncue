import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupState } from "@/lib/api/setup";
import { ThemeProvider } from "@/lib/theme";
import { HomeScreen } from "./HomeScreen";
import {
  type SessionSummary,
  Sidebar,
  type SidebarGroups,
  syncToTimeline,
  TITLE_SCROLL_DELAY_MS,
  TITLE_SCROLL_MIN_SECONDS,
  TITLE_SCROLL_PX_PER_SECOND,
  titleScrollSeconds,
} from "./Sidebar";
import { MATRIX_PATH, matrixDelayMs, matrixOpacity } from "./status-matrix";
import { ThemeToggle } from "./ThemeToggle";

vi.mock("@clerk/react", async () => (await import("@/test/clerk-stub")).clerkModule());

const { setStubUser, resetStubUser } = await import("@/test/clerk-stub");

afterEach(() => {
  cleanup();
  resetStubUser();
});

const GROUPS: SidebarGroups = {
  pinned: [],
  archived: [],
  active: [
    {
      sessionId: "s1",
      title: "Approve the push",
      activity: { kind: "needs_you" },
      pinned: false,
      archived: false,
      runOpen: false,
    },
    {
      sessionId: "s2",
      title: "Retry budget",
      activity: { kind: "working" },
      pinned: false,
      archived: false,
      runOpen: false,
    },
    {
      sessionId: "s3",
      title: "Fix asset fallback",
      activity: { kind: "idle" },
      pinned: false,
      archived: false,
      runOpen: false,
    },
  ],
};

const READY: SetupState = { kind: "ready", repositories: [], modelConnections: [] };
const READY_WITH_MODEL: SetupState = {
  kind: "ready",
  repositories: [],
  modelConnections: [{ modelConnectionId: "mc_1", label: "claude opus 4.5" }],
};
const CONNECT_GITHUB: SetupState = { kind: "connect_github", installUrl: null };

function withRouter(element: React.ReactElement) {
  const router = createMemoryRouter([{ path: "/", element }], { initialEntries: ["/"] });
  return render(
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>,
  );
}

describe("Sidebar", () => {
  it("groups sessions the way record 13 lists them", () => {
    setStubUser({ username: "octocat" });
    withRouter(
      <Sidebar pinned width={264} groups={GROUPS} onToggle={() => {}} onResizeStart={() => {}} />,
    );

    // Two groups only: no "Needs you", no "Recent".
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.queryByText("Needs you")).toBeNull();
    expect(screen.queryByText("Recent")).toBeNull();
    expect(screen.getByText("Approve the push")).toBeTruthy();
    // The account row reads the signed-in user rather than taking a prop, so
    // this asserts the wiring as well as the grouping.
    expect(screen.getByText("octocat")).toBeTruthy();
  });

  it("shows a row as its mark and title alone, on one line", () => {
    withRouter(
      <Sidebar pinned width={264} groups={GROUPS} onToggle={() => {}} onResizeStart={() => {}} />,
    );

    const row = screen.getByText("Fix asset fallback").closest("a") as HTMLAnchorElement;
    expect(row.textContent).toBe("Fix asset fallback");
    expect(row.children).toHaveLength(2);
    expect(screen.getByText("Fix asset fallback").className).toContain("truncate");
    expect(row.className).not.toContain("flex-col");
  });

  describe("a title that does not fit", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    /** Renders the sidebar and makes the first row's title 300 pixels of text in a 180 pixel box. */
    function withLongTitle() {
      vi.useFakeTimers();
      withRouter(
        <Sidebar pinned width={264} groups={GROUPS} onToggle={() => {}} onResizeStart={() => {}} />,
      );
      const title = screen.getByText("Approve the push");
      expect(title.dataset.testid).toBe("session-title");
      Object.defineProperty(title, "scrollWidth", { value: 300 });
      Object.defineProperty(title, "clientWidth", { value: 180 });
      const row = title.closest("a")?.parentElement as HTMLElement;
      return { title, row };
    }

    it("scrolls to its end once the pointer has rested on the row, and returns when it leaves", () => {
      const { title, row } = withLongTitle();

      fireEvent.mouseEnter(row);
      act(() => {
        vi.advanceTimersByTime(TITLE_SCROLL_DELAY_MS - 1);
      });
      expect(title.style.transform).toBe("");
      expect(title.className).toContain("truncate");

      act(() => {
        vi.advanceTimersByTime(1);
      });
      // What was cut off, slid by a transform at the set speed, with the
      // title at its full width so its end is there to show.
      expect(title.style.transform).toBe("translateX(-120px)");
      expect(title.style.transition).toBe(
        `transform ${120 / TITLE_SCROLL_PX_PER_SECOND}s ease-in-out`,
      );
      expect(title.className).toContain("w-max");
      expect(title.className).not.toContain("truncate");
      // The span around it does the cutting.
      expect(title.parentElement?.className).toContain("overflow-hidden");

      // Leaving resets at once: no transition back.
      fireEvent.mouseLeave(row);
      expect(title.style.transform).toBe("");
      expect(title.style.transition).toBe("");
      expect(title.className).toContain("truncate");
    });

    it("takes longer for a longer title, and never less than a short glide", () => {
      expect(titleScrollSeconds(250)).toBe(250 / TITLE_SCROLL_PX_PER_SECOND);
      expect(titleScrollSeconds(4)).toBe(TITLE_SCROLL_MIN_SECONDS);
    });

    it("stays still when the pointer only passes over", () => {
      const { title, row } = withLongTitle();
      fireEvent.mouseEnter(row);
      act(() => {
        vi.advanceTimersByTime(TITLE_SCROLL_DELAY_MS - 1);
      });
      fireEvent.mouseLeave(row);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(title.style.transform).toBe("");
    });

    it("stays still for a reader who asked for less motion", () => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      const { title, row } = withLongTitle();
      fireEvent.mouseEnter(row);
      act(() => {
        vi.advanceTimersByTime(TITLE_SCROLL_DELAY_MS);
      });
      expect(title.style.transform).toBe("");
    });

    it("leaves a title that fits where it is", () => {
      vi.useFakeTimers();
      withRouter(
        <Sidebar pinned width={264} groups={GROUPS} onToggle={() => {}} onResizeStart={() => {}} />,
      );
      const title = screen.getByText("Retry budget");
      fireEvent.mouseEnter(title.closest("a")?.parentElement as HTMLElement);
      act(() => {
        vi.advanceTimersByTime(TITLE_SCROLL_DELAY_MS);
      });
      expect(title.style.transform).toBe("");
    });
  });

  it("an unpinned sidebar stays revealed while its theme menu is open", async () => {
    const view = withRouter(
      <ThemeProvider>
        <Sidebar pinned width={264} groups={GROUPS} onToggle={() => {}} onResizeStart={() => {}} />
      </ThemeProvider>,
    );
    // Pinned, it is revealed whatever the menus do.
    expect(screen.getByTestId("sidebar").dataset.revealed).toBe("true");
    view.unmount();

    withRouter(
      <ThemeProvider>
        <Sidebar
          pinned={false}
          width={264}
          groups={GROUPS}
          onToggle={() => {}}
          onResizeStart={() => {}}
        />
      </ThemeProvider>,
    );
    const unpinned = screen.getByTestId("sidebar");
    expect(unpinned.dataset.revealed).toBeUndefined();
    fireEvent.mouseDown(screen.getByTestId("theme-toggle"), { detail: 1 });
    await screen.findByRole("menu");
    await waitFor(() => expect(unpinned.dataset.revealed).toBe("true"));
    expect(unpinned.className.split(" ")).toContain("translate-x-0");
  });

  it("gives every row one slot: a dot matrix for working, yellow for needs you, blue for finished, nothing otherwise", () => {
    withRouter(
      <Sidebar
        pinned
        width={264}
        groups={{
          ...GROUPS,
          active: [
            ...GROUPS.active,
            {
              sessionId: "s4",
              title: "Ship the fix",
              activity: { kind: "finished", outcome: "verified" },
              pinned: false,
              archived: false,
              runOpen: false,
            },
          ],
        }}
        onToggle={() => {}}
        onResizeStart={() => {}}
      />,
    );

    const rowOf = (title: string) => screen.getByText(title).closest("a") as HTMLAnchorElement;
    const dotIn = (title: string) =>
      rowOf(title).querySelector("[data-testid='session-status-dot']");

    // Needs you and finished are solid dots, each its own colour.
    const needsYou = screen.getByRole("img", { name: "Needs you" });
    expect(needsYou).toBe(dotIn("Approve the push"));
    const finished = screen.getByRole("img", { name: "Verified, not opened yet" });
    expect(finished).toBe(dotIn("Ship the fix"));
    expect(needsYou.className).toContain("bg-attention");
    expect(finished.className).toContain("bg-finished");
    for (const dot of [needsYou, finished]) {
      expect(dot.className).toContain("rounded-full");
      expect(dot.childElementCount).toBe(0);
    }

    // Working is the grey matrix: a still centre and the eight outer dots,
    // each at its place in the cycle and resting on the first frame.
    const working = screen.getByRole("img", { name: "Working" });
    expect(working).toBe(dotIn("Retry budget"));
    expect(working.className).toContain("text-faint");
    expect(working.className).not.toContain("bg-");
    expect(working.querySelectorAll("circle")).toHaveLength(MATRIX_PATH.length + 1);
    // The matrix is drawn a pixel past its slot on every side.
    expect(working.querySelector("svg")?.getAttribute("class")).toBe("-m-px block size-2.5");
    const moving = [...working.querySelectorAll<SVGCircleElement>("circle.status-matrix-dot")];
    expect(moving).toHaveLength(MATRIX_PATH.length);
    expect(moving.map((dot) => dot.style.animationDelay)).toEqual(
      MATRIX_PATH.map((_, index) => `${matrixDelayMs(index)}ms`),
    );
    expect(moving.map((dot) => Number(dot.style.opacity))).toEqual(
      MATRIX_PATH.map((_, index) => matrixOpacity(index, 0)),
    );
    expect(
      new Set(moving.map((dot) => `${dot.getAttribute("cx")},${dot.getAttribute("cy")}`)).size,
    ).toBe(MATRIX_PATH.length);

    // Every other row draws nothing, and its empty slot is silent to a screen reader.
    const idle = dotIn("Fix asset fallback") as HTMLElement;
    expect(idle.dataset.activity).toBe("idle");
    expect(idle.getAttribute("aria-hidden")).toBe("true");
    expect(idle.childElementCount).toBe(0);
    expect(idle.className).not.toMatch(/\b(bg|border)-/);

    // One size for every slot, so the titles line up.
    for (const dot of [needsYou, finished, working, idle]) {
      expect(dot.className).toContain("size-2");
    }
  });

  it("pins a moved mark's animations to the page clock, so a re-sort never restarts its matrix", () => {
    const restarted = { startTime: 1234 as number | null };
    const inStep = { startTime: 0 as number | null };
    const asked: unknown[] = [];
    const element = {
      getAnimations: (options: unknown) => {
        asked.push(options);
        return [restarted, inStep];
      },
    } as unknown as Element;
    syncToTimeline(element);
    expect(restarted.startTime).toBe(0);
    expect(inStep.startTime).toBe(0);
    // The animations belong to the matrix's dots, inside the mark.
    expect(asked).toEqual([{ subtree: true }]);
    // Nothing to do without an element, or where the browser has no Web Animations.
    expect(() => syncToTimeline(null)).not.toThrow();
    expect(() => syncToTimeline({} as Element)).not.toThrow();
  });

  it("highlights the session on screen and marks it current", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/sessions/:sessionId",
          element: (
            <Sidebar
              pinned
              width={264}
              groups={GROUPS}
              onToggle={() => {}}
              onResizeStart={() => {}}
            />
          ),
        },
      ],
      { initialEntries: ["/sessions/s2"] },
    );
    render(
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>,
    );
    const current = screen.getByText("Retry budget").closest("a") as HTMLAnchorElement;
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.className.split(" ")).toContain("bg-hover-strong");
    const other = screen.getByText("Fix asset fallback").closest("a") as HTMLAnchorElement;
    expect(other.getAttribute("aria-current")).toBeNull();
    expect(other.className.split(" ")).not.toContain("bg-hover");
  });

  it("offers a pin on each row, and Unpin on a pinned one", () => {
    const onTogglePin = vi.fn();
    withRouter(
      <Sidebar
        pinned
        width={264}
        groups={{
          ...GROUPS,
          pinned: [{ ...(GROUPS.active[0] as SessionSummary), sessionId: "p1", pinned: true }],
        }}
        onToggle={() => {}}
        onResizeStart={() => {}}
        onTogglePin={onTogglePin}
      />,
    );
    // Pinned sits first, above Active; there is no other group.
    const labels = screen.getAllByRole("button", { name: /^(Pinned|Needs you|Active|Recent)$/ });
    expect(labels.map((label) => label.textContent)).toEqual(["Pinned", "Active"]);

    // Each row carries its own pin; a pinned row's is pressed and reads Unpin.
    const pins = screen.getAllByRole("button", { name: "Pin chat" });
    const fixAsset = pins.find((pin) =>
      pin.parentElement?.textContent?.includes("Fix asset fallback"),
    ) as HTMLElement;
    expect(fixAsset.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(fixAsset);
    expect(onTogglePin).toHaveBeenCalledWith("s3");

    const unpin = screen.getByRole("button", { name: "Unpin chat" });
    expect(unpin.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(unpin);
    expect(onTogglePin).toHaveBeenLastCalledWith("p1");
  });

  it("offers no pin when nothing can remember one", () => {
    withRouter(
      <Sidebar pinned width={264} groups={GROUPS} onToggle={() => {}} onResizeStart={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: /pin chat/i })).toBeNull();
    expect(screen.queryByText("Pinned")).toBeNull();
  });

  it("hides a group that has no sessions", () => {
    withRouter(
      <Sidebar
        pinned
        width={264}
        groups={{ pinned: [], active: GROUPS.active, archived: [] }}
        onToggle={() => {}}
        onResizeStart={() => {}}
      />,
    );

    expect(screen.queryByText("Pinned")).toBeNull();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("collapses a group", () => {
    withRouter(
      <Sidebar pinned width={264} groups={GROUPS} onToggle={() => {}} onResizeStart={() => {}} />,
    );

    fireEvent.click(screen.getByText("Active"));

    expect(screen.queryByText("Retry budget")).toBeNull();
  });

  it("reports the pin toggle", () => {
    const onToggle = vi.fn();
    withRouter(
      <Sidebar
        pinned={false}
        width={264}
        groups={GROUPS}
        onToggle={onToggle}
        onResizeStart={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText("Pin sidebar open"));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("starts a resize from the right edge", () => {
    const onResizeStart = vi.fn();
    withRouter(
      <Sidebar
        pinned
        width={264}
        groups={GROUPS}
        onToggle={() => {}}
        onResizeStart={onResizeStart}
      />,
    );

    fireEvent.mouseDown(screen.getByLabelText("Resize sidebar"));

    expect(onResizeStart).toHaveBeenCalledTimes(1);
  });
});

function withHomeRouter(element: React.ReactElement) {
  const router = createMemoryRouter(
    [
      { path: "/", element },
      { path: "/setup", element: <p>setup</p> },
    ],
    { initialEntries: ["/"] },
  );
  return render(
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>,
  );
}

describe("HomeScreen", () => {
  it("shows no guidance line once both setup steps are done", () => {
    withHomeRouter(<HomeScreen setup={READY_WITH_MODEL} />);

    expect(screen.getByLabelText<HTMLTextAreaElement>("Message").disabled).toBe(false);
    expect(screen.queryByRole("link", { name: "Finish setup" })).toBeNull();
  });

  it("guides toward the model step while the composer stays enabled", () => {
    withHomeRouter(<HomeScreen setup={READY} />);

    // Record 13 makes the model key skippable, so this guides without disabling the composer.
    expect(screen.getByLabelText<HTMLTextAreaElement>("Message").disabled).toBe(false);
    expect(screen.getByTestId("home-guidance").textContent).toContain("model connection");
    expect(screen.getByRole("link", { name: "Finish setup" }).getAttribute("href")).toBe("/setup");
  });

  it("defaults to ready when no setup prop is given", () => {
    withHomeRouter(<HomeScreen />);

    expect(screen.getByLabelText<HTMLTextAreaElement>("Message").disabled).toBe(false);
  });

  it("keeps the composer enabled but links to /setup when GitHub is not connected", () => {
    withHomeRouter(<HomeScreen setup={CONNECT_GITHUB} />);

    expect(screen.getByLabelText<HTMLTextAreaElement>("Message").disabled).toBe(false);
    const link = screen.getByRole("link", { name: "Finish setup" });
    expect(link.getAttribute("href")).toBe("/setup");
  });

  describe("a model key that stopped working", () => {
    const rejected = (activeSessions: number, extra: Partial<SetupState> = {}): SetupState =>
      ({
        ...READY_WITH_MODEL,
        inactiveModelConnections: [
          { modelConnectionId: "mc_bad", provider: "openai", status: "invalid", activeSessions },
        ],
        ...extra,
      }) as SetupState;

    it.each([
      [
        2,
        "The OpenAI key was rejected. 2 active sessions use it and can't continue until the key is replaced. Replace the key",
      ],
      [
        1,
        "The OpenAI key was rejected. 1 active session uses it and can't continue until the key is replaced. Replace the key",
      ],
      [0, "The OpenAI key was rejected. No active session uses it. Replace the key"],
    ])(
      "names the provider and the %i sessions on it, with a link to Model providers",
      (count, text) => {
        withHomeRouter(<HomeScreen setup={rejected(count)} />);

        const banner = screen.getByTestId("home-key-banner");
        expect(banner.textContent).toBe(text);
        expect(
          within(banner).getByRole("link", { name: "Replace the key" }).getAttribute("href"),
        ).toBe("/settings/model-providers");
        // The composer still works on the keys that do.
        expect(screen.getByLabelText<HTMLTextAreaElement>("Message").disabled).toBe(false);
      },
    );

    it("shows no banner while every key works", () => {
      withHomeRouter(<HomeScreen setup={READY_WITH_MODEL} />);
      expect(screen.queryByTestId("home-key-banner")).toBeNull();
    });

    it("names each key when more than one stopped working", () => {
      withHomeRouter(
        <HomeScreen
          setup={{
            ...READY,
            inactiveModelConnections: [
              {
                modelConnectionId: "a",
                provider: "anthropic",
                status: "expired",
                activeSessions: 0,
              },
              {
                modelConnectionId: "b",
                provider: "openai",
                status: "attention_required",
                activeSessions: 3,
              },
            ],
          }}
        />,
      );
      expect(screen.getAllByTestId("home-key-banner").map((banner) => banner.textContent)).toEqual([
        "The Anthropic key has expired. No active session uses it. Replace the key",
        "The OpenAI key needs attention. 3 active sessions use it and can't continue until the key is replaced. Replace the key",
      ]);
    });

    // The setup step would refuse a second key for the provider, so it is not where to go.
    it("replaces the add-a-model guidance when the only key is the one that stopped working", () => {
      withHomeRouter(
        <HomeScreen
          setup={{
            ...READY,
            inactiveModelConnections: [
              { modelConnectionId: "b", provider: "openai", status: "invalid", activeSessions: 1 },
            ],
          }}
        />,
      );
      expect(screen.getByTestId("home-key-banner")).toBeTruthy();
      expect(screen.queryByTestId("home-guidance")).toBeNull();
      expect(screen.queryByRole("link", { name: "Finish setup" })).toBeNull();
    });

    it("lists the rejected key's models in the picker with Replace, not Connect", async () => {
      const catalogRow = {
        modelId: "gpt-6-sol",
        name: "GPT-6 Sol",
        contextWindow: 400_000,
        effort: null,
        defaultEffort: null,
        price: { inputPerMTok: 1, outputPerMTok: 2 },
        status: "current" as const,
        recommended: true,
      };
      withHomeRouter(
        <HomeScreen
          setup={rejected(1, { catalog: { anthropic: [], openai: [catalogRow] } } as never)}
          selectedModelConnectionId="mc_1"
          // Home's picker offers a choice only when it has somewhere to report one.
          onSelectModelConnection={() => {}}
          onSelectModel={() => {}}
        />,
      );
      fireEvent.click(screen.getByTestId("agent-chip"));
      const panel = within(await screen.findByTestId("agent-panel"));
      const row = panel.getByTestId("model-replace-gpt-6-sol");
      expect(row.textContent).toBe("GPT-6 SolKey rejectedReplace");
      expect(row.getAttribute("href")).toBe("/settings/model-providers");
    });
  });

  /** A refused submit says why, in the Worker's words, rather than going quiet. */
  it("shows the notice for a submit the control plane declined", () => {
    withHomeRouter(<HomeScreen setup={READY} notice="Connect your Modal account first." />);
    const notice = screen.getByTestId("home-notice");
    expect(notice.textContent).toContain("Connect your Modal account first.");
    expect(notice.getAttribute("role")).toBe("status");
  });

  it("shows the context gauge at 0% under the box, across from the approvals picker", () => {
    withHomeRouter(<HomeScreen setup={READY} approvalMode="ask" />);
    const below = screen.getByTestId("composer-below");
    const gauge = within(below).getByRole("img", { name: "Context: 0% used" });
    expect(gauge.textContent).toBe("0%");
    // The approvals picker first, the gauge last.
    expect(below.firstElementChild?.contains(gauge)).toBe(false);
    expect(below.lastElementChild?.contains(gauge)).toBe(true);
    cleanup();

    // It is there before setup is finished too, and with no approvals picker.
    withHomeRouter(
      <HomeScreen setup={{ kind: "ready", repositories: [], modelConnections: [] }} />,
    );
    expect(screen.getByTestId("context-meter-at-rest")).toBeTruthy();
  });

  it("links a notice about a model key to where keys are managed", () => {
    withHomeRouter(
      <HomeScreen setup={READY} notice="OpenAI rejected this key." noticeModelKeys={true} />,
    );
    const link = within(screen.getByTestId("home-notice")).getByRole("link", {
      name: "Open Model providers",
    });
    expect(link.getAttribute("href")).toBe("/settings/model-providers");
    cleanup();

    withHomeRouter(<HomeScreen setup={READY} notice="Connect your Modal account first." />);
    expect(screen.queryByTestId("home-notice-model-keys")).toBeNull();
  });

  it("shows no notice by default", () => {
    withHomeRouter(<HomeScreen setup={READY} />);
    expect(screen.queryByTestId("home-notice")).toBeNull();
  });

  it("submits through onSubmit and reports acceptance", async () => {
    const onSubmit = vi.fn(async (_text: string, _commandId: string) => true);
    withHomeRouter(<HomeScreen setup={READY} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Do the thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toBe("Do the thing");
  });
});

describe("ThemeToggle", () => {
  function withTheme() {
    return render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
  }

  it("labels the trigger with the current preference", () => {
    window.localStorage.setItem("oncue.theme", "dark");
    withTheme();

    expect(screen.getByTestId("theme-toggle").getAttribute("aria-label")).toBe("Theme: Dark");
  });

  it("falls back to System when nothing is stored", () => {
    window.localStorage.removeItem("oncue.theme");
    withTheme();

    expect(screen.getByTestId("theme-toggle").getAttribute("aria-label")).toBe("Theme: System");
  });

  it("offers all three preferences and applies the one chosen", async () => {
    window.localStorage.setItem("oncue.theme", "system");
    withTheme();

    fireEvent.click(screen.getByTestId("theme-toggle"));

    const light = await screen.findByRole("menuitemradio", { name: /Light/ });
    expect(screen.getByRole("menuitemradio", { name: /Dark/ })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /System/ })).toBeTruthy();

    fireEvent.click(light);

    await waitFor(() => expect(window.localStorage.getItem("oncue.theme")).toBe("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

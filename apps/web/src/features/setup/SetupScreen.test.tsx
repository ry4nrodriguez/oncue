import { cleanup, fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUP } from "@/components/ui/button-classes";
import { ThemeProvider } from "@/lib/theme";

// The panel's animated wordmark reads the theme, which `main.tsx` provides.
function render(ui: ReactElement) {
  return renderBare(ui, { wrapper: ThemeProvider });
}

vi.mock("@clerk/react", () => ({
  SignOutButton: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/lib/navigate", () => ({
  navigateTo: vi.fn(),
}));

const { SetupScreen } = await import("./SetupScreen");

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SetupScreen", () => {
  it("renders the connect-GitHub card with a working install link", () => {
    render(
      <SetupScreen
        screen={{ kind: "connect_github", installUrl: "https://github.com/apps/oncue" }}
        onRetry={() => {}}
        onSkip={() => {}}
      />,
    );

    expect(screen.getByText("Give OnCue access to your repositories")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Install the OnCue GitHub App/ });
    expect(link.getAttribute("href")).toBe("https://github.com/apps/oncue");
    // Record 13's copy requirement: repository access is a separate grant.
    expect(screen.getByText(/Repository access is separate from signing in/)).toBeTruthy();
  });

  it("mints an install URL and navigates when there is no installUrl yet", async () => {
    const { navigateTo } = await import("@/lib/navigate");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        return jsonResponse(201, { installUrl: "https://github.com/apps/oncue" });
      }),
    );

    render(
      <SetupScreen
        screen={{ kind: "connect_github", installUrl: null }}
        onRetry={() => {}}
        onSkip={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Install the OnCue GitHub App/ }));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("https://github.com/apps/oncue"));
  });

  it("shows a plain sentence when GitHub isn't configured for this deployment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(503, { error: "github_unconfigured" })),
    );

    render(
      <SetupScreen
        screen={{ kind: "connect_github", installUrl: null }}
        onRetry={() => {}}
        onSkip={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Install the OnCue GitHub App/ }));

    await waitFor(() =>
      expect(screen.getByText("GitHub is not configured for this deployment.")).toBeTruthy(),
    );
  });

  it.each([
    ["cancelled", "The installation wasn't completed", "Try again"],
    ["no_repositories", "No repositories were selected", "Choose repositories on GitHub"],
    ["pending_approval", "Waiting on an organization admin", "Recheck"],
  ] as const)("renders the %s stuck screen with its title and action", (reason, title, action) => {
    render(
      <SetupScreen
        screen={{ kind: "github_stuck", reason }}
        onRetry={() => {}}
        onSkip={() => {}}
      />,
    );

    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(action) })).toBeTruthy();
  });

  it("retries from the stuck screen's action button", () => {
    const onRetry = vi.fn();
    render(
      <SetupScreen
        screen={{ kind: "github_stuck", reason: "cancelled" }}
        onRetry={onRetry}
        onSkip={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers sign-out on the stuck screen", () => {
    render(
      <SetupScreen
        screen={{ kind: "github_stuck", reason: "cancelled" }}
        onRetry={() => {}}
        onSkip={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("renders the add-model card with a children slot and reports Skip for now", () => {
    const onSkip = vi.fn();
    render(
      <SetupScreen screen={{ kind: "add_model" }} onRetry={() => {}} onSkip={onSkip}>
        <p data-testid="model-form-slot">The model form</p>
      </SetupScreen>,
    );

    expect(screen.getByText("Add a model key")).toBeTruthy();
    expect(screen.getByTestId("model-form-slot")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("renders the connect-Modal card with a children slot and no way to skip", () => {
    render(
      <SetupScreen screen={{ kind: "connect_modal" }} onRetry={() => {}} onSkip={() => {}}>
        <p data-testid="modal-form-slot">The Modal form</p>
      </SetupScreen>,
    );

    expect(screen.getByText("Connect your Modal account")).toBeTruthy();
    expect(screen.getByTestId("modal-form-slot")).toBeTruthy();
    // Mandatory: no session can run without sandbox compute.
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("numbers the three steps in the order they are asked for", () => {
    const { rerender } = render(
      <SetupScreen
        screen={{ kind: "connect_github", installUrl: "https://github.com/x" }}
        onRetry={() => {}}
        onSkip={() => {}}
      />,
    );
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();

    rerender(<SetupScreen screen={{ kind: "add_model" }} onRetry={() => {}} onSkip={() => {}} />);
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();

    rerender(
      <SetupScreen screen={{ kind: "connect_modal" }} onRetry={() => {}} onSkip={() => {}} />,
    );
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
  });

  it("says on the admin-approval screen that the person cannot resolve it themselves", () => {
    render(
      <SetupScreen
        screen={{ kind: "github_stuck", reason: "pending_approval" }}
        onRetry={() => {}}
        onSkip={() => {}}
      />,
    );

    // Record 13, "Failure states".
    expect(screen.getByText(/You can't approve it yourself/)).toBeTruthy();
  });

  it("marks the no-repositories action as leaving for GitHub, and only that one", () => {
    const { rerender } = render(
      <SetupScreen
        screen={{ kind: "github_stuck", reason: "no_repositories" }}
        onRetry={() => {}}
        onSkip={() => {}}
      />,
    );
    const external = screen.getByRole("button", { name: /Choose repositories on GitHub/ });
    expect(external.querySelector("svg")).not.toBeNull();

    rerender(
      <SetupScreen
        screen={{ kind: "github_stuck", reason: "cancelled" }}
        onRetry={() => {}}
        onSkip={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Try again" }).querySelector("svg")).toBeNull();
  });

  // Record 13's visual language: no filled panel or shadow, and no accent or dark fill on any control.
  it.each([
    { kind: "connect_github", installUrl: "https://github.com/apps/oncue" },
    { kind: "connect_github", installUrl: null },
    { kind: "github_stuck", reason: "cancelled" },
    { kind: "github_stuck", reason: "no_repositories" },
    { kind: "github_stuck", reason: "pending_approval" },
    { kind: "add_model" },
    { kind: "connect_modal" },
  ] as const)("draws no filled card and no accent button for %o", (setupScreen) => {
    const { container } = render(
      <SetupScreen screen={setupScreen} onRetry={() => {}} onSkip={() => {}} />,
    );

    const classes = [...container.querySelectorAll("[class]")]
      .map((element) => element.getAttribute("class") ?? "")
      .join(" ");
    expect(classes).not.toMatch(/\bbg-(panel|button|accent|primary)\b/);
    expect(classes).not.toMatch(/\bshadow-/);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    // One bordered panel, with the product named once by the wordmark.
    const panel = screen.getByTestId("auth-panel");
    expect(panel.className).toContain(GROUP);
    const marks = screen.getAllByRole("img", { name: "OnCue" });
    expect(marks).toHaveLength(1);
    expect(panel.firstElementChild).toBe(marks[0]);
  });

  it("renders nothing for home, since the caller navigates away before this point", () => {
    const { container } = render(
      <SetupScreen screen={{ kind: "home" }} onRetry={() => {}} onSkip={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });
});

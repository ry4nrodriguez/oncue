import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthGateIdentity } from "./features/auth/AuthGate";

// The setup route and sidebar use Clerk, so the package is stubbed (`src/test/clerk-stub`).
vi.mock("@clerk/react", async () => (await import("@/test/clerk-stub")).clerkModule());

const { IdentityContext } = await import("./features/auth/AuthGate");
const { ThemeProvider } = await import("./lib/theme");
const { routes } = await import("./routes/routes");

const READY_IDENTITY: AuthGateIdentity = {
  userId: "usr_1",
  workspaceId: "wsp_1",
  setup: {
    kind: "ready",
    repositories: [],
    modelConnections: [{ modelConnectionId: "m1", label: "Anthropic" }],
  },
  revision: 1,
  revalidate: async () => {},
};

const NEEDS_SETUP_IDENTITY = {
  ...READY_IDENTITY,
  setup: { kind: "connect_github" as const, installUrl: null },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function sessionListCalls(): number {
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.filter((call) => String(call[0]).includes("/api/sessions")).length;
}

function renderAt(path: string, identity = READY_IDENTITY) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <ThemeProvider>
      <IdentityContext value={identity}>
        <RouterProvider router={router} />
      </IdentityContext>
    </ThemeProvider>,
  );
}

describe("routes", () => {
  it("renders the home composer at the root", () => {
    renderAt("/");

    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.getByTestId("sidebar")).toBeTruthy();
  });

  it("renders the not-found screen for an unknown path", () => {
    renderAt("/nope");

    expect(screen.getByTestId("session-not-found")).toBeTruthy();
  });

  it("opens settings on the profile section", async () => {
    renderAt("/settings");

    // `/settings` has no content of its own; it redirects to the first section.
    expect(await screen.findByRole("heading", { name: "Profile" })).toBeTruthy();
  });

  it("applies the resolved theme to the document", () => {
    renderAt("/");

    expect(["light", "dark"]).toContain(document.documentElement.dataset.theme);
  });

  it("redirects /setup to home once setup is already complete", () => {
    renderAt("/setup");

    expect(screen.getByLabelText("Message")).toBeTruthy();
  });

  it("renders the setup flow at /setup when setup is not complete", () => {
    renderAt("/setup", NEEDS_SETUP_IDENTITY);

    expect(screen.getByText("Give OnCue access to your repositories")).toBeTruthy();
  });

  it("lists sessions once per identity revision rather than once per render", async () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    const tree = (identity: AuthGateIdentity) => (
      <ThemeProvider>
        <IdentityContext value={identity}>
          <RouterProvider router={router} />
        </IdentityContext>
      </ThemeProvider>
    );
    const { rerender } = render(tree(READY_IDENTITY));
    await waitFor(() => expect(sessionListCalls()).toBe(1));

    // Every AuthGate render makes a fresh identity object with the same revision; it must not refetch.
    rerender(tree({ ...READY_IDENTITY }));
    await waitFor(() => expect(sessionListCalls()).toBe(1));

    rerender(tree({ ...READY_IDENTITY, revision: 2 }));
    await waitFor(() => expect(sessionListCalls()).toBe(2));
  });
});

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthGateIdentity } from "@/features/auth/AuthGate";

vi.mock("@clerk/react", async () => (await import("@/test/clerk-stub")).clerkModule());

const { IdentityContext } = await import("@/features/auth/AuthGate");
const { ThemeProvider } = await import("@/lib/theme");
const { routes } = await import("@/routes/routes");
const { setStubUser, resetStubUser } = await import("@/test/clerk-stub");
const { initialsOf, displayNameFrom } = await import("@/features/auth/profile");

const READY: AuthGateIdentity = {
  userId: "usr_1",
  workspaceId: "wsp_1",
  setup: {
    kind: "ready",
    repositories: [{ repositoryConnectionId: "rc_1", fullName: "acme/first" }],
    modelConnections: [{ modelConnectionId: "mc_1", label: "Anthropic" }],
  },
  revision: 1,
  revalidate: vi.fn(async () => {}),
};

afterEach(() => {
  cleanup();
  resetStubUser();
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ sessions: [], repositories: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <ThemeProvider>
      <IdentityContext.Provider value={READY}>
        <RouterProvider router={router} />
      </IdentityContext.Provider>
    </ThemeProvider>,
  );
  return router;
}

describe("settings navigation", () => {
  it("offers Profile, Repositories, Model providers, Harnesses, Agent permissions, and Modal, and nothing else", async () => {
    renderAt("/settings/profile");

    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    const links = within(nav).getAllByRole("link");
    // "Back" leads; the connections follow the setup order, with Harnesses
    // beside the keys it depends on.
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      "Back",
      "Profile",
      "Repositories",
      "Model providers",
      "Harnesses",
      "Agent permissions",
      "Modal",
    ]);
  });

  it("keeps the old model connections path working, landing on Model providers", async () => {
    renderAt("/model-connections");

    expect(await screen.findByRole("heading", { name: "Model providers" })).not.toBeNull();
  });

  // Settings replaces the shell, so the session sidebar must not render.
  it("replaces the app shell rather than sitting beside it", async () => {
    renderAt("/settings/profile");

    await screen.findByRole("navigation", { name: "Settings sections" });
    expect(screen.queryByRole("link", { name: "New session" })).toBeNull();
    expect(screen.queryByRole("button", { name: /sidebar/i })).toBeNull();
  });

  it("leads back to the app", async () => {
    const router = renderAt("/settings/profile");

    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    within(nav).getByRole("link", { name: "Back" }).click();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
  });

  it("lands on Profile, because /settings has no content of its own", async () => {
    const router = renderAt("/settings");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/profile");
    });
  });

  // The Worker's GitHub install callback lands on `/repositories`, so it must redirect.
  it("keeps the old repositories path working", async () => {
    const router = renderAt("/repositories");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/repositories");
    });
  });

  it("marks the section you are on", async () => {
    renderAt("/settings/repositories");

    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    const current = within(nav)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent?.trim())).toEqual(["Repositories"]);
  });
});

describe("profile section", () => {
  it("shows the signed-in user's details", async () => {
    setStubUser({
      fullName: "Grace Hopper",
      username: "ghopper",
      primaryEmailAddress: { emailAddress: "grace@example.com" },
      externalAccounts: [{ provider: "github" }],
    });
    renderAt("/settings/profile");

    expect(await screen.findByRole("heading", { name: "Profile" })).toBeTruthy();
    expect(screen.getAllByText("Grace Hopper").length).toBeGreaterThan(0);
    expect(screen.getByText("ghopper")).toBeTruthy();
    expect(screen.getAllByText("grace@example.com").length).toBeGreaterThan(0);
    // The provider is named rather than shown as a slug.
    expect(screen.getByText("GitHub")).toBeTruthy();
  });

  it("says a field is unset rather than leaving it blank", async () => {
    setStubUser({ fullName: "Grace Hopper" });
    renderAt("/settings/profile");

    await screen.findByRole("heading", { name: "Profile" });
    // Username and email are both missing.
    expect(screen.getAllByText("Not set")).toHaveLength(2);
    // "Email" appears twice with no provider connected: once as the row's
    // label, and once as how they signed in.
    expect(screen.getAllByText("Email")).toHaveLength(2);
  });
});

describe("displayNameFrom", () => {
  it("prefers a full name", () => {
    expect(displayNameFrom("Grace Hopper", "ghop", "g@example.com")).toBe("Grace Hopper");
  });

  it("falls back to the username, then the email local part", () => {
    expect(displayNameFrom(null, "ghop", "g@example.com")).toBe("ghop");
    expect(displayNameFrom(null, null, "grace@example.com")).toBe("grace");
  });

  it("is never blank, because an empty row reads as broken", () => {
    expect(displayNameFrom(null, null, null)).toBe("You");
    expect(displayNameFrom("   ", "  ", "")).toBe("You");
  });
});

describe("initialsOf", () => {
  it("takes the first and last words", () => {
    expect(initialsOf("Grace Hopper")).toBe("GH");
    expect(initialsOf("Ada Byron Lovelace")).toBe("AL");
  });

  it("takes one letter from a single word", () => {
    expect(initialsOf("ghopper")).toBe("G");
  });

  it("never returns nothing", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });
});

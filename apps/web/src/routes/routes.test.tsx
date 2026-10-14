import { makeCommittedEvent, testModelRecord } from "@oncue/protocol/testing";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthGateIdentity, IdentityContext } from "@/features/auth/AuthGate";
import { forgetBranchListings } from "@/features/repositories/BranchPicker";
import { forgetSecretRequests } from "@/features/secrets/secret-requests-cache";
import type { SetupState } from "@/lib/api/setup";
import { ThemeProvider } from "@/lib/theme";
import { routes } from "./routes";

vi.mock("@clerk/react", async () => (await import("@/test/clerk-stub")).clerkModule());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  FakeSessionSocket.last = null;
});

beforeEach(() => {
  // Home reads a repository's declaration ahead of the send and keeps it; each test starts with none kept.
  forgetSecretRequests();
  forgetBranchListings();
  // The skipped model step is remembered per tab, so clear it between tests.
  window.sessionStorage.clear();
  // Every shell route lists sessions on mount; an empty list keeps these tests about the gate.
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
});

function renderAt(
  path: string,
  setup: SetupState,
  revalidate: AuthGateIdentity["revalidate"] = vi.fn(async () => {}),
) {
  const identity: AuthGateIdentity = {
    userId: "user_1",
    workspaceId: "ws_1",
    setup,
    revision: 1,
    revalidate,
  };
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <ThemeProvider>
      <IdentityContext.Provider value={identity}>
        <RouterProvider router={router} />
      </IdentityContext.Provider>
    </ThemeProvider>,
  );
  return router;
}

const READY: SetupState = {
  kind: "ready",
  repositories: [{ repositoryConnectionId: "rc_1", fullName: "acme/first" }],
  modelConnections: [{ modelConnectionId: "mc_1", label: "Anthropic" }],
};

/** As `renderAt`, with a way to apply a later `/api/me` answer: a new setup under the next revision. */
function renderWithIdentity(path: string, setup: SetupState) {
  const revalidate = vi.fn(async () => {});
  let apply: (next: SetupState) => void = () => {};
  function Identity({ children }: { children: ReactNode }) {
    const [state, setState] = useState({ setup, revision: 1 });
    apply = (next) => setState((current) => ({ setup: next, revision: current.revision + 1 }));
    return (
      <IdentityContext.Provider
        value={{ userId: "user_1", workspaceId: "ws_1", ...state, revalidate }}
      >
        {children}
      </IdentityContext.Provider>
    );
  }
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <ThemeProvider>
      <Identity>
        <RouterProvider router={router} />
      </Identity>
    </ThemeProvider>,
  );
  return { router, revalidate, applySetup: (next: SetupState) => act(() => apply(next)) };
}

/** A session socket the test drives: `FakeSessionSocket.last` opens and delivers frames. */
class FakeSessionSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeSessionSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSessionSocket.last = this;
  }
  send() {}
  close() {}
  deliver(frames: readonly unknown[]) {
    act(() => {
      this.readyState = 1;
      this.onopen?.();
      for (const frame of frames) {
        this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
      }
    });
  }
}

const REJECTED_KEY_PAUSE = [
  makeCommittedEvent("run.queued", {}, { sessionSequence: 1 }),
  makeCommittedEvent(
    "run.paused",
    {
      payload: {
        reason: "model_failure",
        modelFailure: {
          category: "authentication_failed",
          message: "The provider rejected this connection's credential.",
          retries: 0,
        },
      },
    },
    { sessionSequence: 2 },
  ),
];

describe("SessionRoute", () => {
  it("gives the session composer the workspace's model connections", async () => {
    // Stub the session socket and timeline measurement; neither is under test.
    vi.stubGlobal(
      "WebSocket",
      class {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readyState = 0;
        onopen = null;
        onmessage = null;
        onclose = null;
        onerror = null;
        send() {}
        close() {}
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    renderAt("/sessions/sess_1", READY);

    expect(await screen.findByLabelText("Model: Anthropic")).toBeTruthy();
    expect(screen.queryByLabelText("No model connected")).toBeNull();
  });

  // The identity came with the page; a key rejected or replaced since is not in it.
  it("reads the identity again when the run pauses on its key, and follows the fresh answer", async () => {
    vi.stubGlobal("WebSocket", FakeSessionSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const runKey = testModelRecord().modelConnectionId;
    // Still listed as active: the page loaded before the provider rejected it.
    const stale: SetupState = {
      ...READY,
      modelConnections: [{ modelConnectionId: runKey, label: "Anthropic" }],
    };
    const { revalidate, applySetup } = renderWithIdentity("/sessions/sess_1", stale);
    await waitFor(() => expect(FakeSessionSocket.last).not.toBeNull());
    expect(revalidate).not.toHaveBeenCalled();

    FakeSessionSocket.last?.deliver(REJECTED_KEY_PAUSE);

    expect(revalidate).toHaveBeenCalledTimes(1);
    // Nothing is said about the key's state on the stale answer.
    const note = await screen.findByTestId("composer-model-failure");
    expect(note.textContent).toBe("Model request failed: the provider rejected the model key.");

    applySetup({
      ...READY,
      modelConnections: [],
      inactiveModelConnections: [
        { modelConnectionId: runKey, provider: "anthropic", status: "invalid", activeSessions: 1 },
      ],
    });
    expect(screen.getByTestId("composer-model-failure").textContent).toContain(
      "Replace the key under Settings, Model providers, then come back here to continue the run.",
    );
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);

    // The key is replaced in Settings; the next read puts the run back within reach.
    applySetup(stale);
    expect(screen.getByTestId("composer-model-failure").textContent).toContain(
      "The key is listed as active under Settings, Model providers. Replace it there if the provider still rejects it. Send a message to continue the run from its last checkpoint.",
    );
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false);
  });
});

describe("the sidebar's status dots", () => {
  const ENDED_ROW = {
    sessionId: "sess_done",
    title: "Ship the fix",
    state: "active",
    lastActivityAt: "2026-09-03T12:00:00.000Z",
    createdAt: "2026-09-03T11:00:00.000Z",
    repositoryFullName: "acme/first",
    taskBranch: null,
    waitingForUser: false,
    currentRunId: "run_done",
    currentRunState: "verified",
  };

  function listing(rows: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ sessions: rows }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  }

  function quietSessionScreen() {
    vi.stubGlobal(
      "WebSocket",
      class {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readyState = 0;
        onopen = null;
        onmessage = null;
        onclose = null;
        onerror = null;
        send() {}
        close() {}
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }

  // Every shell route seeds this browser's marks from its first list, so clear them.
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("counts runs that ended before this browser first looked as seen", async () => {
    listing([ENDED_ROW]);
    renderAt("/", READY);
    expect(await screen.findByText("Ship the fix")).toBeTruthy();
    await waitFor(() => {
      expect(window.localStorage.getItem("oncue.seen-runs.ws_1")).toBe(
        JSON.stringify([["sess_done", "run_done"]]),
      );
    });
    expect(screen.queryByRole("img", { name: /not opened yet/ })).toBeNull();
  });

  it("marks a run that ended since, and clears it for good once the session is opened", async () => {
    window.localStorage.setItem("oncue.seen-runs.ws_1", "[]");
    listing([ENDED_ROW]);
    quietSessionScreen();
    const router = renderAt("/", READY);
    expect(await screen.findByRole("img", { name: "Verified, not opened yet" })).toBeTruthy();

    await router.navigate("/sessions/sess_done");
    await waitFor(() => {
      expect(screen.queryByRole("img", { name: "Verified, not opened yet" })).toBeNull();
    });
    await waitFor(() => {
      expect(window.localStorage.getItem("oncue.seen-runs.ws_1")).toBe(
        JSON.stringify([["sess_done", "run_done"]]),
      );
    });

    await router.navigate("/");
    expect(await screen.findByText("Ship the fix")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Verified, not opened yet" })).toBeNull();
  });

  it("shows a working session with its dot, from the same list", async () => {
    listing([{ ...ENDED_ROW, currentRunState: "running" }]);
    renderAt("/", READY);
    expect(await screen.findByRole("img", { name: "Working" })).toBeTruthy();
  });

  // A revalidation reads the list again; the rows it already has stay until the answer.
  it("keeps the list on screen while a new identity revision reads it again", async () => {
    listing([ENDED_ROW]);
    const { applySetup } = renderWithIdentity("/", READY);
    expect(await screen.findByText("Ship the fix")).toBeTruthy();

    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    applySetup({ ...READY });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.map((call) => (call as unknown[])[0])).toContain("/api/sessions");
    expect(screen.getByText("Ship the fix")).toBeTruthy();
  });
});

describe("SetupGate", () => {
  it("sends a user with no GitHub installation to setup", async () => {
    const router = renderAt("/", { kind: "connect_github", installUrl: null });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/setup");
    });
  });

  it("sends a user whose GitHub connection is stuck to setup", async () => {
    const router = renderAt("/", { kind: "github_stuck", reason: "no_repositories" });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/setup");
    });
  });

  it("gates every shell route, not only home", async () => {
    const router = renderAt("/repositories", { kind: "connect_github", installUrl: null });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/setup");
    });
  });

  it("lets a connected user reach home", async () => {
    const router = renderAt("/", READY);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /acme\/first/ })).not.toBeNull();
    });
    expect(router.state.location.pathname).toBe("/");
  });

  // Record 13 guides the model key from the composer, so the gate follows the
  // "shell" perspective and does not redirect.
  it("lets a user who skipped the model key reach home", async () => {
    const router = renderAt("/", { ...READY, modelConnections: [] });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
  });

  // No session can run without sandbox compute, so Modal gates Home too.
  it("sends a user with no Modal connection to setup", async () => {
    const router = renderAt("/", { kind: "connect_modal", modelConnections: [] });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/setup");
    });
  });

  it("gates settings on Modal too, not only home", async () => {
    const router = renderAt("/settings/profile", {
      kind: "connect_modal",
      modelConnections: [{ modelConnectionId: "mc_1", label: "Anthropic" }],
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/setup");
    });
  });
});

describe("SetupRoute", () => {
  it("sends a fully set up user back to home", async () => {
    const router = renderAt("/setup", READY);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
  });

  it("keeps a user missing a model key on setup", async () => {
    const router = renderAt("/setup", { ...READY, modelConnections: [] });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/setup");
    });
  });

  // The skippable model step comes before Modal.
  it("offers the model step first, then Modal once it is skipped", async () => {
    renderAt("/setup", { kind: "connect_modal", modelConnections: [] });

    await waitFor(() => expect(screen.getByText("Add a model key")).toBeTruthy());

    // "Skip for now" cannot navigate: with Modal missing, "/" would bounce back here.
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    await waitFor(() => expect(screen.getByText("Connect your Modal account")).toBeTruthy());
  });

  // A reload on the Modal step is common (a rejected token), so the skip must survive it.
  it("keeps the model step skipped across a remount", async () => {
    const setup: SetupState = { kind: "connect_modal", modelConnections: [] };
    renderAt("/setup", setup);
    await waitFor(() => expect(screen.getByText("Add a model key")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(screen.getByText("Connect your Modal account")).toBeTruthy());

    cleanup();
    renderAt("/setup", setup);

    await waitFor(() => expect(screen.getByText("Connect your Modal account")).toBeTruthy());
  });

  // A redirect for a missing Modal connection must land on the Modal step.
  it("lands on the step that caused the redirect", async () => {
    const router = renderAt("/", { kind: "connect_modal", modelConnections: [] });

    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
    await waitFor(() => expect(screen.getByText("Connect your Modal account")).toBeTruthy());
  });

  // A user who opens `/setup` directly is still offered the model step.
  it("still offers the model step to a user who came to setup on their own", async () => {
    renderAt("/setup", { kind: "connect_modal", modelConnections: [] });

    await waitFor(() => expect(screen.getByText("Add a model key")).toBeTruthy());
  });

  // History state can hold anything, so junk is treated as no redirect reason.
  it("ignores a history state it did not write", async () => {
    const identity: AuthGateIdentity = {
      userId: "user_1",
      workspaceId: "ws_1",
      setup: { kind: "connect_modal", modelConnections: [] },
      revision: 1,
      revalidate: vi.fn(async () => {}),
    };
    const router = createMemoryRouter(routes, {
      initialEntries: [{ pathname: "/setup", state: "not an object" }],
    });
    render(
      <ThemeProvider>
        <IdentityContext.Provider value={identity}>
          <RouterProvider router={router} />
        </IdentityContext.Provider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByText("Add a model key")).toBeTruthy());
  });

  it("goes straight to Modal when a model connection already exists", async () => {
    renderAt("/setup", {
      kind: "connect_modal",
      modelConnections: [{ modelConnectionId: "mc_1", label: "Anthropic" }],
    });

    await waitFor(() => expect(screen.getByText("Connect your Modal account")).toBeTruthy());
  });
});

describe("the Modal settings section", () => {
  it("renders at /settings/modal for a fully set up user", async () => {
    renderAt("/settings/modal", READY);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Modal" })).toBeTruthy());
  });
});

describe("Settings, Model providers", () => {
  // Home lists the workspace's keys from the identity, not from this page.
  it("refreshes the identity when a key changes, so Home does not offer a revoked one", async () => {
    const key = {
      connectionId: "c1",
      provider: "anthropic",
      status: "active",
      providerAccountHint: "ends 4f21",
      lastValidatedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      activeSessions: 0,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/model-connections") {
          return Response.json({
            connections: [key],
            catalog: { anthropic: [], openai: [] },
            pricesAsOf: "2026-09-23",
          });
        }
        if (url === "/api/model-connections/c1/recheck" && init?.method === "POST") {
          return Response.json({ connection: { ...key, status: "invalid" }, check: "rejected" });
        }
        if (url === "/api/model-connections/c1/revoke" && init?.method === "POST") {
          return Response.json({ connection: { ...key, status: "revoked" } });
        }
        return Response.json({ sessions: [] });
      }),
    );
    const revalidate = vi.fn(async () => {});
    renderAt("/settings/model-providers", READY, revalidate);

    fireEvent.click(await screen.findByRole("button", { name: "Re-check the Anthropic key" }));
    await screen.findByTestId("recheck-result-anthropic");
    expect(revalidate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Revoke the Anthropic key" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));
    await waitFor(() => expect(revalidate).toHaveBeenCalledTimes(2));
  });
});

describe("HomeRoute", () => {
  // Two connections, so taking the first unconditionally would fail.
  it("sends the model connection the picker chose, not merely the first one", async () => {
    const setup: SetupState = {
      kind: "ready",
      repositories: [{ repositoryConnectionId: "rc_1", fullName: "acme/first" }],
      modelConnections: [
        { modelConnectionId: "mc_1", label: "Anthropic" },
        { modelConnectionId: "mc_2", label: "OpenAI" },
      ],
    };
    let createBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/sessions" && init?.method === "POST") {
          createBody = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ sessionId: "sess_new" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/secret-requests")) {
          // Asked before every launch on a repository. This one asks for nothing.
          return Response.json({ baseSha: "a".repeat(40), state: "none" });
        }
        return new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    renderAt("/", setup);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /acme\/first/ })).not.toBeNull();
    });

    // The Worker lists newest first, so the composer opens on the oldest key,
    // the last in the list. Choose the newest, the one the default never picks.
    fireEvent.click(screen.getByLabelText(/Model: OpenAI/));
    fireEvent.click(await screen.findByRole("button", { name: "Anthropic" }));

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "start it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(createBody).not.toBeNull());
    expect((createBody as { modelConnectionId: string }).modelConnectionId).toBe("mc_1");
  });

  describe("with a model key that stopped working", () => {
    const REJECTED: SetupState = {
      ...READY,
      inactiveModelConnections: [
        { modelConnectionId: "mc_bad", provider: "openai", status: "invalid", activeSessions: 2 },
      ],
    };

    it("shows the banner and reads the identity again on arrival and on each return to the tab", async () => {
      const { revalidate, applySetup } = renderWithIdentity("/", REJECTED);

      expect((await screen.findByTestId("home-key-banner")).textContent).toContain(
        "The OpenAI key was rejected. 2 active sessions use it",
      );
      expect(revalidate).toHaveBeenCalledTimes(1);

      const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      later.mockRestore();
      expect(revalidate).toHaveBeenCalledTimes(2);

      // The key was replaced: the banner goes, and so does the reading.
      applySetup(READY);
      expect(screen.queryByTestId("home-key-banner")).toBeNull();
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(revalidate).toHaveBeenCalledTimes(2);
    });

    it("does not read the identity again while every key works", async () => {
      const { revalidate } = renderWithIdentity("/", READY);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /acme\/first/ })).not.toBeNull();
      });
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(revalidate).not.toHaveBeenCalled();
    });
  });

  describe("when the chosen model cannot be started on", () => {
    const TWO_KEYS: SetupState = {
      kind: "ready",
      repositories: [],
      modelConnections: [
        { modelConnectionId: "mc_1", label: "Anthropic" },
        { modelConnectionId: "mc_2", label: "OpenAI" },
      ],
    };

    /** Answers every create with `create`, and records what each one sent. */
    function stubCreate(create: () => Response): Record<string, unknown>[] {
      const sent: Record<string, unknown>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === "/api/sessions" && init?.method === "POST") {
            sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
            return create();
          }
          return Response.json({ sessions: [] });
        }),
      );
      return sent;
    }

    function send(text: string) {
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    }

    afterEach(() => {
      window.localStorage.clear();
    });

    it("says which provider rejected the key, links to Settings, keeps the draft, and reads the keys again", async () => {
      stubCreate(() =>
        Response.json(
          { error: "model_key_rejected", provider: "openai", modelConnectionId: "mc_2" },
          { status: 409 },
        ),
      );
      const revalidate = vi.fn(async () => {});
      const router = renderAt("/", TWO_KEYS, revalidate);
      await screen.findByLabelText("Message");

      send("fix the build");

      const notice = await screen.findByTestId("home-notice");
      expect(notice.textContent).toContain(
        "OpenAI rejected this key. Replace it in Settings or pick another model.",
      );
      expect(screen.getByTestId("home-notice-model-keys").getAttribute("href")).toBe(
        "/settings/model-providers",
      );
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("fix the build");
      expect(router.state.location.pathname).toBe("/");
      expect(revalidate).toHaveBeenCalledTimes(1);
    });

    it("says a key was removed, rather than to pick the same model again, and reads the keys again", async () => {
      stubCreate(() =>
        Response.json({ error: "invalid_request", reason: "not_active" }, { status: 409 }),
      );
      const revalidate = vi.fn(async () => {});
      renderAt("/", TWO_KEYS, revalidate);
      await screen.findByLabelText("Message");

      send("fix the build");

      const notice = await screen.findByTestId("home-notice");
      expect(notice.textContent).toContain(
        "That model's key was removed or is no longer accepted. Pick a model again, or add a key in Settings.",
      );
      expect(notice.textContent).not.toContain("Pick the repository and model again");
      expect(screen.getByTestId("home-notice-model-keys")).not.toBeNull();
      expect(revalidate).toHaveBeenCalledTimes(1);
    });

    // A hosted Worker refuses the scripted model, so a workspace with no key is
    // told to add one rather than seeing a session start.
    it("asks for a model key, links to Settings, and keeps the draft when the Worker requires one", async () => {
      stubCreate(() => Response.json({ error: "model_connection_required" }, { status: 409 }));
      const revalidate = vi.fn(async () => {});
      const router = renderAt("/", { ...TWO_KEYS, modelConnections: [] }, revalidate);
      await screen.findByLabelText("Message");

      send("fix the build");

      const notice = await screen.findByTestId("home-notice");
      expect(notice.textContent).toContain(
        "Add a model key in Settings before starting a session.",
      );
      expect(screen.getByTestId("home-notice-model-keys").getAttribute("href")).toBe(
        "/settings/model-providers",
      );
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("fix the build");
      expect(router.state.location.pathname).toBe("/");
      expect(revalidate).toHaveBeenCalledTimes(1);
    });

    it("drops the Settings link with the notice on the next send", async () => {
      let refuse = true;
      stubCreate(() =>
        refuse
          ? Response.json({ error: "invalid_request", reason: "not_active" }, { status: 409 })
          : Response.json({ error: "modal_connection_required" }, { status: 409 }),
      );
      renderAt("/", TWO_KEYS);
      await screen.findByLabelText("Message");
      send("fix the build");
      await screen.findByTestId("home-notice-model-keys");

      refuse = false;
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() =>
        expect(screen.getByTestId("home-notice").textContent).toContain("Connect your Modal"),
      );
      expect(screen.queryByTestId("home-notice-model-keys")).toBeNull();
    });

    it("does not read the keys again for a refusal that is not about the model", async () => {
      stubCreate(() => Response.json({ error: "modal_connection_required" }, { status: 409 }));
      const revalidate = vi.fn(async () => {});
      renderAt("/", TWO_KEYS, revalidate);
      await screen.findByLabelText("Message");

      send("fix the build");

      await screen.findByTestId("home-notice");
      expect(revalidate).not.toHaveBeenCalled();
    });

    it("never sends a remembered connection the workspace no longer has", async () => {
      // Remembered from an earlier visit; that key has since been revoked.
      window.localStorage.setItem(
        "oncue.model.ws_1",
        JSON.stringify({ connectionId: "mc_revoked", modelId: "claude-opus-5-5" }),
      );
      const sent = stubCreate(() => Response.json({ sessionId: "sess_new" }, { status: 201 }));
      renderAt("/", TWO_KEYS);
      await screen.findByLabelText("Message");

      send("fix the build");

      await waitFor(() => expect(sent).toHaveLength(1));
      // The oldest listed key, and no model carried over from the dead one.
      expect(sent[0]?.modelConnectionId).toBe("mc_2");
      expect(sent[0]?.modelId).not.toBe("claude-opus-5-5");
    });

    // Revoke both keys and connect a new one in Settings, then come back
    // without reloading: the identity was refreshed, the page was not.
    it("sends a key that exists after the picked one was revoked and another connected", async () => {
      const sent = stubCreate(() => Response.json({ sessionId: "sess_new" }, { status: 201 }));
      const router = createMemoryRouter(routes, { initialEntries: ["/"] });
      const at = (setup: SetupState) => (
        <ThemeProvider>
          <IdentityContext.Provider
            value={{
              userId: "user_1",
              workspaceId: "ws_1",
              setup,
              revision: 1,
              revalidate: async () => {},
            }}
          >
            <RouterProvider router={router} />
          </IdentityContext.Provider>
        </ThemeProvider>
      );
      const view = render(at(TWO_KEYS));
      await screen.findByLabelText("Message");
      // Picked on this page, so it outranks the default until it is gone.
      fireEvent.click(screen.getByLabelText(/Model: OpenAI/));
      fireEvent.click(await screen.findByRole("button", { name: "Anthropic" }));

      view.rerender(
        at({
          kind: "ready",
          repositories: [],
          modelConnections: [{ modelConnectionId: "mc_3", label: "Anthropic" }],
        }),
      );
      send("fix the build");

      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]?.modelConnectionId).toBe("mc_3");
    });
  });

  describe("on a repository that asks for development secrets", () => {
    const SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
    const setup: SetupState = {
      kind: "ready",
      repositories: [{ repositoryConnectionId: "rc_1", fullName: "acme/first" }],
      modelConnections: [{ modelConnectionId: "mc_1", label: "Anthropic" }],
    };

    function stub(requests: () => Response) {
      const created: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === "/api/sessions" && init?.method === "POST") {
            created.push(JSON.parse(String(init.body)));
            return Response.json({ sessionId: "sess_new" }, { status: 201 });
          }
          if (url.endsWith("/secret-requests")) {
            return requests();
          }
          return Response.json({ sessions: [] });
        }),
      );
      return created;
    }

    async function send() {
      renderAt("/", setup);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /acme\/first/ })).not.toBeNull();
      });
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "start it" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    }

    it("shows the card before anything is created, keeps the draft, and launches from its answer", async () => {
      const created = stub(() =>
        Response.json({
          baseSha: SHA,
          state: "declared",
          required: [{ name: "DATABASE_URL", saved: true, isNew: false }],
          optional: [{ name: "STRIPE_TEST_KEY", saved: true, isNew: false }],
        }),
      );
      await send();

      expect(await screen.findByTestId("disclosure-card")).toBeTruthy();
      expect(created).toEqual([]);
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("start it");

      fireEvent.click(screen.getByLabelText("STRIPE_TEST_KEY"));
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));

      await waitFor(() => expect(created).toHaveLength(1));
      expect(created[0]).toMatchObject({
        repositoryConnectionId: "rc_1",
        instruction: { text: "start it" },
        secrets: { baseSha: SHA, optional: ["STRIPE_TEST_KEY"], startWithoutMissing: false },
      });
    });

    it("creates nothing when the card is cancelled", async () => {
      const created = stub(() =>
        Response.json({
          baseSha: SHA,
          state: "declared",
          required: [{ name: "DATABASE_URL", saved: true, isNew: false }],
          optional: [],
        }),
      );
      await send();
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByTestId("disclosure-card")).toBeNull());
      expect(created).toEqual([]);
    });

    it("does not launch when what the repository asks for could not be read", async () => {
      const created = stub(() => Response.json({ error: "unreadable" }, { status: 502 }));
      await send();
      expect((await screen.findByTestId("home-notice")).textContent).toContain(
        "couldn't read what this repository asks for",
      );
      expect(created).toEqual([]);
    });

    // A dead installation must not read as a retryable failure.
    it("asks the person to reconnect GitHub when the connection has to be verified again", async () => {
      const created = stub(() =>
        Response.json(
          { error: "github_reverification_required", reason: "installation_missing" },
          { status: 409 },
        ),
      );
      await send();
      const notice = await screen.findByTestId("home-notice");
      expect(notice.textContent).toContain("Reconnect GitHub");
      expect(notice.textContent).not.toContain("couldn't read");
      expect(created).toEqual([]);
    });
  });

  describe("choosing the branch", () => {
    const SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
    const BRANCHES = {
      defaultBranch: "main",
      branches: [
        { name: "main", protected: false, default: true },
        { name: "feature/login", protected: false, default: false },
      ],
      truncated: false,
    };

    function stub(answers: { create?: () => Response; requests?: (url: string) => Response }) {
      const created: unknown[] = [];
      const requestUrls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === "/api/sessions" && init?.method === "POST") {
            created.push(JSON.parse(String(init.body)));
            return answers.create?.() ?? Response.json({ sessionId: "sess_new" }, { status: 201 });
          }
          if (url.includes("/secret-requests")) {
            requestUrls.push(url);
            return answers.requests?.(url) ?? Response.json({ baseSha: SHA, state: "none" });
          }
          if (url.includes("/branches")) {
            return Response.json(BRANCHES);
          }
          return Response.json({ sessions: [] });
        }),
      );
      return { created, requestUrls };
    }

    async function chooseExisting(name: string) {
      renderAt("/", READY);
      fireEvent.click(await screen.findByTestId("branch-picker"));
      fireEvent.click(await screen.findByTestId("branch-mode-existing_branch"));
      const option = await waitFor(() => {
        const found = screen
          .getAllByTestId("branch-option")
          .find((row) => row.getAttribute("data-branch") === name);
        expect(found).toBeDefined();
        return found as HTMLElement;
      });
      fireEvent.click(option);
    }

    function send() {
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "carry on" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    }

    it("sends the branch to work on, having read the card at it", async () => {
      const { created, requestUrls } = stub({});
      await chooseExisting("feature/login");
      expect(screen.getByTestId("branch-picker-label").textContent).toBe("On feature/login");
      send();
      await waitFor(() => expect(created).toHaveLength(1));
      expect(created[0]).toMatchObject({ branch: "feature/login", branchMode: "existing_branch" });
      expect(requestUrls.at(-1)).toBe(
        "/api/repositories/rc_1/secret-requests?branch=feature%2Flogin",
      );
    });

    it("says why the Worker refused the branch, and keeps the draft", async () => {
      stub({
        create: () =>
          Response.json(
            { error: "branch_refused", reason: "in_use", sessionId: "sess_other" },
            { status: 409 },
          ),
      });
      await chooseExisting("feature/login");
      send();
      expect((await screen.findByTestId("home-notice")).textContent).toContain(
        "Another session is already working on that branch",
      );
      // The holder is the caller's own session, so the notice links to it.
      expect(screen.getByTestId("home-notice-session").getAttribute("href")).toBe(
        "/sessions/sess_other",
      );
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("carry on");
    });

    it("says a chosen branch is gone before anything is created", async () => {
      const { created } = stub({
        requests: () =>
          Response.json({ error: "branch_refused", reason: "missing" }, { status: 409 }),
      });
      await chooseExisting("feature/login");
      send();
      expect((await screen.findByTestId("home-notice")).textContent).toContain(
        "no longer on GitHub",
      );
      expect(created).toEqual([]);
    });

    it("asks for a branch before working directly on one", async () => {
      const { created } = stub({});
      renderAt("/", READY);
      fireEvent.click(await screen.findByTestId("branch-picker"));
      fireEvent.click(await screen.findByTestId("branch-mode-existing_branch"));
      send();
      expect((await screen.findByTestId("home-notice")).textContent).toContain("default branch");
      expect(created).toEqual([]);
    });

    it("reads the card again at the new tip when the branch moved, and shows it", async () => {
      let requests = 0;
      const { created } = stub({
        create: () =>
          Response.json({ error: "base_moved", baseSha: "b".repeat(40) }, { status: 409 }),
        requests: () => {
          requests += 1;
          return Response.json({
            baseSha: requests === 1 ? SHA : "b".repeat(40),
            state: "declared",
            required: [{ name: "DATABASE_URL", saved: true, isNew: false }],
            optional: [],
          });
        },
      });
      renderAt("/", READY);
      await screen.findByTestId("branch-picker");
      send();
      fireEvent.click(await screen.findByRole("button", { name: "Start session" }));
      await waitFor(() => expect(created).toHaveLength(1));
      // The second card is the one read at the new tip.
      await waitFor(() => expect(requests).toBe(2));
      expect(await screen.findByTestId("disclosure-card")).toBeTruthy();
      expect(screen.queryByTestId("home-notice")).toBeNull();
    });
  });
});

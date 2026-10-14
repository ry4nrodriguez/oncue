import {
  act,
  cleanup,
  fireEvent,
  render as renderBare,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactElement, type ReactNode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/lib/theme";

// `main.tsx` puts the theme above the gate; the panel's wordmark reads it.
function render(ui: ReactElement) {
  return renderBare(ui, { wrapper: ThemeProvider });
}

const useAuthMock = vi.fn();

vi.mock("@clerk/react", () => ({
  useAuth: () => useAuthMock(),
  SignIn: () => <div data-testid="clerk-sign-in" />,
  SignOutButton: ({ children }: { children?: ReactNode }) => (
    <div data-testid="clerk-sign-out">{children}</div>
  ),
}));

const { AuthGate, useIdentity } = await import("./AuthGate");
const { ME_TIMEOUT_MS } = await import("./gate");

const READY_BODY = {
  userId: "usr_1",
  workspaceId: "wsp_1",
  setup: { kind: "ready", repositories: [], modelConnections: [] },
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AuthGate", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAuthMock.mockReset();
  });

  it("shows a loading state before Clerk itself has loaded", () => {
    useAuthMock.mockReturnValue({ isLoaded: false, isSignedIn: false });
    render(<AuthGate>{() => <p>never rendered</p>}</AuthGate>);
    expect(screen.getByTestId("auth-loading")).toBeTruthy();
  });

  it("shows the sign-in gate once loaded but signed out", () => {
    useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: false });
    render(<AuthGate>{() => <p>never rendered</p>}</AuthGate>);
    expect(screen.getByTestId("sign-in-gate")).toBeTruthy();
    // Clerk's form inside the one panel, under the one wordmark.
    const panel = screen.getByTestId("auth-panel");
    expect(panel.contains(screen.getByTestId("clerk-sign-in"))).toBe(true);
    expect(screen.getAllByRole("img", { name: "OnCue" })).toHaveLength(1);
  });

  it("shows the blocked screen when /api/me reports the identity is not allowlisted", async () => {
    useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: "not_allowlisted", clerkSubject: "user_x" })),
    );

    render(<AuthGate>{() => <p>never rendered</p>}</AuthGate>);

    expect(await screen.findByTestId("blocked-screen")).toBeTruthy();
    expect(screen.getByTestId("blocked-local-hint").textContent).toContain("user_x");
  });

  it("offers Clerk's sign-out on the blocked screen, so a wrong account is not a dead end", async () => {
    useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: "not_allowlisted" })),
    );

    render(<AuthGate>{() => <p>never rendered</p>}</AuthGate>);

    expect(await screen.findByTestId("blocked-screen")).toBeTruthy();
    const signOut = screen.getByRole("button", { name: "Sign out" });
    expect(screen.getByTestId("clerk-sign-out").contains(signOut)).toBe(true);
    // Hosted: `/api/me` omits the subject, so no local hint is shown.
    expect(screen.queryByTestId("blocked-local-hint")).toBeNull();
    const panel = screen.getByTestId("auth-panel");
    expect(panel.contains(screen.getByTestId("blocked-message"))).toBe(true);
    expect(screen.getAllByRole("img", { name: "OnCue" })).toHaveLength(1);
  });

  it("shows a plain error with Retry when the /api/me fetch itself rejects, and recovers on Retry", async () => {
    useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(jsonResponse(200, READY_BODY));
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthGate>{(identity) => <p data-testid="identity">{identity.userId}</p>}</AuthGate>);

    expect(await screen.findByTestId("auth-failed")).toBeTruthy();
    expect(screen.queryByTestId("auth-loading")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("couldn't reach the server");
    // An expired sign-in lands here too, so it is never a dead end.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect((await screen.findByTestId("identity")).textContent).toBe("usr_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a 5xx and an unparseable body as failures, not as loading", async () => {
    useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(503, { error: "unavailable" })),
    );
    const first = render(<AuthGate>{() => <p>never rendered</p>}</AuthGate>);
    expect(await screen.findByTestId("auth-failed")).toBeTruthy();
    first.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>bad gateway</html>", { status: 200 })),
    );
    render(<AuthGate>{() => <p>never rendered</p>}</AuthGate>);
    expect(await screen.findByTestId("auth-failed")).toBeTruthy();
  });

  it("retries on its own with a growing delay until /api/me answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
      const fetchMock = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
        .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
        .mockResolvedValue(jsonResponse(200, READY_BODY));
      vi.stubGlobal("fetch", fetchMock);

      render(<AuthGate>{(identity) => <p data-testid="identity">{identity.userId}</p>}</AuthGate>);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId("auth-failed")).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // One second after the first failure, two after the second.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(999);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1999);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(screen.getByTestId("identity").textContent).toBe("usr_1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the signed-in app on screen when a revalidation fails, and retries behind it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
      const fetchMock = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(jsonResponse(200, READY_BODY))
        .mockRejectedValueOnce(new Error("blip"))
        .mockResolvedValue(
          jsonResponse(200, { ...READY_BODY, setup: { ...READY_BODY.setup, kind: "ready" } }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const mounts = vi.fn();
      function App({
        revalidate,
        revision,
      }: {
        revalidate: () => Promise<void>;
        revision: number;
      }) {
        useEffect(() => mounts(), []);
        return (
          <button type="button" data-revision={revision} onClick={() => void revalidate()}>
            revalidate
          </button>
        );
      }

      render(
        <AuthGate>
          {(identity) => <App revalidate={identity.revalidate} revision={identity.revision} />}
        </AuthGate>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const button = screen.getByRole("button", { name: "revalidate" });
      expect(button.getAttribute("data-revision")).toBe("1");

      await act(async () => {
        fireEvent.click(button);
        await vi.advanceTimersByTimeAsync(0);
      });
      // Same element, never remounted, and no error screen in its place.
      expect(screen.queryByTestId("auth-failed")).toBeNull();
      expect(screen.queryByTestId("auth-loading")).toBeNull();
      expect(screen.getByRole("button", { name: "revalidate" })).toBe(button);
      expect(mounts).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(button.getAttribute("data-revision")).toBe("2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons a stalled /api/me, and Retry is never disabled while a request is out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
      const fetchMock = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      render(<AuthGate>{() => <p>never rendered</p>}</AuthGate>);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ME_TIMEOUT_MS - 1);
      });
      expect(screen.getByTestId("auth-loading")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry.getAttribute("aria-busy")).toBe("false");

      // The automatic retry is out: the button says so and keeps its focus.
      retry.focus();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const busy = screen.getByRole("button", { name: "Retrying…" });
      expect(busy).toBe(retry);
      expect(busy.getAttribute("aria-busy")).toBe("true");
      expect((busy as HTMLButtonElement).disabled).toBe(false);
      expect(document.activeElement).toBe(busy);

      // A press while one is out starts a fresh request.
      fireEvent.click(busy);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules nothing after it unmounts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
      const fetchMock = vi.fn(async () => jsonResponse(500, { error: "boom" }));
      vi.stubGlobal("fetch", fetchMock);

      const view = render(<AuthGate>{() => <p>never rendered</p>}</AuthGate>);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an answer that arrives after signing out", async () => {
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
    const view = render(<AuthGate>{() => <p data-testid="identity">in</p>}</AuthGate>);
    useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: false });
    view.rerender(<AuthGate>{() => <p data-testid="identity">in</p>}</AuthGate>);

    await act(async () => {
      answer(jsonResponse(200, READY_BODY));
    });

    expect(screen.getByTestId("sign-in-gate")).toBeTruthy();
    expect(screen.queryByTestId("identity")).toBeNull();
  });

  it("renders the children with the workspace, user id and setup once allowed", async () => {
    useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, READY_BODY)),
    );

    render(
      <AuthGate>
        {(identity) => (
          <p data-testid="identity">
            {`${identity.userId}:${identity.workspaceId}:${identity.setup.kind}`}
          </p>
        )}
      </AuthGate>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("identity").textContent).toBe("usr_1:wsp_1:ready"),
    );
  });

  it("re-fetches /api/me when revalidate is called", async () => {
    useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
    const fetchMock = vi.fn(async () => jsonResponse(200, READY_BODY));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AuthGate>
        {(identity) => (
          <button type="button" onClick={() => void identity.revalidate()}>
            revalidate
          </button>
        )}
      </AuthGate>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "revalidate" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("useIdentity throws when used outside AuthGate's provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    function Consumer() {
      useIdentity();
      return null;
    }

    expect(() => render(<Consumer />)).toThrow("useIdentity must be used inside AuthGate");
    consoleError.mockRestore();
  });

  it("exposes the identity to useIdentity from inside AuthGate's children", async () => {
    useAuthMock.mockReturnValue({ isLoaded: true, isSignedIn: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, READY_BODY)),
    );

    function Consumer() {
      const identity = useIdentity();
      return <p data-testid="via-hook">{identity.userId}</p>;
    }

    render(<AuthGate>{() => <Consumer />}</AuthGate>);

    await waitFor(() => expect(screen.getByTestId("via-hook").textContent).toBe("usr_1"));
  });
});

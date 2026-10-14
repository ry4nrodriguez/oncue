import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubInstallButton } from "./GitHubInstallButton";

vi.mock("@/lib/navigate", () => ({
  navigateTo: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("GitHubInstallButton", () => {
  it("mints an install URL and navigates there on success", async () => {
    const { navigateTo } = await import("@/lib/navigate");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        return jsonResponse(201, { installUrl: "https://github.com/apps/oncue" });
      }),
    );

    render(<GitHubInstallButton className="button" />);
    fireEvent.click(screen.getByRole("button", { name: "Install the OnCue GitHub App" }));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("https://github.com/apps/oncue"));
  });

  it("disables the button and swaps its label while the request is in flight", async () => {
    const { navigateTo } = await import("@/lib/navigate");
    const deferred = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => deferred.promise),
    );

    render(<GitHubInstallButton className="button" idleLabel="Connect GitHub" />);
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));

    const button = screen.getByRole("button", { name: "Opening GitHub…" });
    expect(button.hasAttribute("disabled")).toBe(true);

    deferred.resolve(jsonResponse(201, { installUrl: "https://github.com/apps/oncue" }));
    // The button stays disabled and pending while the browser leaves for GitHub.
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("https://github.com/apps/oncue"));
    expect(screen.getByRole("button", { name: "Opening GitHub…" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("renders the unconfigured sentence on a 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(503, { error: "github_unconfigured" })),
    );

    render(<GitHubInstallButton className="button" />);
    fireEvent.click(screen.getByRole("button", { name: "Install the OnCue GitHub App" }));

    await waitFor(() =>
      expect(screen.getByText("GitHub is not configured for this deployment.")).not.toBeNull(),
    );
  });

  it("renders the generic failure sentence when the request is denied or unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "unauthenticated" })),
    );

    render(<GitHubInstallButton className="button" />);
    fireEvent.click(screen.getByRole("button", { name: "Install the OnCue GitHub App" }));

    await waitFor(() =>
      expect(
        screen.getByText("OnCue couldn't start the GitHub installation. Try again in a moment."),
      ).not.toBeNull(),
    );
  });

  it("renders the generic failure sentence on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    render(<GitHubInstallButton className="button" />);
    fireEvent.click(screen.getByRole("button", { name: "Install the OnCue GitHub App" }));

    await waitFor(() =>
      expect(
        screen.getByText("OnCue couldn't start the GitHub installation. Try again in a moment."),
      ).not.toBeNull(),
    );
  });
});

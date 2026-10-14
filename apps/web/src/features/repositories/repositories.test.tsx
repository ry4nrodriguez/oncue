import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryRow } from "@/lib/api/repositories";
import { RepositoriesScreen } from "./RepositoriesScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderAt(path: string) {
  const router = createMemoryRouter([{ path: "/repositories", element: <RepositoriesScreen /> }], {
    initialEntries: [path],
  });
  return render(<RouterProvider router={router} />);
}

const ROWS: readonly RepositoryRow[] = [
  {
    repositoryConnectionId: "rc_1",
    fullName: "acme/oncue",
    defaultBranch: "main",
    status: "verified",
    removedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  },
  {
    repositoryConnectionId: "rc_2",
    fullName: "acme/scratch",
    defaultBranch: "trunk",
    status: "disconnected",
    removedAt: null,
    createdAt: "2026-08-02T00:00:00.000Z",
  },
];

describe("RepositoriesScreen", () => {
  it("shows the connect-GitHub empty state once the list resolves empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { repositories: [] })),
    );

    renderAt("/repositories");

    expect(screen.getByText("Loading repositories…")).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByText("No repositories are connected yet.")).not.toBeNull(),
    );
    expect(screen.getByText("You choose the repositories")).not.toBeNull();
    expect(screen.getByText("Separate from signing in")).not.toBeNull();
  });

  it("lists every repository with its branch, saying Disconnected on that row alone and dimming it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { repositories: ROWS })),
    );

    const { container } = renderAt("/repositories");

    await waitFor(() => expect(screen.getByText("Disconnected")).not.toBeNull());
    // The ordinary case carries no badge.
    expect(screen.queryByText("Verified")).toBeNull();
    expect(screen.getAllByText("Disconnected")).toHaveLength(1);
    expect(screen.getByText("acme/oncue")).not.toBeNull();
    expect(screen.getByText("acme/scratch")).not.toBeNull();
    expect(screen.getByText("main")).not.toBeNull();
    expect(screen.getByText("trunk")).not.toBeNull();

    const dimmedRow = screen.getByText("acme/scratch").closest("div.opacity-60");
    expect(dimmedRow).not.toBeNull();
    const verifiedRow = screen.getByText("acme/oncue").parentElement?.parentElement;
    expect(verifiedRow?.className.includes("opacity-60")).toBe(false);
    // Sanity: the container actually rendered rows rather than an empty list.
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("asks before removing, then lists the repository under Removed with Restore", async () => {
    const removed = { ...ROWS[0], removedAt: "2026-09-23T00:00:00.000Z" };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return jsonResponse(200, { repository: removed });
      }
      if (init?.method === "POST") {
        return jsonResponse(200, { repository: ROWS[0] });
      }
      return jsonResponse(200, { repositories: ROWS });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/repositories");
    await waitFor(() => expect(screen.getByText("acme/oncue")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Remove acme/oncue" }));
    const dialog = screen.getByTestId("remove-dialog");
    expect(dialog.textContent).toContain("Remove acme/oncue from OnCue?");
    expect(dialog.textContent).toContain("keeps its access on GitHub");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByTestId("remove-dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith("/api/repositories/rc_1", { method: "DELETE" });
    expect(screen.getAllByTestId("repository-row")).toHaveLength(1);
    const removedSection = screen.getByRole("region", { name: "Removed repositories" });
    expect(removedSection.textContent).toContain("acme/oncue");
    expect(removedSection.textContent).toContain("still has access");

    fireEvent.click(screen.getByRole("button", { name: "Restore acme/oncue" }));
    await waitFor(() => expect(screen.getAllByTestId("repository-row")).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledWith("/api/repositories/rc_1/restore", { method: "POST" });
    expect(screen.queryByRole("region", { name: "Removed repositories" })).toBeNull();
  });

  it("keeps the dialog open and says so when a remove fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "DELETE"
          ? jsonResponse(500, {})
          : jsonResponse(200, { repositories: ROWS }),
      ),
    );
    renderAt("/repositories");
    await waitFor(() => expect(screen.getByText("acme/oncue")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Remove acme/oncue" }));
    fireEvent.click(
      within(screen.getByTestId("remove-dialog")).getByRole("button", { name: "Remove" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("could not be removed"),
    );
    expect(screen.getByTestId("remove-dialog")).not.toBeNull();
    expect(screen.getAllByTestId("repository-row")).toHaveLength(2);
  });

  it("shows a denied message on 401/403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "unauthenticated" })),
    );

    renderAt("/repositories");

    await waitFor(() =>
      expect(screen.getByText("You don't have access to view repositories.")).not.toBeNull(),
    );
  });

  it("shows an unreachable message when the server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, null)),
    );

    renderAt("/repositories");

    await waitFor(() =>
      expect(
        screen.getByText("OnCue couldn't load your repositories. Try again in a moment."),
      ).not.toBeNull(),
    );
  });

  it("renders the plain-language sentence for a ?github= refusal reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { repositories: [] })),
    );

    renderAt("/repositories?github=pending_approval");

    await waitFor(() =>
      expect(screen.getByText(/organization that requires admin approval/)).not.toBeNull(),
    );
    expect(screen.getByText(/organization that requires admin approval/).getAttribute("role")).toBe(
      "alert",
    );
  });

  it("ignores an unrecognized ?github= reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { repositories: [] })),
    );

    renderAt("/repositories?github=made_up");

    await waitFor(() =>
      expect(screen.getByText("No repositories are connected yet.")).not.toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

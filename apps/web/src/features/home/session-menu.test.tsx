import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchivedNotice } from "@/features/session/ArchivedNotice";
import { ARCHIVE_RUN_OPEN_COPY, DELETE_COPY, SessionMenu } from "./SessionMenu";
import { type ArchiveOutcome, type SessionListActions, SessionListContext } from "./session-list";

afterEach(cleanup);

function actions(overrides: Partial<SessionListActions> = {}) {
  return {
    runChanged: vi.fn(),
    archive: vi.fn(async (): Promise<ArchiveOutcome> => ({ kind: "done" })),
    unarchive: vi.fn(async (): Promise<string | null> => null),
    remove: vi.fn(async (): Promise<string | null> => null),
    ...overrides,
  } satisfies SessionListActions;
}

function renderMenu(
  shell: SessionListActions,
  props: { archived?: boolean; runOpen?: boolean } = {},
) {
  render(
    <SessionListContext value={shell}>
      <SessionMenu
        sessionId="sess_1"
        title="Fix the bug"
        archived={props.archived ?? false}
        runOpen={props.runOpen ?? false}
      />
    </SessionListContext>,
  );
}

async function choose(item: string) {
  const trigger = screen.getByRole("button", { name: "Options for Fix the bug" });
  fireEvent.pointerDown(trigger, { pointerType: "mouse" });
  fireEvent.mouseDown(trigger, { detail: 1 });
  await screen.findByRole("menu");
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: item }));
  });
}

describe("SessionMenu", () => {
  it("archives at once when no run is open", async () => {
    const shell = actions();
    renderMenu(shell);

    await choose("Archive");

    expect(shell.archive).toHaveBeenCalledWith("sess_1", false);
    expect(screen.queryByTestId("archive-session-dialog")).toBeNull();
  });

  it("asks before archiving over an open run, and cancels it only on the confirm", async () => {
    const shell = actions();
    renderMenu(shell, { runOpen: true });

    await choose("Archive");
    const dialog = await screen.findByTestId("archive-session-dialog");
    expect(dialog.textContent).toContain(ARCHIVE_RUN_OPEN_COPY);
    expect(shell.archive).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId("archive-session-confirm"));
    });
    expect(shell.archive).toHaveBeenCalledWith("sess_1", true);
    await waitFor(() => expect(screen.queryByTestId("archive-session-dialog")).toBeNull());
  });

  it("asks when the server finds a run the list had not seen yet", async () => {
    const archive = vi
      .fn<SessionListActions["archive"]>()
      .mockResolvedValueOnce({ kind: "run_open" })
      .mockResolvedValueOnce({ kind: "done" });
    renderMenu(actions({ archive }));

    await choose("Archive");

    expect(await screen.findByTestId("archive-session-dialog")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("archive-session-confirm"));
    });
    expect(archive).toHaveBeenLastCalledWith("sess_1", true);
  });

  it("says why archiving failed", async () => {
    renderMenu(
      actions({ archive: async () => ({ kind: "error", message: "OnCue couldn't reach it." }) }),
    );

    await choose("Archive");

    const dialog = await screen.findByTestId("archive-session-dialog");
    expect(dialog.textContent).toContain("Couldn't archive this session");
    expect(dialog.textContent).toContain("OnCue couldn't reach it.");
    expect(screen.queryByTestId("archive-session-confirm")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("archive-session-dialog")).toBeNull());
  });

  it("restores an archived session, and says why when it cannot", async () => {
    const shell = actions();
    renderMenu(shell, { archived: true });
    await choose("Unarchive");
    expect(shell.unarchive).toHaveBeenCalledWith("sess_1");
    expect(screen.queryByTestId("archive-session-dialog")).toBeNull();
    cleanup();

    renderMenu(actions({ unarchive: async () => "Signed out." }), { archived: true });
    await choose("Unarchive");
    const dialog = await screen.findByTestId("archive-session-dialog");
    expect(dialog.textContent).toContain("Couldn't restore this session");
    expect(dialog.textContent).toContain("Signed out.");
  });

  it("deletes only after a confirmation that says what is erased and what stays on GitHub", async () => {
    const shell = actions();
    renderMenu(shell);

    await choose("Delete");
    const dialog = await screen.findByTestId("delete-session-dialog");
    expect(dialog.textContent).toContain(DELETE_COPY);
    expect(DELETE_COPY).toContain("conversation, diffs, logs, attachments, and artifacts");
    expect(DELETE_COPY).toContain("The GitHub branch and any pull request stay on GitHub.");
    expect(shell.remove).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-session-confirm"));
    });
    expect(shell.remove).toHaveBeenCalledWith("sess_1");
    await waitFor(() => expect(screen.queryByTestId("delete-session-dialog")).toBeNull());
  });

  it("names the session in the delete dialog, and Escape does nothing while it deletes", async () => {
    let finish: (value: string | null) => void = () => {};
    const remove = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finish = resolve;
        }),
    );
    renderMenu(actions({ remove }));

    await choose("Delete");
    const dialog = await screen.findByTestId("delete-session-dialog");
    expect(dialog.textContent).toContain("Delete “Fix the bug”?");
    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-session-confirm"));
    });
    expect(screen.getByTestId("delete-session-confirm").textContent).toBe("Deleting…");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByTestId("delete-session-dialog")).toBeTruthy();

    await act(async () => {
      finish(null);
    });
    await waitFor(() => expect(screen.queryByTestId("delete-session-dialog")).toBeNull());
  });

  it("keeps the delete dialog open with the reason when the delete fails, and Keep it closes it", async () => {
    renderMenu(actions({ remove: async () => "OnCue couldn't reach the server." }));

    await choose("Delete");
    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-session-confirm"));
    });

    expect((await screen.findByRole("alert")).textContent).toBe("OnCue couldn't reach the server.");
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByTestId("delete-session-dialog")).toBeNull());
  });
});

describe("ArchivedNotice", () => {
  it("restores the session, and shows why when it cannot", async () => {
    const unarchive = vi
      .fn<SessionListActions["unarchive"]>()
      .mockResolvedValueOnce("Signed out.")
      .mockResolvedValueOnce(null);
    render(
      <SessionListContext value={actions({ unarchive })}>
        <ArchivedNotice sessionId="sess_1" />
      </SessionListContext>,
    );
    expect(screen.getByTestId("archived-notice").textContent).toContain(
      "This session is archived.",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("unarchive-session"));
    });
    expect((await screen.findByRole("alert")).textContent).toBe("Signed out.");

    await act(async () => {
      fireEvent.click(screen.getByTestId("unarchive-session"));
    });
    expect(unarchive).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

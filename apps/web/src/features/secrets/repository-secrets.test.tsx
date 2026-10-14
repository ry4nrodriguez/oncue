import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as api from "@/lib/api/secrets";
import { RepositorySecrets } from "./RepositorySecrets";

const listSecrets = vi.fn<typeof api.listSecrets>();
const saveSecret = vi.fn<typeof api.saveSecret>();
const deleteSecret = vi.fn<typeof api.deleteSecret>();

vi.mock("@/lib/api/secrets", () => ({
  listSecrets: (...args: Parameters<typeof api.listSecrets>) => listSecrets(...args),
  saveSecret: (...args: Parameters<typeof api.saveSecret>) => saveSecret(...args),
  deleteSecret: (...args: Parameters<typeof api.deleteSecret>) => deleteSecret(...args),
}));

const FAKE_VALUE = "fake-database-url-0001";
const SAVED: api.SecretSummary = {
  secretId: "dsc_1",
  name: "DATABASE_URL",
  status: "active",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

function mount() {
  render(<RepositorySecrets repositoryConnectionId="rpc_1" repositoryName="acme/widgets" />);
}

function fill(name: string, value: string) {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Value"), { target: { value } });
}

beforeEach(() => {
  listSecrets.mockResolvedValue({ kind: "listed", secrets: [] });
  saveSecret.mockResolvedValue({ kind: "saved", secret: SAVED });
  deleteSecret.mockResolvedValue({ kind: "deleted" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a repository's secrets", () => {
  it("says what belongs here and that a value is never shown again", async () => {
    mount();
    expect(await screen.findByText("No secrets saved for this repository.")).toBeTruthy();
    expect(screen.getByText(/never save a production credential/)).toBeTruthy();
    expect(screen.getByLabelText("Value").getAttribute("type")).toBe("password");
  });

  it("sends a value once and keeps it nowhere on the page afterwards", async () => {
    listSecrets
      .mockResolvedValueOnce({ kind: "listed", secrets: [] })
      .mockResolvedValue({ kind: "listed", secrets: [SAVED] });
    mount();
    await screen.findByText("No secrets saved for this repository.");

    fill("DATABASE_URL", `${FAKE_VALUE}\n`);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The trailing line break a paste adds is dropped; nothing else is changed.
    await waitFor(() =>
      expect(saveSecret).toHaveBeenCalledWith("rpc_1", "DATABASE_URL", FAKE_VALUE),
    );
    expect(await screen.findByTestId("secret-row")).toBeTruthy();
    expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("clears the value even when the save is refused, and says why in words", async () => {
    saveSecret.mockResolvedValue({ kind: "invalid", reason: "name_platform_credential" });
    mount();
    await screen.findByText("No secrets saved for this repository.");

    fill("GITHUB_TOKEN", FAKE_VALUE);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("platform credential");
    expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("GITHUB_TOKEN");
    expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
  });

  it.each([
    [{ kind: "invalid", reason: "something_new" } as const, "That could not be saved."],
    [{ kind: "unreachable" } as const, "That could not be saved. Try again."],
  ])("reports %j", async (result, sentence) => {
    saveSecret.mockResolvedValue(result);
    mount();
    await screen.findByText("No secrets saved for this repository.");
    fill("DATABASE_URL", FAKE_VALUE);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(sentence);
  });

  it("will not submit without both a name and a value", async () => {
    mount();
    await screen.findByText("No secrets saved for this repository.");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fill("DATABASE_URL", "");
    expect(save.disabled).toBe(true);
    fill("   ", FAKE_VALUE);
    expect(save.disabled).toBe(true);
    fill("DATABASE_URL", FAKE_VALUE);
    expect(save.disabled).toBe(false);
  });

  it("removes a secret by name, and marks one that needs replacing", async () => {
    listSecrets
      .mockResolvedValueOnce({
        kind: "listed",
        secrets: [SAVED, { ...SAVED, secretId: "dsc_2", name: "OLD_KEY", status: "unreadable" }],
      })
      .mockResolvedValue({ kind: "listed", secrets: [] });
    mount();
    expect(await screen.findByText("Needs replacing")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove DATABASE_URL" }));

    await waitFor(() => expect(deleteSecret).toHaveBeenCalledWith("rpc_1", "DATABASE_URL"));
    expect(await screen.findByText("No secrets saved for this repository.")).toBeTruthy();
  });

  it("says so when a removal or the list fails", async () => {
    listSecrets.mockResolvedValueOnce({ kind: "listed", secrets: [SAVED] });
    deleteSecret.mockResolvedValue({ kind: "unreachable" });
    listSecrets.mockResolvedValue({ kind: "unreachable" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove DATABASE_URL" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The saved secrets could not be read. Try again.",
    );
  });

  it("treats a secret already gone as removed", async () => {
    listSecrets.mockResolvedValueOnce({ kind: "listed", secrets: [SAVED] });
    deleteSecret.mockResolvedValue({ kind: "not_found" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove DATABASE_URL" }));
    expect(await screen.findByText("No secrets saved for this repository.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

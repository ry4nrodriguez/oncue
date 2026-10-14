import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositorySummary } from "@/lib/api/setup";
import { RepositoryPicker, splitRepositoryName } from "./RepositoryPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const REPOSITORIES: readonly RepositorySummary[] = [
  { repositoryConnectionId: "rc_1", fullName: "acme/first" },
  { repositoryConnectionId: "rc_2", fullName: "acme/second" },
  { repositoryConnectionId: "rc_3", fullName: "acme/third" },
];

// Base UI activates a menu item from the pointer sequence, not a bare `click`, so drive the real sequence.
function pointerClick(element: Element) {
  fireEvent.pointerDown(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}

async function openMenu() {
  pointerClick(screen.getByRole("button"));
  return await screen.findByRole("menu");
}

describe("RepositoryPicker", () => {
  it("names the selected repository on the trigger", () => {
    render(<RepositoryPicker repositories={REPOSITORIES} selectedId="rc_2" onSelect={vi.fn()} />);
    expect(screen.getByRole("button").textContent).toContain("acme/second");
  });

  it("reports the repository the user picks", async () => {
    const onSelect = vi.fn();
    render(<RepositoryPicker repositories={REPOSITORIES} selectedId="rc_1" onSelect={onSelect} />);

    const menu = await openMenu();
    pointerClick(within(menu).getByRole("menuitemradio", { name: /acme\/third/ }));

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("rc_3");
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("marks exactly the selected row as checked", async () => {
    render(<RepositoryPicker repositories={REPOSITORIES} selectedId="rc_2" onSelect={vi.fn()} />);

    const menu = await openMenu();
    const checked = within(menu)
      .getAllByRole("menuitemradio")
      .filter((row) => row.getAttribute("aria-checked") === "true");

    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent).toContain("acme/second");
  });

  it("offers every connected repository", async () => {
    render(<RepositoryPicker repositories={REPOSITORIES} selectedId="rc_1" onSelect={vi.fn()} />);

    const menu = await openMenu();
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(3);
  });

  it("says so rather than disappearing when nothing is connected", () => {
    render(<RepositoryPicker repositories={[]} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByText("No repository")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the repository without offering a choice when the label is fixed", () => {
    render(
      <RepositoryPicker
        repositories={REPOSITORIES}
        selectedId="rc_1"
        onSelect={vi.fn()}
        fixedLabel="acme/second"
      />,
    );

    // The title carries the whole name where a narrow bar shows only part of it.
    expect(screen.getByTitle("acme/second").textContent).toBe("acme/second");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("splits the owner from the repository's own name, so a narrow bar can drop the owner", () => {
    expect(splitRepositoryName("acme/second")).toEqual(["acme/", "second"]);
    expect(splitRepositoryName("No repository")).toEqual(["", "No repository"]);

    render(<RepositoryPicker repositories={REPOSITORIES} selectedId="rc_2" onSelect={vi.fn()} />);
    const owner = screen.getByText("acme/");
    // Hidden by the bar's own width, never the window's.
    expect(owner.className).toContain("/strip:hidden");
    expect(owner.parentElement?.textContent).toBe("acme/second");
    cleanup();

    // With nothing chosen the control says so, and there is no owner to drop.
    render(<RepositoryPicker repositories={REPOSITORIES} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Choose a repository" }).textContent).toBe(
      "No repository",
    );
  });

  it("cannot be opened while disabled", () => {
    render(
      <RepositoryPicker
        repositories={REPOSITORIES}
        selectedId="rc_1"
        onSelect={vi.fn()}
        disabled
      />,
    );

    pointerClick(screen.getByRole("button"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("falls back to the empty label when the selected id is not connected", () => {
    render(
      <RepositoryPicker repositories={REPOSITORIES} selectedId="rc_gone" onSelect={vi.fn()} />,
    );

    expect(screen.getByRole("button").textContent).toContain("No repository");
  });
});

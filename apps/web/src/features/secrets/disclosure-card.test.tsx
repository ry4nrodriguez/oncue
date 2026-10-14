import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretRequests } from "@/lib/api/secrets";
import { type DisclosureAnswer, DisclosureCard } from "./DisclosureCard";

afterEach(cleanup);

const SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";

type Declared = Extract<SecretRequests, { kind: "declared" }>;

function declared(overrides: Partial<Declared> = {}): Declared {
  return {
    kind: "declared",
    baseSha: SHA,
    required: [{ name: "DATABASE_URL", saved: true, isNew: false }],
    optional: [
      { name: "STRIPE_TEST_KEY", saved: true, isNew: false },
      { name: "SENTRY_DSN", saved: false, isNew: false },
    ],
    ...overrides,
  };
}

function mount(requests: Extract<SecretRequests, { kind: "declared" | "invalid" }>) {
  const onConfirm = vi.fn<(answer: DisclosureAnswer) => void>();
  const onCancel = vi.fn<() => void>();
  render(
    <MemoryRouter>
      <DisclosureCard
        repositoryName="acme/widgets"
        requests={requests}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </MemoryRouter>,
  );
  return { onConfirm, onCancel };
}

describe("the disclosure card", () => {
  it("names the branch the file was read on when it is not the default, and nothing otherwise", () => {
    render(
      <MemoryRouter>
        <DisclosureCard
          repositoryName="acme/widgets"
          branch="release/1.4"
          requests={declared()}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("disclosure-branch").textContent).toContain("release/1.4");
    cleanup();
    render(
      <MemoryRouter>
        <DisclosureCard
          repositoryName="acme/widgets"
          branch="release/1.4"
          requests={{ kind: "invalid", baseSha: SHA, line: 2, reason: "bad" }}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("disclosure-branch")).toBeTruthy();
    cleanup();
    mount(declared());
    expect(screen.queryByTestId("disclosure-branch")).toBeNull();
  });

  it("shows the three groups: Required, Optional, and Missing", () => {
    mount(declared());

    expect(
      within(screen.getByTestId("disclosure-required")).getByText("DATABASE_URL"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("disclosure-optional")).getByLabelText("STRIPE_TEST_KEY"),
    ).toBeTruthy();
    const missing = screen.getByTestId("disclosure-missing");
    expect(within(missing).getByText("SENTRY_DSN")).toBeTruthy();
    expect(
      within(missing)
        .getByRole("link", { name: /Settings/ })
        .getAttribute("href"),
    ).toBe("/settings/repositories");
    expect(screen.getByText(/the model provider may see/)).toBeTruthy();
  });

  it("leaves every optional secret out until it is ticked, and sends names and the commit only", () => {
    const { onConfirm } = mount(declared());
    const box = screen.getByLabelText("STRIPE_TEST_KEY") as HTMLInputElement;
    expect(box.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(onConfirm).toHaveBeenLastCalledWith({
      baseSha: SHA,
      optional: [],
      startWithoutMissing: false,
    });

    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(onConfirm).toHaveBeenLastCalledWith({
      baseSha: SHA,
      optional: ["STRIPE_TEST_KEY"],
      startWithoutMissing: false,
    });
  });

  it("offers no checkbox for an optional secret with nothing saved", () => {
    mount(declared());
    expect(screen.queryByLabelText("SENTRY_DSN")).toBeNull();
  });

  it("makes starting without a required secret an explicit choice, and says what it costs", () => {
    const { onConfirm, onCancel } = mount(
      declared({ required: [{ name: "DATABASE_URL", saved: false, isNew: false }] }),
    );

    expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();
    expect(screen.getByText(/cannot end verified/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start anyway" }));
    expect(onConfirm).toHaveBeenCalledWith({
      baseSha: SHA,
      optional: [],
      startWithoutMissing: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("marks a name the repository did not ask for last time", () => {
    mount(declared({ required: [{ name: "DEPLOY_HOOK", saved: true, isNew: true }] }));
    const row = screen.getByText("DEPLOY_HOOK").closest("li") as HTMLElement;
    expect(within(row).getByText("New")).toBeTruthy();
  });

  it("shows a file the reader refused with its line and reason, and supplies nothing", () => {
    const { onConfirm } = mount({
      kind: "invalid",
      baseSha: SHA,
      line: 3,
      reason: '"GITHUB_TOKEN" is a platform credential',
    });

    expect(screen.getByText(/line 3/)).toBeTruthy();
    expect(screen.getByText(/"GITHUB_TOKEN" is a platform credential/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start without secrets" }));
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it("renders a repository's names as text", () => {
    mount(declared({ required: [{ name: "<b>X</b>", saved: true, isNew: false }] }));
    expect(screen.getByText("<b>X</b>")).toBeTruthy();
  });
});

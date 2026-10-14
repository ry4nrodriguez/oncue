import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConnectionRow } from "@/lib/api/model-connections";
import type { RuntimeSummary } from "@/lib/api/setup";

const listModelConnections = vi.fn();
vi.mock("@/lib/api/model-connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/model-connections")>()),
  listModelConnections: () => listModelConnections(),
}));

const { HarnessesSection } = await import("./HarnessesSection");

function summary(id: string): RuntimeSummary {
  return { id, name: id, providers: [], images: true, holdsToolCalls: true };
}

function key(
  provider: "anthropic" | "openai",
  status: ModelConnectionRow["status"],
): ModelConnectionRow {
  return {
    connectionId: `mc_${provider}_${status}`,
    provider,
    status,
    providerAccountHint: null,
    lastValidatedAt: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    activeSessions: 0,
  };
}

function listed(connections: readonly ModelConnectionRow[]) {
  return {
    kind: "listed",
    connections,
    catalog: { anthropic: [], openai: [] },
    pricesAsOf: "2026-09-25",
  };
}

beforeEach(() => {
  listModelConnections.mockReset();
});
afterEach(cleanup);

function renderSection(
  enabled: readonly RuntimeSummary[] | undefined,
  connected: ReadonlySet<"anthropic" | "openai"> = new Set(),
) {
  render(
    <MemoryRouter>
      <HarnessesSection enabled={enabled} connected={connected} />
    </MemoryRouter>,
  );
}

describe("Settings, Harnesses", () => {
  it("lists every harness the image installs, each in one of its states", async () => {
    // An Anthropic key only (and a revoked OpenAI one, which counts for nothing);
    // OpenCode and Codex enabled.
    listModelConnections.mockResolvedValue(
      listed([key("anthropic", "active"), key("openai", "revoked")]),
    );
    renderSection([summary("opencode"), summary("codex")]);
    const list = await screen.findByRole("list", { name: "Harnesses" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    const opencode = screen.getByTestId("harness-opencode");
    expect(within(opencode).getByText("OpenCode")).toBeTruthy();
    expect(within(opencode).getByText("Works with Anthropic and OpenAI keys")).toBeTruthy();
    expect(within(opencode).getByText("Ready")).toBeTruthy();
    expect(within(opencode).queryByRole("link")).toBeNull();

    const codex = screen.getByTestId("harness-codex");
    expect(within(codex).getByText("Works with an OpenAI key")).toBeTruthy();
    expect(within(codex).getByText("Connect an OpenAI key")).toBeTruthy();
    const connect = within(codex).getByRole("link", { name: "Connect an OpenAI key for Codex" });
    expect(connect.getAttribute("href")).toBe("/settings/model-providers");
    expect(connect.textContent).toBe("Connect");
  });

  it("shows nothing of a harness the image does not install, even when the Worker names it", async () => {
    listModelConnections.mockResolvedValue(listed([key("anthropic", "active")]));
    renderSection([summary("opencode"), summary("pi"), summary("claude")]);
    const list = await screen.findByRole("list", { name: "Harnesses" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByTestId("harness-pi")).toBeNull();
    expect(screen.queryByTestId("harness-claude")).toBeNull();
    expect(screen.queryByText("Claude Code")).toBeNull();
    expect(screen.queryByText("Pi")).toBeNull();
  });

  it("asks for either key for a harness that takes both", async () => {
    listModelConnections.mockResolvedValue(listed([]));
    renderSection([summary("opencode")]);
    expect(
      within(await screen.findByTestId("harness-opencode")).getByText(
        "Connect an Anthropic or OpenAI key",
      ),
    ).toBeTruthy();
  });

  it("enables OpenCode alone when the Worker sent no list", async () => {
    listModelConnections.mockResolvedValue(listed([key("openai", "active")]));
    renderSection(undefined);
    expect(within(await screen.findByTestId("harness-opencode")).getByText("Ready")).toBeTruthy();
    expect(within(screen.getByTestId("harness-codex")).getByText("Not available yet")).toBeTruthy();
  });

  it("draws from the identity's keys at once, and keeps them when the fresh read fails", async () => {
    let resolve: (value: unknown) => void = () => {};
    listModelConnections.mockReturnValue(new Promise((done) => (resolve = done)));
    renderSection([summary("opencode"), summary("codex")], new Set(["openai"]));
    expect(within(screen.getByTestId("harness-codex")).getByText("Ready")).toBeTruthy();
    resolve({ kind: "unreachable" });
    await Promise.resolve();
    expect(within(screen.getByTestId("harness-codex")).getByText("Ready")).toBeTruthy();
  });

  it("lets the fresh read correct a stale identity", async () => {
    listModelConnections.mockResolvedValue(listed([key("openai", "active")]));
    renderSection([summary("opencode"), summary("codex")], new Set());
    expect(
      within(screen.getByTestId("harness-codex")).getByText("Connect an OpenAI key"),
    ).toBeTruthy();
    expect(await within(screen.getByTestId("harness-codex")).findByText("Ready")).toBeTruthy();
  });
});

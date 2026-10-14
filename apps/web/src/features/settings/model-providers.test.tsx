import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelConnectionRow } from "@/lib/api/model-connections";
import type { ModelSpecSummary } from "@/lib/api/setup";
import { ModelProvidersSection } from "./ModelProvidersSection";

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

const OPUS: ModelSpecSummary = {
  modelId: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  effort: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "medium",
  price: { inputPerMTok: 4, outputPerMTok: 20 },
  status: "current",
  recommended: true,
};
const SONNET_45: ModelSpecSummary = {
  modelId: "claude-sonnet-4-5-20250929",
  name: "Claude Sonnet 4.5",
  contextWindow: 200_000,
  effort: null,
  defaultEffort: null,
  price: { inputPerMTok: 3, outputPerMTok: 15 },
  status: "legacy",
  recommended: false,
};
const SOL: ModelSpecSummary = {
  modelId: "gpt-6-sol",
  name: "GPT-6 Sol",
  contextWindow: 1_000_000,
  effort: ["none", "low", "medium", "high", "xhigh"],
  defaultEffort: "medium",
  price: { inputPerMTok: 2, outputPerMTok: 10 },
  status: "current",
  recommended: true,
};
const CATALOG = { anthropic: [OPUS, SONNET_45], openai: [SOL] };

const ANTHROPIC_KEY: ModelConnectionRow = {
  connectionId: "c1",
  provider: "anthropic",
  status: "active",
  providerAccountHint: "ends 4f21",
  lastValidatedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
  activeSessions: 2,
};

function listing(connections: readonly ModelConnectionRow[]) {
  return { connections, catalog: CATALOG, pricesAsOf: "2026-09-23" };
}

/** A fetch that answers the list once and hands every later request to `then`. */
function stubFetch(
  connections: readonly ModelConnectionRow[],
  then: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
    jsonResponse(500, {}),
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    url === "/api/model-connections" && (init?.method ?? "GET") === "GET"
      ? jsonResponse(200, listing(connections))
      : then(url, init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderLoaded(onChanged?: () => void) {
  render(<ModelProvidersSection {...(onChanged ? { onChanged } : {})} />);
  await screen.findByTestId("provider-card-anthropic");
}

describe("ModelProvidersSection", () => {
  it("draws a card per provider, connected or not, with the catalog beneath each", async () => {
    stubFetch([ANTHROPIC_KEY]);
    await renderLoaded();

    const anthropic = screen.getByTestId("provider-card-anthropic");
    expect(within(anthropic).getByTestId("provider-status-anthropic").textContent).toBe(
      "ends 4f21 · validated 2026-09-01",
    );
    expect(within(anthropic).getByText("Active")).not.toBeNull();
    expect(
      within(anthropic).getByRole("button", { name: "Replace the Anthropic key" }),
    ).not.toBeNull();
    expect(
      within(anthropic).getByRole("button", { name: "Revoke the Anthropic key" }),
    ).not.toBeNull();
    // The facts the picker no longer shows live here: price, context, levels.
    const opus = within(anthropic).getByTestId("model-row-claude-opus-5-5");
    expect(opus.textContent).toContain("Claude Opus 5.5");
    expect(opus.textContent).toContain("Recommended");
    expect(opus.textContent).toContain("$4 in / $20 out per MTok");
    expect(opus.textContent).toContain("1M context");
    expect(opus.textContent).toContain("low · medium · high · xhigh · max");
    const sonnet = within(anthropic).getByTestId("model-row-claude-sonnet-4-5-20250929");
    expect(sonnet.textContent).toContain("Legacy");
    expect(sonnet.textContent).toContain("No effort setting");

    const openai = screen.getByTestId("provider-card-openai");
    expect(within(openai).getByTestId("provider-status-openai").textContent).toBe("Not connected");
    expect(within(openai).getByRole("button", { name: "Connect OpenAI" })).not.toBeNull();
    expect(within(openai).getByText("Connect a key to use these models.")).not.toBeNull();
    expect(within(openai).getByTestId("model-row-gpt-6-sol").textContent).toContain("GPT-6 Sol");
    expect(screen.getByText(/list prices per million tokens on 2026-09-23/)).not.toBeNull();
  });

  it("treats a revoked row as no key, so the card offers Connect again", async () => {
    stubFetch([{ ...ANTHROPIC_KEY, status: "revoked" }]);
    await renderLoaded();

    expect(screen.getByTestId("provider-status-anthropic").textContent).toBe("Not connected");
    expect(screen.getByRole("button", { name: "Connect Anthropic" })).not.toBeNull();
  });

  it("connects a provider from its card with the provider fixed, then shows it connected", async () => {
    const created: ModelConnectionRow = {
      ...ANTHROPIC_KEY,
      connectionId: "c9",
      provider: "openai",
      providerAccountHint: "ends 9c03",
      activeSessions: 0,
    };
    const fetchMock = stubFetch([ANTHROPIC_KEY], () => jsonResponse(201, { connection: created }));
    await renderLoaded();

    const openai = screen.getByTestId("provider-card-openai");
    fireEvent.click(within(openai).getByRole("button", { name: "Connect OpenAI" }));
    // No provider choice: the card already said which.
    expect(within(openai).queryByRole("radio", { name: "OpenAI" })).toBeNull();
    fireEvent.change(within(openai).getByLabelText("API key"), {
      target: { value: "sk-proj-good" },
    });
    fireEvent.click(within(openai).getByRole("button", { name: /^Connect$/ }));

    await waitFor(() =>
      expect(within(openai).getByTestId("provider-status-openai").textContent).toBe(
        "ends 9c03 · validated 2026-09-01",
      ),
    );
    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({
      provider: "openai",
      credential: "sk-proj-good",
    });
    expect(within(openai).queryByText("Connect a key to use these models.")).toBeNull();
  });

  it("replaces a key under the same connection and keeps its session count", async () => {
    const replaced: ModelConnectionRow = {
      ...ANTHROPIC_KEY,
      providerAccountHint: "ends 7777",
      lastValidatedAt: "2026-09-23T00:00:00.000Z",
      activeSessions: 0,
    };
    const fetchMock = stubFetch([{ ...ANTHROPIC_KEY, status: "invalid" }], () =>
      jsonResponse(200, { connection: replaced }),
    );
    await renderLoaded();

    const anthropic = screen.getByTestId("provider-card-anthropic");
    expect(within(anthropic).getByText("Invalid")).not.toBeNull();
    fireEvent.click(within(anthropic).getByRole("button", { name: "Replace the Anthropic key" }));
    fireEvent.change(within(anthropic).getByLabelText("API key"), {
      target: { value: "sk-ant-new" },
    });
    fireEvent.click(within(anthropic).getByRole("button", { name: "Replace key" }));

    await waitFor(() =>
      expect(within(anthropic).getByTestId("provider-status-anthropic").textContent).toBe(
        "ends 7777 · validated 2026-09-23",
      ),
    );
    expect(within(anthropic).getByText("Active")).not.toBeNull();
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put?.[0]).toBe("/api/model-connections/c1");
    // The count came from the list; a replace reports the connection alone.
    fireEvent.click(within(anthropic).getByRole("button", { name: "Revoke the Anthropic key" }));
    expect(screen.getByTestId("revoke-dialog").textContent).toContain(
      "2 active sessions are using this key",
    );
  });

  it("asks before revoking, naming the sessions that still use the key, and then destroys it", async () => {
    const fetchMock = stubFetch([ANTHROPIC_KEY], () =>
      jsonResponse(200, { connection: { ...ANTHROPIC_KEY, status: "revoked" } }),
    );
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Revoke the Anthropic key" }));
    const dialog = screen.getByTestId("revoke-dialog");
    expect(dialog.textContent).toContain("Revoke the Anthropic key?");
    expect(dialog.textContent).toContain(
      "2 active sessions are using this key. Each pauses at its next model request until you connect a working key and start a new session.",
    );
    // Nothing has been sent yet.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));

    await waitFor(() =>
      expect(screen.getByTestId("provider-status-anthropic").textContent).toBe("Not connected"),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/model-connections/c1/revoke", { method: "POST" });
    expect(screen.queryByTestId("revoke-dialog")).toBeNull();
  });

  it("words the dialog for one session and for none", async () => {
    stubFetch([{ ...ANTHROPIC_KEY, activeSessions: 1 }]);
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Revoke the Anthropic key" }));
    expect(screen.getByTestId("revoke-dialog").textContent).toContain(
      "1 active session is using this key.",
    );
    cleanup();
    vi.unstubAllGlobals();

    stubFetch([{ ...ANTHROPIC_KEY, activeSessions: 0 }]);
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Revoke the Anthropic key" }));
    expect(screen.getByTestId("revoke-dialog").textContent).toContain(
      "No active session is using this key.",
    );
  });

  it("keeps the dialog open and says so when a revoke fails", async () => {
    stubFetch([ANTHROPIC_KEY], () => jsonResponse(500, {}));
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Revoke the Anthropic key" }));
    fireEvent.click(
      within(screen.getByTestId("revoke-dialog")).getByRole("button", { name: "Revoke key" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("could not be revoked"),
    );
    expect(screen.getByTestId("provider-status-anthropic").textContent).toBe(
      "ends 4f21 · validated 2026-09-01",
    );
    fireEvent.click(
      within(screen.getByTestId("revoke-dialog")).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByTestId("revoke-dialog")).toBeNull());
  });

  it("lists a second key of the same provider as one to revoke, since one key per provider is the rule", async () => {
    const second: ModelConnectionRow = {
      ...ANTHROPIC_KEY,
      connectionId: "c2",
      providerAccountHint: "ends 0000",
      activeSessions: 0,
    };
    stubFetch([ANTHROPIC_KEY, second]);
    await renderLoaded();

    const anthropic = screen.getByTestId("provider-card-anthropic");
    expect(anthropic.textContent).toContain("Another Anthropic key, ends 0000");
    expect(
      within(anthropic).getByRole("button", { name: "Revoke the Anthropic key ends 0000" }),
    ).not.toBeNull();
  });

  describe("Re-check", () => {
    function recheckButton() {
      return within(screen.getByTestId("provider-card-anthropic")).getByRole("button", {
        name: "Re-check the Anthropic key",
      });
    }

    it("returns an invalid key to Active when the provider accepts it, and says so", async () => {
      const accepted: ModelConnectionRow = {
        ...ANTHROPIC_KEY,
        lastValidatedAt: "2026-10-13T00:00:00.000Z",
        activeSessions: 0,
      };
      const fetchMock = stubFetch([{ ...ANTHROPIC_KEY, status: "invalid" }], () =>
        jsonResponse(200, { connection: accepted, check: "accepted" }),
      );
      const onChanged = vi.fn();
      await renderLoaded(onChanged);
      const anthropic = screen.getByTestId("provider-card-anthropic");
      expect(within(anthropic).getByText("Invalid")).not.toBeNull();

      fireEvent.click(recheckButton());

      const result = await screen.findByTestId("recheck-result-anthropic");
      expect(result.textContent).toBe("Anthropic accepted this key.");
      expect(result.getAttribute("role")).toBe("status");
      expect(within(anthropic).getByText("Active")).not.toBeNull();
      expect(within(anthropic).getByTestId("provider-status-anthropic").textContent).toBe(
        "ends 4f21 · validated 2026-10-13",
      );
      expect(fetchMock).toHaveBeenCalledWith("/api/model-connections/c1/recheck", {
        method: "POST",
      });
      expect(onChanged).toHaveBeenCalledTimes(1);
      // The session count came from the list; a re-check reports the connection alone.
      fireEvent.click(within(anthropic).getByRole("button", { name: "Revoke the Anthropic key" }));
      expect(screen.getByTestId("revoke-dialog").textContent).toContain("2 active sessions");
    });

    it("marks the key Invalid when the provider rejects it, and says to replace it", async () => {
      stubFetch([ANTHROPIC_KEY], () =>
        jsonResponse(200, {
          connection: { ...ANTHROPIC_KEY, status: "invalid" },
          check: "rejected",
        }),
      );
      const onChanged = vi.fn();
      await renderLoaded(onChanged);

      fireEvent.click(recheckButton());

      expect((await screen.findByTestId("recheck-result-anthropic")).textContent).toBe(
        "Anthropic rejected this key. Replace it to keep using these models.",
      );
      expect(
        within(screen.getByTestId("provider-card-anthropic")).getByText("Invalid"),
      ).not.toBeNull();
      expect(onChanged).toHaveBeenCalledTimes(1);
    });

    it("changes nothing when the provider could not be reached, and says that", async () => {
      stubFetch([{ ...ANTHROPIC_KEY, status: "invalid" }], () =>
        jsonResponse(200, {
          connection: { ...ANTHROPIC_KEY, status: "invalid" },
          check: "unreachable",
        }),
      );
      await renderLoaded();

      fireEvent.click(recheckButton());

      expect((await screen.findByTestId("recheck-result-anthropic")).textContent).toBe(
        "OnCue couldn't reach Anthropic, so nothing changed. Try again in a moment.",
      );
      expect(
        within(screen.getByTestId("provider-card-anthropic")).getByText("Invalid"),
      ).not.toBeNull();
    });

    it("shows the check under way and offers no second one meanwhile", async () => {
      let answer: (response: Response) => void = () => undefined;
      stubFetch(
        [ANTHROPIC_KEY],
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      await renderLoaded();

      fireEvent.click(recheckButton());

      const busy = await screen.findByRole("button", { name: "Re-check the Anthropic key" });
      expect(busy.textContent).toBe("Checking…");
      expect((busy as HTMLButtonElement).disabled).toBe(true);
      answer(jsonResponse(200, { connection: ANTHROPIC_KEY, check: "accepted" }));
      await screen.findByTestId("recheck-result-anthropic");
      expect(recheckButton().textContent).toBe("Re-check");
    });

    it.each([
      [409, "This key is no longer connected. Reload to see your keys."],
      [404, "This key is no longer connected. Reload to see your keys."],
      [401, "You're signed out. Sign in again to check this key."],
      [503, "OnCue couldn't check this key. Try again in a moment."],
      [500, "OnCue couldn't check this key. Try again in a moment."],
    ])(
      "says what happened when the check itself answers %i, leaving the row alone",
      async (status, words) => {
        stubFetch([ANTHROPIC_KEY], () => jsonResponse(status, {}));
        const onChanged = vi.fn();
        await renderLoaded(onChanged);

        fireEvent.click(recheckButton());

        expect((await screen.findByTestId("recheck-result-anthropic")).textContent).toBe(words);
        expect(
          within(screen.getByTestId("provider-card-anthropic")).getByText("Active"),
        ).not.toBeNull();
        expect(onChanged).not.toHaveBeenCalled();
      },
    );

    it("offers no re-check for a provider with no key", async () => {
      stubFetch([ANTHROPIC_KEY]);
      await renderLoaded();
      expect(
        within(screen.getByTestId("provider-card-openai")).queryByRole("button", {
          name: /Re-check/,
        }),
      ).toBeNull();
    });
  });

  describe("telling the rest of the app its keys changed", () => {
    it("says so after a connect, a replace, and a revoke, and not after a failed revoke", async () => {
      const created: ModelConnectionRow = {
        ...ANTHROPIC_KEY,
        connectionId: "c9",
        provider: "openai",
        activeSessions: 0,
      };
      let revokeStatus = 500;
      stubFetch([ANTHROPIC_KEY], (url, init) => {
        if (url.endsWith("/revoke")) {
          return jsonResponse(revokeStatus, {
            connection: { ...ANTHROPIC_KEY, status: "revoked" },
          });
        }
        return init?.method === "PUT"
          ? jsonResponse(200, { connection: ANTHROPIC_KEY })
          : jsonResponse(201, { connection: created });
      });
      const onChanged = vi.fn();
      await renderLoaded(onChanged);
      expect(onChanged).not.toHaveBeenCalled();

      const openai = screen.getByTestId("provider-card-openai");
      fireEvent.click(within(openai).getByRole("button", { name: "Connect OpenAI" }));
      fireEvent.change(within(openai).getByLabelText("API key"), { target: { value: "sk-new" } });
      fireEvent.click(within(openai).getByRole("button", { name: /^Connect$/ }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

      const anthropic = screen.getByTestId("provider-card-anthropic");
      fireEvent.click(within(anthropic).getByRole("button", { name: "Replace the Anthropic key" }));
      fireEvent.change(within(anthropic).getByLabelText("API key"), {
        target: { value: "sk-ant-new" },
      });
      fireEvent.click(within(anthropic).getByRole("button", { name: "Replace key" }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));

      fireEvent.click(within(anthropic).getByRole("button", { name: "Revoke the Anthropic key" }));
      fireEvent.click(
        within(screen.getByTestId("revoke-dialog")).getByRole("button", { name: "Revoke key" }),
      );
      await screen.findByRole("alert");
      expect(onChanged).toHaveBeenCalledTimes(2);

      revokeStatus = 200;
      fireEvent.click(
        within(screen.getByTestId("revoke-dialog")).getByRole("button", { name: "Revoke key" }),
      );
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3));
    });
  });

  it("shows a denied message on 401 and an unreachable message on a server error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, {})),
    );
    render(<ModelProvidersSection />);
    expect(
      await screen.findByText("You don't have access to view model providers."),
    ).not.toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, {})),
    );
    render(<ModelProvidersSection />);
    expect(
      await screen.findByText("OnCue couldn't load your providers. Try again in a moment."),
    ).not.toBeNull();
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApprovalSettingsResult,
  parseApprovalSettingsResponse,
  readApprovalSettings,
  removeApprovalRule,
  setApprovalDefault,
} from "@/lib/api/approval-settings";
import { AgentPermissionsSection } from "./AgentPermissionsSection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SAVED: ApprovalSettingsResult = {
  kind: "read",
  settings: {
    defaultMode: "always",
    rules: [
      { category: "outside_project", createdAt: "2026-10-04T12:00:00.000Z" },
      { category: "repeated_action", createdAt: "2026-10-04T13:00:00.000Z" },
    ],
  },
};

function api(read: ApprovalSettingsResult = SAVED) {
  return {
    read: vi.fn(async () => read),
    setDefault: vi.fn(
      async (mode: "ask" | "always"): Promise<ApprovalSettingsResult> => ({
        kind: "read",
        settings: { defaultMode: mode, rules: read.kind === "read" ? read.settings.rules : [] },
      }),
    ),
    remove: vi.fn(
      async (): Promise<ApprovalSettingsResult> => ({
        kind: "read",
        settings: {
          defaultMode: "always",
          rules: SAVED.kind === "read" ? [SAVED.settings.rules[1] as never] : [],
        },
      }),
    ),
  };
}

describe("AgentPermissionsSection", () => {
  it("lists each default with what it does, and checks the one in force", async () => {
    render(<AgentPermissionsSection api={api()} />);
    const always = await screen.findByRole<HTMLInputElement>("radio", { name: "Always allow" });
    const ask = screen.getByRole<HTMLInputElement>("radio", { name: "Allow once" });
    expect(always.checked).toBe(true);
    expect(ask.checked).toBe(false);
    expect(screen.getByTestId("approval-default-ask").textContent).toContain("Ask me each time");
    expect(screen.getByTestId("approval-default-always").textContent).toContain(
      "Don't ask in any session",
    );
    expect(screen.queryByRole("radio", { name: /this session/ })).toBeNull();
    expect(document.body.textContent).toContain("Secret files such as .env always ask");
    expect(document.body.textContent).toContain("Codex and Pi don't ask");
  });

  it("switches the default both ways, and ignores choosing the one in force", async () => {
    const calls = api();
    render(<AgentPermissionsSection api={calls} />);
    fireEvent.click(await screen.findByRole("radio", { name: /^Always allow/ }));
    expect(calls.setDefault).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /^Allow once/ }));
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>("radio", { name: "Allow once" }).checked).toBe(
        true,
      ),
    );
    expect(calls.setDefault).toHaveBeenCalledWith("ask");
    fireEvent.click(screen.getByRole("radio", { name: /^Always allow/ }));
    await waitFor(() => expect(calls.setDefault).toHaveBeenLastCalledWith("always"));
  });

  it("says when a change failed", async () => {
    const calls = api({ kind: "read", settings: { defaultMode: "ask", rules: [] } });
    calls.setDefault.mockResolvedValueOnce({ kind: "unreachable" });
    render(<AgentPermissionsSection api={calls} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Always allow" }));
    expect((await screen.findByRole("status")).textContent).toContain("couldn't save");
  });

  it("shows loading until the first read answers, and says when it could not read", async () => {
    render(
      <AgentPermissionsSection
        api={{ ...api(), read: () => new Promise<ApprovalSettingsResult>(() => undefined) }}
      />,
    );
    expect(screen.getByTestId("approval-default-loading").textContent).toContain("Loading");
    expect(screen.queryByRole("radio")).toBeNull();
    cleanup();
    render(<AgentPermissionsSection api={api({ kind: "unreachable" })} />);
    expect((await screen.findByTestId("approval-default-loading")).textContent).toContain(
      "Could not read",
    );
  });
});

describe("the approval settings client", () => {
  it("parses the Worker's body and drops what it does not know", () => {
    expect(
      parseApprovalSettingsResponse(200, {
        defaultMode: "always",
        rules: [
          { category: "outside_project", createdAt: "t" },
          { category: "everything", createdAt: "t" },
          { category: "repeated_action" },
          null,
        ],
      }),
    ).toEqual({
      kind: "read",
      settings: { defaultMode: "always", rules: [{ category: "outside_project", createdAt: "t" }] },
    });
  });

  it("never reads an unreadable body as nothing saved", () => {
    expect(parseApprovalSettingsResponse(200, { defaultMode: "session", rules: [] })).toEqual({
      kind: "unreachable",
    });
    expect(parseApprovalSettingsResponse(200, { defaultMode: "ask" })).toEqual({
      kind: "unreachable",
    });
    expect(parseApprovalSettingsResponse(500, null)).toEqual({ kind: "unreachable" });
    expect(parseApprovalSettingsResponse(401, null)).toEqual({ kind: "denied" });
    expect(parseApprovalSettingsResponse(403, null)).toEqual({ kind: "denied" });
  });

  it("calls the three routes", async () => {
    const seen: { url: string; method: string; body: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? "GET", body: (init?.body as string) ?? null });
      return Response.json({ defaultMode: "ask", rules: [] });
    });
    await readApprovalSettings();
    await setApprovalDefault("always");
    await removeApprovalRule("other_request");
    expect(seen).toEqual([
      { url: "/api/approval-settings", method: "GET", body: null },
      { url: "/api/approval-settings/default", method: "PUT", body: '{"mode":"always"}' },
      { url: "/api/approval-settings/rules/other_request", method: "DELETE", body: null },
    ]);
  });

  it("is unreachable when the network fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await readApprovalSettings()).toEqual({ kind: "unreachable" });
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelConnectionRow } from "@/lib/api/model-connections";
import { AddConnectionForm } from "./AddConnectionForm";

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

const CREATED: ModelConnectionRow = {
  connectionId: "new2",
  provider: "anthropic",
  status: "active",
  providerAccountHint: "ends 1122",
  lastValidatedAt: "2026-09-04T00:00:00.000Z",
  createdAt: "2026-09-04T00:00:00.000Z",
  activeSessions: 0,
};

describe("AddConnectionForm", () => {
  it("refuses to submit an empty key without calling the network", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();

    render(<AddConnectionForm onSaved={onSaved} />);

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(screen.getByText("Enter a key before saving.")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("says where the key goes in one line of text, not a boxed notice, until an error replaces it", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AddConnectionForm onSaved={() => {}} />);

    const note = screen.getByText(/Stored encrypted and never shown again/);
    expect(note.textContent).toContain("A sandbox never receives it.");
    expect(note.className).not.toMatch(/\bborder\b/);

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.queryByText(/Stored encrypted and never shown again/)).toBeNull();
  });

  it("lets a provider be chosen before submitting", () => {
    render(<AddConnectionForm onSaved={() => {}} />);

    const anthropic = screen.getByRole("radio", { name: "Anthropic" }) as HTMLInputElement;
    const openai = screen.getByRole("radio", { name: "OpenAI" }) as HTMLInputElement;
    expect(anthropic.checked).toBe(true);
    expect(openai.checked).toBe(false);

    fireEvent.click(openai);

    expect(openai.checked).toBe(true);
    expect(anthropic.checked).toBe(false);
  });

  it("hides the choice and posts the fixed provider when one is given", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(201, { connection: CREATED }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();

    render(<AddConnectionForm provider="openai" primaryLabel="Connect" onSaved={onSaved} />);

    // The radios are still in the tree for the form's shape, but hidden.
    expect(screen.getByRole("radio", { name: "OpenAI", hidden: true })).not.toBeNull();
    expect(screen.queryByRole("radio", { name: "OpenAI" })).toBeNull();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-proj-good" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(CREATED));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      provider: "openai",
      credential: "sk-proj-good",
    });
  });

  it("replaces the key under the same connection when asked to", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, { connection: CREATED }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();

    render(
      <AddConnectionForm
        provider="anthropic"
        replaceConnectionId="new2"
        primaryLabel="Replace key"
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(CREATED));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/model-connections/new2");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
  });

  it("says a provider already holds a key on a 409, and that a vanished connection cannot be replaced on a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(409, { error: "already_connected", connectionId: "c1" })),
    );
    render(<AddConnectionForm onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "A key for this provider is already connected. Replace it under Settings, Model providers.",
        ),
      ).not.toBeNull(),
    );
    cleanup();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: "not_found" })),
    );
    render(<AddConnectionForm replaceConnectionId="gone" onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() =>
      expect(
        screen.getByText("That connection no longer exists. Connect the provider again."),
      ).not.toBeNull(),
    );
  });

  it("maps a 400 invalid-request reason to its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { error: "invalid_request", reason: "provider" })),
    );

    render(<AddConnectionForm onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() =>
      expect(screen.getByText("Choose a provider before saving.")).not.toBeNull(),
    );
  });

  it("renders the plain-language sentence for a 422 validation failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(422, { error: "validation_failed", category: "authentication_failed" }),
      ),
    );

    render(<AddConnectionForm onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/revoked/));
  });

  it("shows a generic message when the server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    render(<AddConnectionForm onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() =>
      expect(
        screen.getByText("OnCue couldn't reach the server. Check your connection and try again."),
      ).not.toBeNull(),
    );
  });

  it("shows Validating while the request is in flight and clears the key afterwards", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((res) => {
            resolve = res;
          }),
      ),
    );
    render(<AddConnectionForm onSaved={() => {}} />);
    const field = screen.getByLabelText("API key") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "sk-ant-good" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(screen.getByRole("button", { name: "Validating…" })).not.toBeNull();
    resolve(jsonResponse(201, { connection: CREATED }));
    await waitFor(() => expect(field.value).toBe(""));
  });
});

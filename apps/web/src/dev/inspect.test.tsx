import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "./inspect";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {}
  send(): void {}
}

const IDENTITY = { userId: "user_1", workspaceId: "ws_1" };

describe("Inspector", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    FakeWebSocket.instances = [];
  });

  it("starts idle with the message box and New session button visible", () => {
    render(<Inspector {...IDENTITY} />);
    expect(screen.getByTestId("inspector-header").textContent).toBe("OnCue inspector");
    expect(screen.getByTestId("inspector-workspace").textContent).toBe(
      "Workspace: ws_1 · Signed in as user_1",
    );
    expect(screen.getByTestId("inspector-status").textContent).toBe("Idle");
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
    expect(screen.getByLabelText("Instruction")).toBeTruthy();
  });

  it("creates a session over HTTP, connects over the client socket, and renders live rows", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ sessionId: "session-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Inspector {...IDENTITY} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions");

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    expect(socket.url).toContain("/ws/sessions/session-1/client?after=0");

    socket.onmessage?.({
      data: JSON.stringify({
        type: "runtime.connected",
        sandboxGeneration: 1,
        runtimeSequence: 0,
        sessionSequence: 1,
      }),
    });
    expect(await screen.findByTestId("row-1")).toBeTruthy();

    socket.onmessage?.({ data: JSON.stringify({ type: "caught_up", through: 1 }) });
    expect(await screen.findByTestId("inspector-status")).toHaveProperty(
      "textContent",
      "Caught up",
    );
  });

  it("posts the commandId/instruction/fake shape with the default script", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ sessionId: "session-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Inspector {...IDENTITY} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(typeof body.commandId).toBe("string");
    expect(body.instruction).toEqual({
      messageId: body.commandId,
      text: "Say hello and run the checks.",
      attachments: [],
    });
    expect(body.fake).toEqual({ scriptName: "seven-event", framePacingMs: 120 });
  });

  it("reads the fake driver's scriptName from a ?script= query param", async () => {
    window.history.pushState({}, "", "/?script=long-stream");
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ sessionId: "session-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Inspector {...IDENTITY} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.fake.scriptName).toBe("long-stream");

    window.history.pushState({}, "", "/");
  });

  it("lets the message box text be edited", () => {
    render(<Inspector {...IDENTITY} />);
    const input = screen.getByLabelText("Instruction") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Refactor the parser." } });
    expect(input.value).toBe("Refactor the parser.");
  });

  it("reconnects on mount to a session id cached by an earlier tab load", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    window.sessionStorage.setItem("oncue:dev:inspect:current-session", "cached-session");

    render(<Inspector {...IDENTITY} />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(FakeWebSocket.instances[0]?.url).toContain("/ws/sessions/cached-session/client");
  });

  it("reports a socket error when session creation fails", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "admission stopped" }), { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Inspector {...IDENTITY} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    const status = await screen.findByTestId("inspector-status");
    await waitFor(() => expect(status.textContent).toBe("Error: create session failed: 503"));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

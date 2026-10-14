/**
 * Thin render over `./stream.ts`'s pure reducer; no inspector logic lives
 * here. Served only by `vite-plugins/dev-inspect.ts` under `vite dev`, never
 * built. The bootstrap requires a real sign-in through `AuthGate` (no bypass
 * flag); `Inspector` takes the verified ids as props, so tests render it
 * directly.
 */
import { ClerkProvider } from "@clerk/react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../components/ui/button";
import { AuthGate } from "../features/auth/AuthGate";
import { CLERK_APPEARANCE } from "../lib/clerk-appearance";
import { ThemeProvider } from "../lib/theme";
import "../styles/globals.css";
import {
  cacheEphemeralRow,
  emptyInspectorState,
  parseWireFrame,
  readCachedEphemeralRows,
  readCachedSessionId,
  reduceInspector,
  rowFromEvent,
  statusLabel,
  visibleRows,
  writeCachedSessionId,
} from "./stream";

/**
 * Seven frames at this interval finish within one second while leaving the
 * socket time to attach, so the ephemeral deltas (never replayed) are seen live.
 */
const INSPECTOR_FRAME_PACING_MS = 120;

interface CreateSessionResponse {
  readonly sessionId: string;
}

function socketUrl(sessionId: string): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws/sessions/${sessionId}/client?after=0`;
}

export interface InspectorProps {
  readonly userId: string;
  readonly workspaceId: string;
}

export function Inspector({ userId, workspaceId }: InspectorProps) {
  const [state, dispatch] = useReducer(reduceInspector, undefined, emptyInspectorState);
  const [messageText, setMessageText] = useState("Say hello and run the checks.");
  const socketRef = useRef<WebSocket | null>(null);

  // `dispatch` and `socketRef` are stable, so this keeps its identity and the
  // mount effect can depend on it without re-running.
  const connect = useCallback((sessionId: string) => {
    socketRef.current?.close();
    const socket = new WebSocket(socketUrl(sessionId));
    socket.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      const frame = parseWireFrame(raw);
      if (frame.kind === "event") {
        const row = rowFromEvent(frame.event);
        if (row !== null) {
          cacheEphemeralRow(window.sessionStorage, sessionId, row);
        }
      }
      dispatch({ kind: "frame", frame });
    };
    socket.onclose = () => dispatch({ kind: "socket_closed" });
    socket.onerror = () => dispatch({ kind: "socket_error", message: "the WebSocket errored" });
    socketRef.current = socket;
  }, []);

  // Mount-only: a reload resumes this tab's last session, reading the cache
  // before the socket so cached rows are present from the first render.
  useEffect(() => {
    const cachedSessionId = readCachedSessionId(window.sessionStorage);
    if (cachedSessionId === null) {
      return;
    }
    dispatch({ kind: "session_started", sessionId: cachedSessionId });
    dispatch({
      kind: "hydrated",
      rows: readCachedEphemeralRows(window.sessionStorage, cachedSessionId),
    });
    connect(cachedSessionId);
    return () => socketRef.current?.close();
  }, [connect]);

  async function startNewSession(): Promise<void> {
    // The `fake` hint is refused by the hosted Worker (`selectFakeDriver`), so
    // this only works locally.
    const commandId = crypto.randomUUID();
    const script = new URLSearchParams(window.location.search).get("script") ?? "seven-event";
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId,
        instruction: { messageId: commandId, text: messageText, attachments: [] },
        fake: { scriptName: script, framePacingMs: INSPECTOR_FRAME_PACING_MS },
      }),
    });
    if (!response.ok) {
      dispatch({ kind: "socket_error", message: `create session failed: ${response.status}` });
      return;
    }
    const body = (await response.json()) as CreateSessionResponse;
    writeCachedSessionId(window.sessionStorage, body.sessionId);
    dispatch({ kind: "session_started", sessionId: body.sessionId });
    connect(body.sessionId);
  }

  const rows = useMemo(() => visibleRows(state), [state]);

  return (
    <main className="flex min-h-screen flex-col gap-4 bg-background p-6 text-foreground">
      <h1 className="font-semibold text-2xl" data-testid="inspector-header">
        OnCue inspector
      </h1>
      <p className="text-foreground/70 text-sm" data-testid="inspector-workspace">
        Workspace: {workspaceId} · Signed in as {userId}
      </p>
      <p data-testid="inspector-status">{statusLabel(state)}</p>
      <div className="flex gap-2">
        <input
          aria-label="Instruction"
          className="w-96 rounded-md border border-foreground/20 bg-transparent px-3 py-2 text-sm"
          onChange={(event) => setMessageText(event.target.value)}
          value={messageText}
        />
        <Button onClick={() => void startNewSession()}>New session</Button>
      </div>
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-foreground/20 border-b">
            <th className="py-1 pr-4">#</th>
            <th className="py-1 pr-4">Session seq</th>
            <th className="py-1 pr-4">Event type</th>
            <th className="py-1 pr-4">Durability</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-foreground/10 border-b" key={row.slotKey}>
              <td className="py-1 pr-4" data-testid={`row-${row.displayNumber}`}>
                {row.displayNumber}
              </td>
              <td className="py-1 pr-4">{row.sessionSequence ?? "—"}</td>
              <td className="py-1 pr-4">{row.eventType}</td>
              <td className="py-1 pr-4">{row.durability}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function InspectorBootstrap() {
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (typeof publishableKey !== "string" || publishableKey.length === 0) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is not set");
  }
  // Wrapped as `main.tsx` wraps the app, so the sign-in screen gets the theme and Clerk appearance.
  return (
    <ThemeProvider>
      <ClerkProvider publishableKey={publishableKey} appearance={CLERK_APPEARANCE}>
        <AuthGate>
          {(identity) => <Inspector userId={identity.userId} workspaceId={identity.workspaceId} />}
        </AuthGate>
      </ClerkProvider>
    </ThemeProvider>
  );
}

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(<InspectorBootstrap />);
}

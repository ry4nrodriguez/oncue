/**
 * A session's committed events, read as the browser reads them: a client
 * socket's replay from the first event, over the page's own origin and
 * sign-in. For a lane that must check what the session object stored, where
 * the screen would read the same whether or not it was stored.
 */
import type { Page } from "@playwright/test";

export type StoredEvent = {
  readonly type: string;
  readonly sessionSequence: number;
  readonly runId: string | null;
  readonly payload: Record<string, unknown>;
};

/** The session a page is showing, from its `/sessions/<id>` address. */
export function sessionIdOf(page: Page): string {
  const match = /\/sessions\/([^/?#]+)/.exec(new URL(page.url()).pathname);
  if (match === null || match[1] === undefined) {
    throw new Error(`the page is not on a session: ${page.url()}`);
  }
  return match[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function committedEvents(page: Page, sessionId: string): Promise<StoredEvent[]> {
  const frames = await page.evaluate(
    (id) =>
      new Promise<string[]>((resolve, reject) => {
        const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(
          `${scheme}//${window.location.host}/ws/sessions/${id}/client?after=0`,
        );
        const received: string[] = [];
        let quiet: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
          socket.close();
          resolve(received);
        };
        // A live stream never goes quiet; the replay comes first, so a few
        // seconds hold all of it either way.
        setTimeout(finish, 4_000);
        socket.onmessage = (event) => {
          received.push(String(event.data));
          if (quiet !== null) clearTimeout(quiet);
          quiet = setTimeout(finish, 1_500);
        };
        socket.onerror = () => reject(new Error("the replay socket failed"));
      }),
    sessionId,
  );
  const events = new Map<number, StoredEvent>();
  for (const frame of frames) {
    const parsed: unknown = JSON.parse(frame);
    if (!isRecord(parsed)) {
      continue;
    }
    // A replay batch or a single event, whichever the socket sent.
    const batch = Array.isArray(parsed.events) ? parsed.events : [parsed];
    for (const item of batch) {
      if (
        isRecord(item) &&
        typeof item.type === "string" &&
        typeof item.sessionSequence === "number"
      ) {
        events.set(item.sessionSequence, {
          type: item.type,
          sessionSequence: item.sessionSequence,
          runId: typeof item.runId === "string" ? item.runId : null,
          payload: isRecord(item.payload) ? item.payload : {},
        });
      }
    }
  }
  return [...events.values()].sort((a, b) => a.sessionSequence - b.sessionSequence);
}

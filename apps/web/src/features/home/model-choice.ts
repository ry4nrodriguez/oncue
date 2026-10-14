/**
 * The model last chosen on Home, remembered per workspace in localStorage so
 * the composer opens on it. A convenience only; the Worker validates the submit.
 */
import { useCallback, useEffect, useState } from "react";

const PREFIX = "oncue.model.";

export interface ModelChoiceMemory {
  readonly connectionId: string;
  readonly modelId: string;
}

function key(workspaceId: string): string {
  return `${PREFIX}${workspaceId}`;
}

export function readModelChoice(workspaceId: string | null): ModelChoiceMemory | null {
  if (workspaceId === null) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key(workspaceId));
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).connectionId === "string" &&
      typeof (parsed as Record<string, unknown>).modelId === "string"
    ) {
      const record = parsed as Record<string, string>;
      return { connectionId: record.connectionId as string, modelId: record.modelId as string };
    }
    return null;
  } catch {
    // Blocked storage or a hand-edited value: no memory, never an error.
    return null;
  }
}

export function writeModelChoice(workspaceId: string, choice: ModelChoiceMemory): void {
  try {
    window.localStorage.setItem(key(workspaceId), JSON.stringify(choice));
  } catch {
    // Storage is a convenience here, never a source of truth.
  }
}

/**
 * The connection the composer sends: what was picked on this page, else the
 * remembered one, else the oldest key, since the Worker lists newest first and
 * connecting a second provider must not move a composer nobody touched. A
 * pick or a memory that is no longer in the list is passed over, so a key
 * revoked or refused since is never sent.
 */
export function liveModelConnectionId(
  listed: readonly { readonly modelConnectionId: string }[],
  picked: string | null,
  remembered: string | null,
): string | undefined {
  const ids = listed.map((connection) => connection.modelConnectionId);
  for (const candidate of [picked, remembered]) {
    if (candidate !== null && ids.includes(candidate)) {
      return candidate;
    }
  }
  return ids.at(-1);
}

export function useModelChoice(workspaceId: string | null): {
  readonly choice: ModelChoiceMemory | null;
  readonly choose: (connectionId: string, modelId: string) => void;
} {
  const [choice, setChoice] = useState<ModelChoiceMemory | null>(() =>
    readModelChoice(workspaceId),
  );
  useEffect(() => {
    setChoice(readModelChoice(workspaceId));
  }, [workspaceId]);
  const choose = useCallback(
    (connectionId: string, modelId: string) => {
      const next = { connectionId, modelId };
      setChoice(next);
      if (workspaceId !== null) {
        writeModelChoice(workspaceId, next);
      }
    },
    [workspaceId],
  );
  return { choice, choose };
}

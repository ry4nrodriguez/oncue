import { cn } from "@/lib/utils";
import { CONNECTION_LABELS } from "./status";
import type { ConnectionState } from "./transport";

const TONE: Record<ConnectionState, string> = {
  connecting: "text-muted-foreground",
  live: "text-positive",
  reconnecting: "text-caution",
  caught_up: "text-muted-foreground",
  offline: "text-danger",
};

const DOT: Record<ConnectionState, string> = {
  connecting: "bg-faint",
  live: "bg-positive",
  reconnecting: "bg-caution",
  caught_up: "bg-faint",
  offline: "bg-danger",
};

/** The five states stay distinct, and offline with unsent input differs from a plain disconnect (record 13). */
export function connectionLabel(state: ConnectionState, hasUnsentInput: boolean): string {
  return state === "offline" && hasUnsentInput
    ? "Offline · unsent message"
    : CONNECTION_LABELS[state];
}

/** `compact` draws the dot alone, with the words in the accessible name and tooltip. */
export function ConnectionBadge({
  state,
  hasUnsentInput = false,
  compact = false,
}: {
  state: ConnectionState;
  hasUnsentInput?: boolean;
  compact?: boolean;
}) {
  const label = connectionLabel(state, hasUnsentInput);
  const dot = (
    <span
      className={cn(
        "size-1.5 rounded-full",
        DOT[state],
        state === "connecting" || state === "reconnecting" ? "animate-pulse" : "",
      )}
    />
  );
  if (compact) {
    return (
      <span
        data-testid="connection-badge"
        data-state={state}
        role="img"
        aria-label={label}
        title={label}
        className={cn("flex items-center", TONE[state])}
      >
        {dot}
      </span>
    );
  }
  return (
    <span
      data-testid="connection-badge"
      data-state={state}
      className={cn("flex items-center gap-1.5 text-[12px]", TONE[state])}
    >
      {dot}
      {label}
    </span>
  );
}

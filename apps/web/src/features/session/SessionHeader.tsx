import { PanelRight, Pin } from "lucide-react";
import type { ReactNode } from "react";
import { TONE_DOT_CLASS } from "@/features/status-tone";
import { cn } from "@/lib/utils";
import { ConnectionBadge } from "./ConnectionBadge";
import { PHASE_WORD } from "./SessionPanel";
import type { SandboxPhase } from "./sandbox-time";
import type { ConnectionState } from "./transport";

const ICON_BUTTON =
  "flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-text";

// The header shows the connection only when degraded, since that changes
// what a send will do (record 13).
const DEGRADED: ReadonlySet<ConnectionState> = new Set(["connecting", "reconnecting", "offline"]);

/**
 * The dot on the side-panel button while the sandbox is coming up or up, in
 * the tones those states have everywhere else. None before a sandbox, or once
 * it has stopped or failed: the run's own state says what went wrong.
 */
const SANDBOX_DOT: Partial<Record<SandboxPhase, string>> = {
  starting: `${TONE_DOT_CLASS.caution} motion-safe:animate-pulse`,
  running: TONE_DOT_CLASS.positive,
};

/** What the side-panel button is called: what a press does, then the sandbox's state while it has a dot. */
export function panelToggleLabel(panelOpen: boolean, sandboxPhase: SandboxPhase): string {
  const action = panelOpen ? "Close side panel" : "Open side panel";
  return SANDBOX_DOT[sandboxPhase] === undefined
    ? action
    : `${action}. Sandbox ${PHASE_WORD[sandboxPhase].toLowerCase()}`;
}

export function SessionHeader({
  connection,
  hasUnsentInput,
  railPinned,
  onPinRail,
  panelOpen = false,
  onTogglePanel,
  menu = null,
  sandboxPhase = "none",
}: {
  connection: ConnectionState;
  hasUnsentInput?: boolean;
  railPinned: boolean;
  onPinRail: () => void;
  /** Whether the side panel is open; the toggle mirrors the sidebar's on the left edge. */
  panelOpen?: boolean;
  onTogglePanel?: () => void;
  /** The session's options (archive, delete), beside the panel toggle. */
  menu?: ReactNode;
  /** The sandbox's state, which the composer no longer shows; the toggle carries its dot. */
  sandboxPhase?: SandboxPhase;
}) {
  const dot = SANDBOX_DOT[sandboxPhase];
  const toggleLabel = panelToggleLabel(panelOpen, sandboxPhase);
  return (
    <header
      data-testid="session-header"
      className="flex h-12 shrink-0 items-center justify-between gap-4 pr-3 pl-14"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {DEGRADED.has(connection) ? (
          <ConnectionBadge state={connection} hasUnsentInput={hasUnsentInput ?? false} />
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {railPinned ? null : (
          <button
            type="button"
            aria-label="Pin session details"
            onClick={onPinRail}
            className={ICON_BUTTON}
          >
            <Pin className="size-[17px]" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          aria-label={toggleLabel}
          title={toggleLabel}
          aria-pressed={panelOpen}
          onClick={onTogglePanel}
          data-testid="panel-toggle"
          className={cn(ICON_BUTTON, "relative")}
        >
          <PanelRight className="size-[18px]" aria-hidden="true" />
          {dot === undefined ? null : (
            <span
              data-testid="panel-sandbox-dot"
              data-phase={sandboxPhase}
              className={cn("absolute top-1 right-1 size-2 rounded-full ring-2 ring-canvas", dot)}
              aria-hidden="true"
            />
          )}
        </button>
        {menu}
      </div>
    </header>
  );
}

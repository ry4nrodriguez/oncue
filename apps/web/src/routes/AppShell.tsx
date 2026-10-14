import { PanelLeft } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useCallback, useState } from "react";
import { Outlet } from "react-router";
import { MAX_WIDTH, MIN_WIDTH, Sidebar, type SidebarGroups } from "@/features/home/Sidebar";
import type { SessionListRow } from "@/lib/api/sessions";

const EMPTY_GROUPS: SidebarGroups = { pinned: [], active: [], archived: [] };
const NO_SESSIONS: readonly SessionListRow[] = [];

// The rows also go to the outlet so `SessionRoute` can read its repository without a second request.
export type AppShellOutletContext = readonly SessionListRow[];

export function AppShell({
  groups = EMPTY_GROUPS,
  sessions = NO_SESSIONS,
  onTogglePin,
}: {
  groups?: SidebarGroups;
  sessions?: readonly SessionListRow[];
  onTogglePin?: ((sessionId: string) => void) | undefined;
}) {
  const [pinned, setPinned] = useState(false);
  const [width, setWidth] = useState(264);

  const onResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;

      function onMove(move: globalThis.MouseEvent) {
        setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (move.clientX - startX))));
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width],
  );

  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-canvas text-text">
      {/* Sits under the panel, so the sidebar simply covers it when open. */}
      <button
        type="button"
        aria-label="Pin sidebar open"
        onClick={() => setPinned(true)}
        className="absolute top-3 left-3 z-30 flex size-9 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-text"
      >
        <PanelLeft className="size-[18px]" aria-hidden="true" />
      </button>

      <Sidebar
        pinned={pinned}
        width={width}
        groups={groups}
        onToggle={() => setPinned((current) => !current)}
        onResizeStart={onResizeStart}
        onTogglePin={onTogglePin}
      />

      <div
        style={{ paddingLeft: pinned ? width : 0 }}
        className="relative z-10 min-w-0 flex-1 overflow-hidden transition-[padding] duration-200 ease-out"
      >
        <Outlet context={sessions satisfies AppShellOutletContext} />
      </div>
    </div>
  );
}

import { ChevronDown, PanelLeft, Pin, SquarePen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router";
import { Wordmark } from "@/components/brand/Wordmark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserMenu } from "@/features/auth/UserMenu";
import { cn } from "@/lib/utils";
import { SessionMenu } from "./SessionMenu";
import { activityLabel, type SessionActivity } from "./session-activity";
import { SidebarMenuContext, useSidebarMenuHost } from "./sidebar-menu";
import { MATRIX_PATH, MATRIX_REST, matrixDelayMs, matrixOpacity } from "./status-matrix";
import { ThemeToggle } from "./ThemeToggle";

export type SessionSummary = {
  readonly sessionId: string;
  readonly title: string;
  /** What the row's status mark says (`session-activity.ts`). */
  readonly activity: SessionActivity;
  readonly pinned: boolean;
  /** Archived sessions sit in their own group, read-only until restored. */
  readonly archived: boolean;
  /** Whether the current run has not ended, so archiving asks before cancelling it. */
  readonly runOpen: boolean;
};

/** Three groups, newest activity first in each (`sidebar-groups.ts`). */
export type SidebarGroups = {
  readonly pinned: readonly SessionSummary[];
  readonly active: readonly SessionSummary[];
  readonly archived: readonly SessionSummary[];
};

export const MIN_WIDTH = 200;
export const MAX_WIDTH = 420;

/**
 * One status slot per row, all one size so the titles line up: working is a
 * grey dot matrix (`WorkingMatrix`), needs you a yellow dot, finished a blue
 * one, and anything else an empty slot. The words are the accessible name, so
 * colour never carries meaning alone; the empty slot is hidden from assistive
 * technology.
 */
const MARK_CLASS: Record<SessionActivity["kind"], string> = {
  working: "text-faint",
  needs_you: "rounded-full bg-attention",
  finished: "rounded-full bg-finished",
  idle: "",
};

/**
 * Pins the working matrix's phase to the page clock. Re-sorting moves DOM
 * nodes, which restarts their CSS animations; starting each at the timeline's
 * origin keeps every working mark in step. Runs after every render.
 */
export function syncToTimeline(element: Element | null): void {
  if (element === null || typeof element.getAnimations !== "function") {
    return;
  }
  for (const animation of element.getAnimations({ subtree: true })) {
    if (animation.startTime !== 0) {
      animation.startTime = 0;
    }
  }
}

/** The matrix's dots are 2.5 units across on a 3.75 unit pitch, in a 10 unit box. */
const DOT_RADIUS = 1.25;
const cell = (index: number) => DOT_RADIUS + index * 3.75;

function WorkingMatrix() {
  return (
    // Drawn a pixel past the slot on every side: nine dots need the room, and
    // the slot keeps the size of the solid dots.
    <svg
      viewBox="0 0 10 10"
      fill="currentColor"
      aria-hidden="true"
      className="-m-px block size-2.5"
    >
      <circle cx={cell(1)} cy={cell(1)} r={DOT_RADIUS} opacity={MATRIX_REST} />
      {MATRIX_PATH.map(([column, row], index) => (
        <circle
          key={`${column}-${row}`}
          className="status-matrix-dot"
          cx={cell(column)}
          cy={cell(row)}
          r={DOT_RADIUS}
          style={{ opacity: matrixOpacity(index, 0), animationDelay: `${matrixDelayMs(index)}ms` }}
        />
      ))}
    </svg>
  );
}

export function StatusDot({ activity }: { activity: SessionActivity }) {
  const label = activityLabel(activity);
  const ref = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    syncToTimeline(ref.current);
  });
  const shared = {
    ref,
    "data-testid": "session-status-dot",
    "data-activity": activity.kind,
    className: cn("size-2 shrink-0", MARK_CLASS[activity.kind]),
  };
  if (label === null) {
    return <span aria-hidden="true" {...shared} />;
  }
  return (
    <span role="img" aria-label={label} title={label} {...shared}>
      {activity.kind === "working" ? <WorkingMatrix /> : null}
    </span>
  );
}

/** How long the pointer rests on a row before a title that does not fit starts to scroll. */
export const TITLE_SCROLL_DELAY_MS = 250;
/** The scroll's speed, so a longer title takes longer rather than moving faster. */
export const TITLE_SCROLL_PX_PER_SECOND = 100;
/** A title cut off by a few pixels still glides rather than jumps. */
export const TITLE_SCROLL_MIN_SECONDS = 0.3;

/**
 * Scrolls a title that does not fit, like film credits: once the pointer has
 * rested on the row, the text slides left by what is cut off, and it resets
 * when the pointer leaves. `hidden` is how far to move, 0 at rest. The slide
 * is a transform, which the compositor moves without laying the line out
 * again. A reader who asked for less motion keeps the title still.
 */
export function titleScrollSeconds(hidden: number): number {
  return Math.max(TITLE_SCROLL_MIN_SECONDS, hidden / TITLE_SCROLL_PX_PER_SECOND);
}

function useTitleScroll() {
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hidden, setHidden] = useState(0);

  const cancel = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  // A row removed mid-hover must not set state afterwards.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const onMouseEnter = () => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      const title = titleRef.current;
      const still =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (title !== null && !still) {
        setHidden(Math.max(0, title.scrollWidth - title.clientWidth));
      }
    }, TITLE_SCROLL_DELAY_MS);
  };
  const onMouseLeave = () => {
    cancel();
    setHidden(0);
  };
  return { titleRef, hidden, onMouseEnter, onMouseLeave };
}

/**
 * One session. The link, its pin, and its options menu are siblings, since a
 * button inside an anchor is invalid for browsers and screen readers. The
 * controls show on hover, on focus, and while the menu is open.
 */
function SessionRow({
  session,
  onTogglePin,
}: {
  session: SessionSummary;
  onTogglePin?: ((sessionId: string) => void) | undefined;
}) {
  const { titleRef, hidden, onMouseEnter, onMouseLeave } = useTitleScroll();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hovering only scrolls a title the link already names in full.
    <div className="group/row relative" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <NavLink
        to={`/sessions/${session.sessionId}`}
        className={({ isActive }) =>
          cn(
            "flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pl-2 text-left transition-colors",
            // The open session is a shade stronger than a hovered one.
            isActive ? "bg-hover-strong" : "hover:bg-hover",
            onTogglePin === undefined ? "pr-8" : "pr-14",
          )
        }
      >
        <StatusDot activity={session.activity} />
        <span className="min-w-0 flex-1 overflow-hidden text-[13px] text-text">
          <span
            ref={titleRef}
            data-testid="session-title"
            // At rest the title cuts itself off with an ellipsis; scrolling,
            // it is its full width and the span around it does the cutting.
            className={cn("block", hidden > 0 ? "w-max whitespace-nowrap" : "truncate")}
            style={
              hidden > 0
                ? {
                    transform: `translateX(-${hidden}px)`,
                    transition: `transform ${titleScrollSeconds(hidden)}s ease-in-out`,
                    willChange: "transform",
                  }
                : undefined
            }
          >
            {session.title}
          </span>
        </span>
      </NavLink>
      <SessionMenu
        sessionId={session.sessionId}
        title={session.title}
        archived={session.archived}
        runOpen={session.runOpen}
        triggerClassName="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 data-[popup-open]:opacity-100"
      />
      {onTogglePin === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={session.pinned ? "Unpin chat" : "Pin chat"}
                aria-pressed={session.pinned}
                onClick={() => onTogglePin(session.sessionId)}
                className={cn(
                  "absolute top-1/2 right-8 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-faint transition-opacity hover:bg-hover-strong hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100",
                  // A pinned row shows its pin at rest; others offer one on hover.
                  session.pinned ? "opacity-100" : "opacity-0",
                )}
              />
            }
          >
            <Pin
              className={cn("size-[15px]", session.pinned && "fill-current text-muted-foreground")}
              aria-hidden="true"
            />
          </TooltipTrigger>
          <TooltipContent
            sideOffset={8}
            className="rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[12px] text-text shadow-xl"
          >
            {session.pinned ? "Unpin chat" : "Pin chat"}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function Group({
  label,
  sessions,
  className,
  onTogglePin,
  defaultOpen = true,
}: {
  label: string;
  sessions: readonly SessionSummary[];
  className?: string | undefined;
  onTogglePin?: ((sessionId: string) => void) | undefined;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md px-2 py-1 font-medium text-[11px] text-faint uppercase tracking-wide transition-colors hover:bg-hover hover:text-muted-foreground"
      >
        {label}
        <ChevronDown
          className={cn("size-3.5 transition-transform duration-200", open ? "" : "-rotate-90")}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="mt-0.5 space-y-0.5">
          {sessions.map((session) => (
            <SessionRow key={session.sessionId} session={session} onTogglePin={onTogglePin} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Record 13's session sidebar. Hovering the screen edge opens it, clicking the
 * toggle pins it, and the right edge resizes it.
 */
export function Sidebar({
  pinned,
  width,
  groups,
  onToggle,
  onResizeStart,
  onTogglePin,
}: {
  pinned: boolean;
  width: number;
  groups: SidebarGroups;
  onToggle: () => void;
  onResizeStart: (event: React.MouseEvent) => void;
  /** Pins or unpins a session from its row's menu; absent where nothing can remember a pin. */
  onTogglePin?: ((sessionId: string) => void) | undefined;
}) {
  // An open menu holds the sidebar revealed: the menu is portaled, so the
  // pointer inside it is not hovering the rail (`sidebar-menu.ts`).
  const { host: menuHost, menuOpen } = useSidebarMenuHost(pinned);
  return (
    <SidebarMenuContext.Provider value={menuHost}>
      <div className="group/rail absolute inset-y-0 left-0 z-40 w-3">
        <aside
          data-testid="sidebar"
          data-revealed={pinned || menuOpen ? "true" : undefined}
          style={{ width }}
          className={cn(
            "absolute inset-y-0 left-0 flex flex-col border-border border-r bg-panel transition-transform duration-200 ease-out",
            pinned
              ? "translate-x-0"
              : "-translate-x-full shadow-[0_0_40px_-8px_rgb(0_0_0/18%)] group-hover/rail:translate-x-0",
            !pinned && menuOpen ? "translate-x-0" : null,
          )}
        >
          <div className="flex h-12 shrink-0 items-center justify-between pr-2 pl-3">
            {/* The home screen's fire-field letterforms, small and still (`wordmark-bitmap.ts`). */}
            <Wordmark cell={2} className="text-text" />
            <button
              type="button"
              aria-label={pinned ? "Unpin sidebar" : "Pin sidebar open"}
              aria-pressed={pinned}
              onClick={onToggle}
              className="flex size-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-text"
            >
              <PanelLeft className="size-[18px]" aria-hidden="true" />
            </button>
          </div>

          <div className="px-2">
            <Link
              to="/"
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text transition-colors hover:bg-hover"
            >
              <SquarePen className="size-[15px] text-muted-foreground" aria-hidden="true" />
              New session
            </Link>
          </div>

          <div className="scroll-pill mt-3 flex-1 overflow-y-auto px-2 pb-2">
            <Group label="Pinned" sessions={groups.pinned} onTogglePin={onTogglePin} />
            <Group
              label="Active"
              sessions={groups.active}
              className={groups.pinned.length === 0 ? undefined : "mt-4"}
              onTogglePin={onTogglePin}
            />
            {/* Out of the way and closed until asked for (record 13). */}
            <Group
              label="Archived"
              sessions={groups.archived}
              className={
                groups.pinned.length === 0 && groups.active.length === 0 ? undefined : "mt-4"
              }
              defaultOpen={false}
            />
          </div>

          <div className="flex items-center gap-1 border-border border-t px-2 py-2">
            <UserMenu />
            <ThemeToggle />
          </div>

          <button
            type="button"
            aria-label="Resize sidebar"
            onMouseDown={onResizeStart}
            className="absolute inset-y-0 right-0 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-border"
          />
        </aside>
      </div>
    </SidebarMenuContext.Provider>
  );
}

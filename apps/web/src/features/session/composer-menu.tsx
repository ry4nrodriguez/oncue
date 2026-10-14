/**
 * The row shape the composer's menus share, so they keep one padding and type
 * scale. The description sits inline after the label so rows stay one line high.
 */
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";
import { Link, useInRouterContext } from "react-router";
import { cn } from "@/lib/utils";

export interface MenuRowProps {
  readonly label: string;
  /** Optional. A row whose name already says everything does not need one. */
  readonly description?: string | undefined;
  /** Optional right-aligned text, for a row that needs an action word. */
  readonly trailing?: string | undefined;
  readonly leading?: ReactNode;
  readonly className?: string | undefined;
  /** A row that cannot be chosen, drawn muted but still at readable contrast. */
  readonly muted?: boolean | undefined;
}

export function MenuRow({
  label,
  description,
  trailing,
  leading,
  className,
  muted = false,
}: MenuRowProps) {
  return (
    <span className={cn("flex w-full min-w-0 items-center gap-2", className)}>
      {leading}
      <span className={cn("shrink-0", muted ? "text-muted-foreground" : "text-text")}>{label}</span>
      {description === undefined ? null : (
        <span className="min-w-0 truncate text-muted-foreground">{description}</span>
      )}
      {trailing === undefined ? null : (
        <span className="ml-auto shrink-0 pl-2 text-muted-foreground">{trailing}</span>
      )}
    </span>
  );
}

/** Shared sizing so the composer's menus line up with each other and with the composer. */
export const MENU_ROW = "gap-2 px-2.5 py-1.5 text-[13px] data-[highlighted]:bg-hover";

/**
 * The same sizing for a row of the agent panel, which is a button, a link, or
 * text, not a menu item. Rows tighten on a short screen, so the panel's fixed
 * parts leave the model list a row to scroll in.
 */
export const PANEL_ROW =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none [@media(max-height:640px)]:py-1";

/** A panel row that can be chosen or followed: it answers the pointer and shows keyboard focus. */
export const PANEL_CHOICE_ROW = `${PANEL_ROW} transition-colors hover:bg-hover focus-visible:bg-hover`;

/** The attribute the arrow keys look for, so they step over headings and notes. */
const ROW_MARKER = "data-menu-row";

/** Marks a row as one the arrow keys stop on. */
export const MENU_ROW_PROPS = { [ROW_MARKER]: "" } as const;

/**
 * Moves focus to the next or previous row on the arrow keys, as a menu would.
 * Rows stay in the tab order, so Tab still reaches each one.
 */
export function moveRowFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`[${ROW_MARKER}]`));
  const at = rows.indexOf(document.activeElement as HTMLElement);
  if (at === -1) {
    return;
  }
  event.preventDefault();
  rows[at + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
}

/** One group of the agent panel: a quiet heading, an optional value beside it, and its rows. */
export function MenuSection({
  title,
  value,
  testId,
  scrolls = false,
  children,
}: {
  readonly title: string;
  readonly value?: string | undefined;
  readonly testId: string;
  /** The one section that gives up height when the panel is short; its rows then scroll. */
  readonly scrolls?: boolean;
  readonly children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would put a form's legend around rows that are buttons and links
    <div
      role="group"
      aria-label={value === undefined ? title : `${title}: ${value}`}
      data-testid={testId}
      className={cn("flex flex-col p-1", scrolls ? "min-h-[3.75rem]" : "shrink-0")}
    >
      <p className="flex shrink-0 gap-1.5 px-2.5 pt-1 pb-0.5 text-[12px] text-muted-foreground">
        {title}
        {value === undefined ? null : <span className="text-text">{value}</span>}
      </p>
      <div className={scrolls ? "scroll-pill min-h-0 overflow-y-auto overscroll-contain" : ""}>
        {children}
      </div>
    </div>
  );
}

export const FIXED_FOR_SESSION = "Fixed for this session";

/** What a section shows where nothing can be chosen: the one value, as text. */
export function StaticRow({
  label,
  leading,
  fixed,
}: {
  readonly label: string;
  readonly leading?: ReactNode;
  /** Says why there is no choice, where a session holds the value. */
  readonly fixed: boolean;
}) {
  return (
    <p className={PANEL_ROW}>
      <MenuRow label={label} leading={leading} trailing={fixed ? FIXED_FOR_SESSION : undefined} />
    </p>
  );
}

/** The quiet Connect on a row that needs a key first. */
export const CONNECT_PILL =
  "ml-auto shrink-0 rounded-md border border-border px-1.5 py-px text-[11px] text-muted-foreground";

/** A router link where there is a router, else a plain anchor (tests, dev harness). */
export function MenuLink({ href, ...props }: ComponentProps<"a"> & { readonly href: string }) {
  const routed = useInRouterContext();
  return routed ? <Link to={href} {...props} /> : <a href={href} {...props} />;
}

/**
 * How a menu at the foot of the sidebar opens and closes (record 13). A click
 * opens it. Opened with a mouse or pen, it closes once the pointer has been
 * outside both the trigger and the menu for `LEAVE_CLOSE_DELAY_MS`; opened
 * with the keyboard, it stays until Escape, Tab, or a choice; touch never
 * starts the timer. While a menu is open the sidebar stays revealed (the menu
 * is portaled, so the pointer in it is not hovering the sidebar), and
 * unpinning the sidebar closes every menu. Base UI's `closeDelay` would
 * require `openOnHover`, so the timer lives here.
 */

import {
  createContext,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

/** How long the pointer may be outside the trigger and the menu before the menu closes. */
export const LEAVE_CLOSE_DELAY_MS = 300;

/** What the sidebar tells the menus inside it, and hears back from them. */
export interface SidebarMenuHost {
  /** Whether the sidebar is pinned open; a change to unpinned closes every menu. */
  readonly pinned: boolean;
  /** A menu reports each open and close, so the sidebar stays revealed while one is open. */
  readonly setMenuOpen: (menuId: string, open: boolean) => void;
}

/** Outside a sidebar (a test, a future screen) a menu still closes on leave, and holds nothing open. */
const STANDALONE: SidebarMenuHost = { pinned: true, setMenuOpen: () => {} };

export const SidebarMenuContext = createContext<SidebarMenuHost>(STANDALONE);

/** The event Base UI hands `onOpenChange`, as far as this needs it. */
interface OpenChangeDetails {
  readonly event?: Event | undefined;
}

/**
 * Whether the open came from a mouse or pen press. Base UI opens its trigger
 * on `mousedown`; the keyboard's Enter and Space arrive as a `click` with
 * `detail` 0, and an arrow key as a `keydown`.
 */
export function openedByPointer(details: OpenChangeDetails | undefined): boolean {
  const event = details?.event;
  if (event === undefined) {
    return false;
  }
  if (event.type === "mousedown" || event.type === "pointerdown") {
    return true;
  }
  return event.type === "click" && "detail" in event && (event as MouseEvent).detail > 0;
}

type PointerHandlers = {
  readonly onPointerEnter: (event: ReactPointerEvent<Element>) => void;
  readonly onPointerLeave: (event: ReactPointerEvent<Element>) => void;
};

export interface SidebarMenu {
  /** Spread on `DropdownMenu`. */
  readonly rootProps: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean, details?: OpenChangeDetails) => void;
  };
  /** Spread on `DropdownMenuTrigger`. */
  readonly triggerProps: PointerHandlers;
  /** Spread on `DropdownMenuContent`. */
  readonly contentProps: PointerHandlers;
}

export function useSidebarMenu(delayMs: number = LEAVE_CLOSE_DELAY_MS): SidebarMenu {
  const host = useContext(SidebarMenuContext);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const byPointer = useRef(false);
  const inside = useRef({ trigger: false, content: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancel();
    byPointer.current = false;
    // A menu that closes under the pointer never hears it leave.
    inside.current.content = false;
    setOpen(false);
  }, [cancel]);

  const onOpenChange = useCallback(
    (next: boolean, details?: OpenChangeDetails) => {
      cancel();
      if (next) {
        byPointer.current = openedByPointer(details);
        setOpen(true);
        return;
      }
      close();
    },
    [cancel, close],
  );

  const handlers = (part: "trigger" | "content"): PointerHandlers => ({
    onPointerEnter: (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      inside.current[part] = true;
      cancel();
    },
    onPointerLeave: (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      inside.current[part] = false;
      if (!open || !byPointer.current || inside.current.trigger || inside.current.content) {
        return;
      }
      cancel();
      timer.current = setTimeout(close, delayMs);
    },
  });

  // The sidebar stays revealed while this menu is open.
  const { setMenuOpen, pinned } = host;
  useEffect(() => {
    setMenuOpen(menuId, open);
  }, [setMenuOpen, menuId, open]);
  useEffect(() => () => setMenuOpen(menuId, false), [setMenuOpen, menuId]);

  // Unpinning the sidebar closes the menu, whichever way it was opened.
  const wasPinned = useRef(pinned);
  useEffect(() => {
    if (wasPinned.current && !pinned) {
      close();
    }
    wasPinned.current = pinned;
  }, [pinned, close]);

  useEffect(() => cancel, [cancel]);

  return {
    rootProps: { open, onOpenChange },
    triggerProps: handlers("trigger"),
    contentProps: handlers("content"),
  };
}

/** The sidebar's side: which of its menus are open, and the host value to provide. */
export function useSidebarMenuHost(pinned: boolean): {
  readonly host: SidebarMenuHost;
  readonly menuOpen: boolean;
} {
  const [openMenus, setOpenMenus] = useState<ReadonlySet<string>>(() => new Set());
  const setMenuOpen = useCallback((menuId: string, next: boolean) => {
    setOpenMenus((current) => {
      if (current.has(menuId) === next) {
        return current;
      }
      const updated = new Set(current);
      if (next) {
        updated.add(menuId);
      } else {
        updated.delete(menuId);
      }
      return updated;
    });
  }, []);
  const host = useMemo(() => ({ pinned, setMenuOpen }), [pinned, setMenuOpen]);
  return { host, menuOpen: openMenus.size > 0 };
}

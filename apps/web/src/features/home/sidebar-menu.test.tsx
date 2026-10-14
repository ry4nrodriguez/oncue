import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  LEAVE_CLOSE_DELAY_MS,
  openedByPointer,
  SidebarMenuContext,
  useSidebarMenu,
  useSidebarMenuHost,
} from "./sidebar-menu";

afterEach(cleanup);

/** Short enough to wait out in real time, long enough to re-enter within. */
const DELAY = 60;

function Menu({ delayMs = DELAY, onChoose }: { delayMs?: number; onChoose?: () => void }) {
  const menu = useSidebarMenu(delayMs);
  return (
    <DropdownMenu {...menu.rootProps}>
      <DropdownMenuTrigger {...menu.triggerProps} data-testid="trigger">
        Open
      </DropdownMenuTrigger>
      <DropdownMenuContent {...menu.contentProps} data-testid="content">
        <DropdownMenuItem onClick={() => onChoose?.()}>Choice</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A sidebar's worth of host, reporting whether a menu holds it open. */
function Host({ pinned, children }: { pinned: boolean; children: ReactNode }) {
  const { host, menuOpen } = useSidebarMenuHost(pinned);
  return (
    <SidebarMenuContext.Provider value={host}>
      <div data-testid="host" data-menu-open={menuOpen ? "true" : "false"}>
        {children}
      </div>
    </SidebarMenuContext.Provider>
  );
}

const sleep = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

async function openWithPointer() {
  const trigger = screen.getByTestId("trigger");
  fireEvent.pointerOver(trigger, { pointerType: "mouse" });
  fireEvent.pointerDown(trigger, { pointerType: "mouse" });
  fireEvent.mouseDown(trigger, { detail: 1 });
  await screen.findByRole("menu");
}

/** React's `onPointerLeave` is made from `pointerout`, with where the pointer went. */
function leave(element: Element, to: Element = document.body, pointerType = "mouse") {
  fireEvent.pointerOut(element, { relatedTarget: to, pointerType });
}

function enter(element: Element, from: Element = document.body) {
  fireEvent.pointerOver(element, { relatedTarget: from, pointerType: "mouse" });
}

const isOpen = () => screen.queryByRole("menu") !== null;

describe("openedByPointer", () => {
  it.each([
    ["a mouse press", new MouseEvent("mousedown", { detail: 1 }), true],
    ["a pointer press", new Event("pointerdown"), true],
    ["a mouse click", new MouseEvent("click", { detail: 1 }), true],
    ["Enter or Space on the button (a click with detail 0)", new MouseEvent("click"), false],
    ["an arrow key", new KeyboardEvent("keydown", { key: "ArrowDown" }), false],
  ])("%s is %s", (_what, event, expected) => {
    expect(openedByPointer({ event })).toBe(expected);
  });

  it("is false with no event at all", () => {
    expect(openedByPointer(undefined)).toBe(false);
    expect(openedByPointer({})).toBe(false);
  });

  it("waits about 300 ms by default", () => {
    expect(LEAVE_CLOSE_DELAY_MS).toBe(300);
  });
});

describe("useSidebarMenu", () => {
  it("a click still opens the menu", async () => {
    render(<Menu />);
    await openWithPointer();
    expect(isOpen()).toBe(true);
  });

  it("closes once the pointer has left the trigger and the menu for the delay", async () => {
    render(<Menu />);
    await openWithPointer();
    leave(screen.getByTestId("trigger"));
    await sleep(DELAY / 3);
    expect(isOpen()).toBe(true);
    await waitFor(() => expect(isOpen()).toBe(false));
  });

  it("stays open when the pointer moves from the trigger into the menu, and closes when it then leaves the menu", async () => {
    render(<Menu />);
    await openWithPointer();
    const trigger = screen.getByTestId("trigger");
    const content = screen.getByTestId("content");
    // Diagonally: out of the trigger, over something else, into the menu.
    leave(trigger);
    await sleep(DELAY / 3);
    enter(content);
    await sleep(DELAY * 2);
    expect(isOpen()).toBe(true);

    leave(content);
    await waitFor(() => expect(isOpen()).toBe(false));
  });

  it("re-entering the trigger within the grace period cancels the close", async () => {
    render(<Menu />);
    await openWithPointer();
    const trigger = screen.getByTestId("trigger");
    leave(trigger);
    await sleep(DELAY / 3);
    enter(trigger);
    await sleep(DELAY * 2);
    expect(isOpen()).toBe(true);
  });

  it("choosing an item still works and closes the menu", async () => {
    let chosen = 0;
    render(
      <Menu
        onChoose={() => {
          chosen += 1;
        }}
      />,
    );
    await openWithPointer();
    enter(screen.getByTestId("content"), screen.getByTestId("trigger"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Choice" }));
    expect(chosen).toBe(1);
    await waitFor(() => expect(isOpen()).toBe(false));
  });

  it("a menu opened with the keyboard stays open when the pointer leaves", async () => {
    render(<Menu />);
    const trigger = screen.getByTestId("trigger");
    // Enter or Space on a button is a click with detail 0.
    fireEvent.click(trigger, { detail: 0 });
    await screen.findByRole("menu");
    enter(trigger);
    leave(trigger);
    await sleep(DELAY * 3);
    expect(isOpen()).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(isOpen()).toBe(false));
  });

  it("a touch that lifts is not a leave", async () => {
    render(<Menu />);
    await openWithPointer();
    leave(screen.getByTestId("trigger"), document.body, "touch");
    await sleep(DELAY * 3);
    expect(isOpen()).toBe(true);
  });

  it("a menu reopened after closing under the pointer still closes on leave", async () => {
    render(<Menu />);
    await openWithPointer();
    enter(screen.getByTestId("content"), screen.getByTestId("trigger"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(isOpen()).toBe(false));

    await openWithPointer();
    leave(screen.getByTestId("trigger"));
    await waitFor(() => expect(isOpen()).toBe(false));
  });
});

describe("the sidebar's side", () => {
  it("holds the sidebar revealed while a menu is open, and lets go when it closes", async () => {
    render(
      <Host pinned={false}>
        <Menu />
      </Host>,
    );
    expect(screen.getByTestId("host").dataset.menuOpen).toBe("false");
    await openWithPointer();
    expect(screen.getByTestId("host").dataset.menuOpen).toBe("true");
    leave(screen.getByTestId("trigger"));
    await waitFor(() => expect(screen.getByTestId("host").dataset.menuOpen).toBe("false"));
  });

  it("unpinning the sidebar closes an open menu, even one opened with the keyboard", async () => {
    const { rerender } = render(
      <Host pinned>
        <Menu />
      </Host>,
    );
    fireEvent.click(screen.getByTestId("trigger"), { detail: 0 });
    await screen.findByRole("menu");
    rerender(
      <Host pinned={false}>
        <Menu />
      </Host>,
    );
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(screen.getByTestId("host").dataset.menuOpen).toBe("false");
  });

  it("pinning the sidebar leaves an open menu alone", async () => {
    const { rerender } = render(
      <Host pinned={false}>
        <Menu />
      </Host>,
    );
    await openWithPointer();
    rerender(
      <Host pinned>
        <Menu />
      </Host>,
    );
    await sleep(DELAY / 3);
    expect(isOpen()).toBe(true);
  });

  it("a menu that unmounts while open lets go of the sidebar", async () => {
    const { rerender } = render(
      <Host pinned={false}>
        <Menu />
      </Host>,
    );
    await openWithPointer();
    rerender(<Host pinned={false}>{null}</Host>);
    await waitFor(() => expect(screen.getByTestId("host").dataset.menuOpen).toBe("false"));
  });
});

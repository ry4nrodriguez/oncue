import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Tooltip, TooltipProvider, TooltipTrigger } from "./tooltip";

afterEach(cleanup);

describe("ui primitives", () => {
  it("opens and closes a collapsible", () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>Worked for 48s</CollapsibleTrigger>
        <CollapsibleContent>Cloning repository</CollapsibleContent>
      </Collapsible>,
    );
    expect(screen.queryByText("Cloning repository")).toBeNull();
    fireEvent.click(screen.getByText("Worked for 48s"));
    expect(screen.getByText("Cloning repository")).toBeTruthy();
  });

  it("renders popup triggers without opening them", () => {
    render(
      <TooltipProvider>
        <DropdownMenu>
          <DropdownMenuTrigger>More</DropdownMenuTrigger>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger>Copy</TooltipTrigger>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(screen.getByText("More")).toBeTruthy();
    expect(screen.getByText("Copy")).toBeTruthy();
  });

  // The portal and positioner are folded into our Content wrappers; prove they mount.
  it("mounts popup content through the portal when opened", async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Repository</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>acme/oncue</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(screen.queryByText("acme/oncue")).toBeNull();
    fireEvent.click(screen.getByText("Repository"));
    expect(await screen.findByText("acme/oncue")).toBeTruthy();
  });

  it("opens dialog content through the portal and closes it", async () => {
    render(
      <Dialog>
        <DialogTrigger>Open settings</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Configure the session</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose>Close</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByText("Settings")).toBeNull();
    fireEvent.click(screen.getByText("Open settings"));
    expect(await screen.findByText("Settings")).toBeTruthy();
    expect(screen.getByText("Configure the session")).toBeTruthy();

    fireEvent.click(screen.getByText("Close"));
    await screen.findByText("Open settings");
    expect(screen.queryByText("Settings")).toBeNull();
  });

  it("opens a popover with its own placement, or the one its caller names", async () => {
    render(
      <Popover>
        <PopoverTrigger>Open details</PopoverTrigger>
        <PopoverContent>Plain placement</PopoverContent>
      </Popover>,
    );
    fireEvent.click(screen.getByText("Open details"));
    expect(await screen.findByText("Plain placement")).toBeTruthy();
    cleanup();

    render(
      <Popover>
        <PopoverTrigger>Open details</PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        >
          Named placement
        </PopoverContent>
      </Popover>,
    );
    fireEvent.click(screen.getByText("Open details"));
    expect(await screen.findByText("Named placement")).toBeTruthy();
  });
});

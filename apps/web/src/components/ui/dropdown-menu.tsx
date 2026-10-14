import { Menu as Base } from "@base-ui-components/react/menu";
import { type ComponentProps, isValidElement, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function DropdownMenu(props: ComponentProps<typeof Base.Root>) {
  return <Base.Root {...props} />;
}

export function DropdownMenuTrigger({
  asChild,
  children,
  ...props
}: ComponentProps<typeof Base.Trigger> & { asChild?: boolean | undefined }) {
  // Base UI composes through `render`; AI Elements source passes `asChild`.
  if (asChild && isValidElement(children)) {
    return <Base.Trigger {...props} render={children as ReactElement<Record<string, unknown>>} />;
  }
  return <Base.Trigger {...props}>{children as ReactNode}</Base.Trigger>;
}

export function DropdownMenuContent({
  className,
  children,
  align,
  side,
  sideOffset,
  anchor,
  ...props
}: ComponentProps<typeof Base.Popup> & {
  align?: "start" | "center" | "end" | undefined;
  /** Which edge of the trigger the menu opens from; defaults to `"bottom"`. */
  side?: "top" | "bottom" | "left" | "right" | undefined;
  sideOffset?: number | undefined;
  /** Position against something other than the trigger, such as the surface a small button sits in. */
  anchor?: ComponentProps<typeof Base.Positioner>["anchor"];
}) {
  return (
    <Base.Portal>
      {/*
        `z-50` belongs on the positioner: the popup is `position: static`, so a
        z-index there is ignored and the page behind wins the hit test.
      */}
      <Base.Positioner
        className="z-50"
        align={align ?? "center"}
        side={side ?? "bottom"}
        sideOffset={sideOffset ?? 6}
        {...(anchor === undefined ? {} : { anchor })}
      >
        <Base.Popup
          className={cn(
            "min-w-[8rem] overflow-hidden rounded-lg border border-foreground/15 bg-background p-1 shadow-lg",
            className,
          )}
          {...props}
        >
          {children}
        </Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Base.Item>) {
  return (
    <Base.Item
      className={cn(
        "cursor-default select-none rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-foreground/5",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuRadioGroup(props: ComponentProps<typeof Base.RadioGroup>) {
  return <Base.RadioGroup {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  ...props
}: ComponentProps<typeof Base.RadioItem>) {
  return (
    <Base.RadioItem
      closeOnClick
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-foreground/5",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuRadioItemIndicator(
  props: ComponentProps<typeof Base.RadioItemIndicator>,
) {
  return <Base.RadioItemIndicator {...props} />;
}

export function DropdownMenuCheckboxItem({
  className,
  ...props
}: ComponentProps<typeof Base.CheckboxItem>) {
  return (
    <Base.CheckboxItem
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-foreground/5",
        className,
      )}
      {...props}
    />
  );
}

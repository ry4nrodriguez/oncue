import { Tooltip as Base } from "@base-ui-components/react/tooltip";
import { type ComponentProps, isValidElement, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function TooltipProvider(props: ComponentProps<typeof Base.Provider>) {
  return <Base.Provider {...props} />;
}

export function Tooltip(props: ComponentProps<typeof Base.Root>) {
  return <Base.Root {...props} />;
}

export function TooltipTrigger({
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

// shadcn exposes one content element; Base UI splits positioning from the popup,
// so the portal and positioner are folded in here.
export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof Base.Popup> & { sideOffset?: number }) {
  return (
    <Base.Portal>
      {/* The z-index goes on the positioner; on the static popup it would do nothing. */}
      <Base.Positioner sideOffset={sideOffset} className="z-50">
        <Base.Popup
          className={cn(
            "rounded-md bg-foreground px-2 py-1 text-background text-xs shadow-md",
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

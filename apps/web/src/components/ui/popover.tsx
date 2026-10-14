/**
 * A popover for panel content that is not a list of choices, such as a
 * slider: menu keyboard navigation would fight its arrow keys, and a screen
 * reader would announce a menu.
 */
import { Popover as Base } from "@base-ui-components/react/popover";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Popover(props: ComponentProps<typeof Base.Root>) {
  return <Base.Root {...props} />;
}

export function PopoverTrigger(props: ComponentProps<typeof Base.Trigger>) {
  return <Base.Trigger {...props} />;
}

export function PopoverContent({
  className,
  children,
  align,
  side,
  sideOffset,
  collisionAvoidance,
  ...props
}: ComponentProps<typeof Base.Popup> & {
  align?: "start" | "center" | "end" | undefined;
  side?: "top" | "bottom" | "left" | "right" | undefined;
  sideOffset?: number | undefined;
  /** How the panel moves when it does not fit; absent, Base UI's own rule. */
  collisionAvoidance?: ComponentProps<typeof Base.Positioner>["collisionAvoidance"];
}) {
  return (
    <Base.Portal>
      {/* `z-50` belongs on the positioner, as in `dropdown-menu.tsx`. */}
      <Base.Positioner
        className="z-50"
        align={align ?? "center"}
        side={side ?? "bottom"}
        sideOffset={sideOffset ?? 6}
        {...(collisionAvoidance === undefined ? {} : { collisionAvoidance })}
      >
        <Base.Popup
          className={cn(
            "rounded-xl border border-border bg-popover shadow-xl outline-none",
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

import { Dialog as Base } from "@base-ui-components/react/dialog";
import { useRender } from "@base-ui-components/react/use-render";
import { type ComponentProps, isValidElement, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Dialog(props: ComponentProps<typeof Base.Root>) {
  return <Base.Root {...props} />;
}

export function DialogTrigger({
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

// Portal and backdrop are folded in so the shadcn call shape still works.
export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof Base.Popup>) {
  return (
    <Base.Portal>
      <Base.Backdrop className="fixed inset-0 z-50 bg-foreground/40 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
      <Base.Popup
        className={cn(
          "fixed top-1/2 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-foreground/15 bg-background p-6 shadow-lg outline-none transition-all data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
          className,
        )}
        {...props}
      >
        {children}
      </Base.Popup>
    </Base.Portal>
  );
}

export function DialogHeader({
  className,
  render = <div />,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    render,
    props: {
      ...props,
      className: cn("flex flex-col gap-1.5", className),
    },
  });
}

export function DialogFooter({
  className,
  render = <div />,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    render,
    props: {
      ...props,
      className: cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className),
    },
  });
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof Base.Title>) {
  return <Base.Title className={cn("font-semibold text-lg leading-none", className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof Base.Description>) {
  return <Base.Description className={cn("text-muted-foreground text-sm", className)} {...props} />;
}

export function DialogClose({
  asChild,
  children,
  ...props
}: ComponentProps<typeof Base.Close> & { asChild?: boolean | undefined }) {
  if (asChild && isValidElement(children)) {
    return <Base.Close {...props} render={children as ReactElement<Record<string, unknown>>} />;
  }
  return <Base.Close {...props}>{children as ReactNode}</Base.Close>;
}

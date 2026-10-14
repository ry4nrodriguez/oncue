import { Collapsible as Base } from "@base-ui-components/react/collapsible";
import { type ComponentProps, isValidElement, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// shadcn-shaped names over Base UI parts, so AI Elements source resolves here
// instead of Radix. `asChild` is translated to Base UI's `render` here, so
// the AI Elements files need no change of their own for it.
type AsChild = { asChild?: boolean | undefined };

export function Collapsible({
  asChild,
  children,
  ...props
}: ComponentProps<typeof Base.Root> & AsChild) {
  if (asChild && isValidElement(children)) {
    return <Base.Root {...props} render={children as ReactElement<Record<string, unknown>>} />;
  }
  return <Base.Root {...props}>{children as ReactNode}</Base.Root>;
}

export function CollapsibleTrigger({
  asChild,
  children,
  ...props
}: ComponentProps<typeof Base.Trigger> & AsChild) {
  if (asChild && isValidElement(children)) {
    return <Base.Trigger {...props} render={children as ReactElement<Record<string, unknown>>} />;
  }
  return <Base.Trigger {...props}>{children as ReactNode}</Base.Trigger>;
}

export function CollapsibleContent({
  asChild,
  className,
  children,
  ...props
}: ComponentProps<typeof Base.Panel> & AsChild) {
  if (asChild && isValidElement(children)) {
    return (
      <Base.Panel
        className={cn(className)}
        {...props}
        render={children as ReactElement<Record<string, unknown>>}
      />
    );
  }
  return (
    <Base.Panel className={cn("overflow-hidden", className)} {...props}>
      {children as ReactNode}
    </Base.Panel>
  );
}

/**
 * The page every screen before Home sits on (sign-in, blocked, setup): one
 * bordered panel headed by the animated wordmark, no fill or shadow (record
 * 13). It scrolls rather than centring a tall step and cutting off its top,
 * and keeps a 16px gutter so a 375px phone never scrolls sideways.
 */
import type { ReactNode } from "react";
import { FireWordmark } from "@/components/brand/FireWordmark";
import { GROUP } from "@/components/ui/button-classes";
import { cn } from "@/lib/utils";

export interface AuthFrameProps {
  readonly children: ReactNode;
  /** Quiet actions under the panel, such as Sign out. */
  readonly footer?: ReactNode;
  readonly testId?: string;
}

export function AuthFrame({ children, footer, testId }: AuthFrameProps) {
  return (
    <main
      className="flex min-h-full flex-col items-center justify-center bg-canvas px-4 py-12 text-text"
      data-testid={testId}
    >
      <div className={cn(GROUP, "w-full max-w-[420px] px-5 py-8 sm:px-8")} data-testid="auth-panel">
        <FireWordmark className="mb-6" />
        {children}
      </div>
      {footer !== undefined ? <div className="mt-5">{footer}</div> : null}
    </main>
  );
}

/** The class for a quiet text action under the panel: Sign out. */
export const FRAME_LINK =
  "rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:text-text";

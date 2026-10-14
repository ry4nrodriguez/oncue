/**
 * The loading screen shown while Clerk loads and while the gate waits on
 * `/api/me`; `LoadingLabel` is also the sign-in panel's fallback. `index.html`
 * paints the theme's canvas colour first, so dark mode never flashes white.
 */
import { FireWordmark } from "@/components/brand/FireWordmark";
import { cn } from "@/lib/utils";

/** "Loading", quiet and shimmering; also the sign-in panel's fallback. */
export function LoadingLabel({ className }: { readonly className?: string }) {
  return (
    <p className={cn("shimmer text-center text-[13px] text-muted-foreground", className)}>
      Loading
    </p>
  );
}

export function LoadingScreen() {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex min-h-full flex-col items-center justify-center bg-canvas px-4 text-text"
      data-testid="auth-loading"
    >
      <FireWordmark />
      <LoadingLabel className="mt-5" />
    </main>
  );
}

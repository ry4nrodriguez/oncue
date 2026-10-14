import { Link } from "react-router";

/**
 * Shown for a session the control plane refuses and for a route with no id.
 * "Not yours" and "does not exist" look identical (record 05) so ids cannot
 * be probed; only the empty id short-circuits without connecting.
 */
export function SessionNotFound() {
  return (
    <div
      data-testid="session-not-found"
      className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
    >
      <h1 className="font-semibold text-[18px] text-text tracking-tight">Session not found</h1>
      <p className="max-w-[420px] text-[14px] text-muted-foreground leading-6">
        This session does not exist, or it belongs to another workspace. Nothing was connected.
      </p>
      <Link
        to="/"
        className="mt-2 rounded-xl border border-border px-4 py-2 text-[13px] text-text transition-colors hover:bg-hover"
      >
        Back to home
      </Link>
    </div>
  );
}

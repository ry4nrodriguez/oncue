/**
 * Where the composer sits on an archived session: the timeline stays
 * readable, and Unarchive opens the session again. The next message after
 * that resumes it on a new sandbox (record 10).
 */

import { ArchiveRestore } from "lucide-react";
import { useState } from "react";
import { NEUTRAL_BUTTON } from "@/components/ui/button-classes";
import { useSessionListActions } from "@/features/home/session-list";
import { TONE_TEXT_CLASS } from "@/features/status-tone";
import { cn } from "@/lib/utils";

export function ArchivedNotice({ sessionId }: { sessionId: string }) {
  const { unarchive } = useSessionListActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    const message = await unarchive(sessionId);
    setBusy(false);
    setError(message);
  }

  return (
    <div
      data-testid="archived-notice"
      className="flex flex-col gap-2 rounded-2xl border border-border bg-panel px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="text-[13px] text-text">This session is archived.</p>
        <p className="text-[12px] text-muted-foreground">
          It's read-only. Unarchive it to send a message; the work resumes on a new sandbox.
        </p>
        {error === null ? null : (
          <p className={cn("mt-1 text-[12px]", TONE_TEXT_CLASS.danger)} role="alert">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void restore()}
        data-testid="unarchive-session"
        className={cn(NEUTRAL_BUTTON, "shrink-0 px-3 py-1.5 text-[12px]")}
      >
        <ArchiveRestore className="size-[14px]" aria-hidden="true" />
        {busy ? "Unarchiving…" : "Unarchive"}
      </button>
    </div>
  );
}

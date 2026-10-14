/**
 * Settings, Agent permissions (record 09): how every new session answers the
 * coding agent's own permission asks. One list of the choices a workspace can
 * default to, each saying what it does, with a check on the one in force. The
 * control plane decides every ask from this; the page only reads and sets it.
 */

import { Check } from "lucide-react";
import { useState } from "react";
import { GROUP } from "@/components/ui/button-classes";
import { useApprovalSettings } from "@/features/approvals/use-approval-settings";
import {
  type ApprovalSettingsResult,
  readApprovalSettings,
  setApprovalDefault,
} from "@/lib/api/approval-settings";
import { cn } from "@/lib/utils";

export interface AgentPermissionsSectionProps {
  /** Tests pass their own; the page uses the Worker's routes. */
  readonly api?: {
    readonly read: () => Promise<ApprovalSettingsResult>;
    readonly setDefault: typeof setApprovalDefault;
  };
}

const REAL_API = { read: readApprovalSettings, setDefault: setApprovalDefault };

/**
 * The defaults a workspace can hold. "Allow for this session" belongs to one
 * session, so it is chosen in the picker below the composer, never here.
 */
const DEFAULTS = [
  {
    mode: "ask",
    name: "Allow once",
    description:
      "Ask me each time the agent needs something outside the usual. A card lets you allow it once, for the session, or always.",
  },
  {
    mode: "always",
    name: "Always allow",
    description: "Don't ask in any session. The agent goes ahead without a card.",
  },
] as const;

export function AgentPermissionsSection({ api = REAL_API }: AgentPermissionsSectionProps) {
  const { settings, status, apply } = useApprovalSettings(api.read);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const choose = (mode: "ask" | "always") => {
    if (busy || settings?.defaultMode === mode) {
      return;
    }
    setBusy(true);
    setFailed(false);
    void api.setDefault(mode).then((result) => {
      setBusy(false);
      setFailed(result.kind !== "read");
      apply(result);
    });
  };

  return (
    <div className="h-full overflow-y-auto px-4 pt-12 pb-10 sm:px-8">
      <div className="mx-auto max-w-[760px]">
        <h1 className="font-semibold text-[20px] text-text tracking-tight">Agent permissions</h1>
        <p className="mt-1 text-[14px] text-muted-foreground leading-6">
          What a new session does when the coding agent wants to read files outside the project,
          repeats the same action, or starts a subagent. You can change it for one session from the
          picker below the composer.
        </p>

        {settings === null ? (
          <p
            data-testid="approval-default-loading"
            className="mt-6 text-[13px] text-muted-foreground"
          >
            {status === "failed" ? "Could not read this setting." : "Loading…"}
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-label="Default for every session"
            data-testid="approval-default"
            className={cn(GROUP, "mt-6 divide-y divide-border")}
          >
            {DEFAULTS.map((choice) => {
              const chosen = settings.defaultMode === choice.mode;
              return (
                <label
                  key={choice.mode}
                  data-testid={`approval-default-${choice.mode}`}
                  data-checked={chosen ? "true" : "false"}
                  className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-hover has-[:disabled]:cursor-default has-[:disabled]:opacity-60 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-text/60 has-[:focus-visible]:-outline-offset-2"
                >
                  {/* Named by the choice's name; its line says what it does. */}
                  <input
                    type="radio"
                    name="approval-default"
                    value={choice.mode}
                    checked={chosen}
                    disabled={busy}
                    onChange={() => choose(choice.mode)}
                    aria-labelledby={`approval-default-${choice.mode}-name`}
                    aria-describedby={`approval-default-${choice.mode}-what`}
                    className="sr-only"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      id={`approval-default-${choice.mode}-name`}
                      className="block text-[13px] text-text"
                    >
                      {choice.name}
                    </span>
                    <span
                      id={`approval-default-${choice.mode}-what`}
                      className="block text-[12px] text-faint"
                    >
                      {choice.description}
                    </span>
                  </span>
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {chosen ? <Check className="size-4 text-text" aria-hidden="true" /> : null}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {failed ? (
          <p role="status" className="mt-3 text-[13px] text-danger">
            OnCue couldn't save that. Try again.
          </p>
        ) : null}

        <p className="mt-6 text-[12.5px] text-faint leading-5">
          Starting a subagent follows this choice too; a subagent's model use is billed to the
          session's model connection. Secret files such as .env always ask, whatever is chosen here.
          Actions OnCue never allows, such as force pushes or merges, stay unavailable. Codex and Pi
          don't ask OnCue for permission yet, so this changes nothing for them.
        </p>
      </div>
    </div>
  );
}

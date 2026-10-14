/**
 * Home's picker shows the mode the next session starts with (record 09).
 * "Always allow" is the workspace's and is saved at once; "Allow for this
 * session" belongs to a session that does not exist yet, so it is held here
 * and sent with the create request. Any other choice saves the workspace's
 * default as ask. Saves go one at a time and the latest wins.
 */

import type { ApprovalMode } from "@oncue/protocol";
import { useCallback, useState } from "react";
import type { ApprovalSettingsResult } from "@/lib/api/approval-settings";
import { effectiveMode } from "./approval-modes";
import { type DefaultMode, useApprovalSettings } from "./use-approval-settings";

export interface HomeApprovalMode {
  /** Null when the workspace's default cannot be read. */
  readonly mode: ApprovalMode | null;
  readonly change: (mode: ApprovalMode) => void;
  /** What the create request carries: only "session" is the browser's to send. */
  readonly createMode: "session" | undefined;
}

export function useHomeApprovalMode(
  read?: () => Promise<ApprovalSettingsResult>,
  save?: (mode: DefaultMode) => Promise<ApprovalSettingsResult>,
): HomeApprovalMode {
  const settings = useApprovalSettings(read, save);
  const saveDefault = settings.save;
  const [choice, setChoice] = useState<"ask" | "session">("ask");
  const mode = effectiveMode(choice, settings.defaultMode);

  const change = useCallback(
    (next: ApprovalMode) => {
      if (next !== "always") {
        setChoice(next);
      }
      saveDefault(next === "always" ? "always" : "ask");
    },
    [saveDefault],
  );

  return { mode, change, createMode: mode === "session" ? "session" : undefined };
}

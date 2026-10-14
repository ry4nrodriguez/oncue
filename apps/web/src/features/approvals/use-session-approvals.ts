/**
 * A session screen's agent permissions (record 09): the mode its picker
 * shows, the permission card waiting above the composer, and what answers
 * them. The object decides every ask; this only sends. A choice in the picker
 * sends `approval.mode` for the session's half and saves the workspace's half
 * through `/api/approval-settings`, whose answer is what is in force, so the
 * picker never shows a mode that is not. A card's "Allow for this session" or
 * "Always allow" also sets that mode once the answer is accepted, so the
 * picker always names what the person chose; going back to "Allow once"
 * clears what the cards saved.
 */

import type { ApprovalMode, RunView, SessionView } from "@oncue/protocol";
import { useCallback, useMemo } from "react";
import type { CommandOutcome } from "@/features/session/use-commands";
import type { OutgoingCommand } from "@/features/session/use-session";
import type { ApprovalSettingsResult } from "@/lib/api/approval-settings";
import { effectiveMode, openPermissionApproval } from "./approval-modes";
import type { PermissionAnswer } from "./PermissionCard";
import { type DefaultMode, useApprovalSettings } from "./use-approval-settings";

export interface SessionApprovals {
  /** Null when the workspace's default cannot be read. */
  readonly mode: ApprovalMode | null;
  readonly open: ReturnType<typeof openPermissionApproval>;
  readonly changeMode: (mode: ApprovalMode) => void;
  /** Resolves on the object's answer, or says why none came. */
  readonly answer: (answer: PermissionAnswer) => Promise<CommandOutcome>;
}

/** The screen's one way to send a control: one command id per action until it is answered. */
export type IssueAction = (
  action: string,
  build: (commandId: string) => OutgoingCommand | null,
) => Promise<CommandOutcome | null>;

export function useSessionApprovals(
  view: SessionView,
  run: RunView | null,
  issueAction: IssueAction,
  /** How the workspace's settings are read and saved; tests pass their own. */
  read?: () => Promise<ApprovalSettingsResult>,
  save?: (mode: DefaultMode) => Promise<ApprovalSettingsResult>,
): SessionApprovals {
  const settings = useApprovalSettings(read, save);
  const saveDefault = settings.save;
  const mode = effectiveMode(view.approvalMode, settings.defaultMode);
  const open = useMemo(() => openPermissionApproval(view), [view]);

  const changeMode = useCallback(
    (next: ApprovalMode) => {
      void issueAction(
        `approval-mode:${next}`,
        (commandId) =>
          ({
            type: "approval.mode",
            commandId,
            runId: null,
            expected: { scope: "session", state: "active" },
            payload: { mode: next },
          }) as unknown as OutgoingCommand<"approval.mode">,
      );
      saveDefault(next === "always" ? "always" : "ask");
    },
    [issueAction, saveDefault],
  );

  const answer = useCallback(
    async (reply: PermissionAnswer): Promise<CommandOutcome> => {
      if (run === null) {
        return { kind: "not_sent" };
      }
      // A wider allow from the card becomes the mode, so the picker shows it.
      const widened =
        reply.decision === "approved" && (reply.scope === "session" || reply.scope === "always")
          ? reply.scope
          : null;
      const scope = reply.scope;
      const outcome = await issueAction(
        `permission:${reply.approvalId}:${reply.decision}:${scope ?? ""}`,
        (commandId) =>
          ({
            type: "approval.resolve",
            commandId,
            runId: run.runId,
            expected: { scope: "run", state: "waiting_for_approval" },
            payload: {
              approvalId: reply.approvalId,
              decision: reply.decision,
              ...(scope === undefined ? {} : { scope }),
            },
          }) as unknown as OutgoingCommand<"approval.resolve">,
      );
      if (widened !== null && outcome?.kind === "acknowledged") {
        changeMode(widened);
      }
      return outcome ?? { kind: "not_sent" };
    },
    [run, issueAction, changeMode],
  );

  return { mode, open, changeMode, answer };
}

/**
 * The words and rules the browser shows for agent permissions (record 09,
 * "Agent permissions"). The control plane decides every ask; these only say
 * what it decided and what a choice will do.
 */

import type {
  ApprovalMode,
  ApprovalScope,
  ApprovalView,
  PermissionCategory,
  SessionView,
} from "@oncue/protocol";
import { PERMISSION_CATEGORIES } from "@oncue/protocol";

export interface ModeChoice {
  readonly mode: ApprovalMode;
  readonly name: string;
  readonly description: string;
  /** The short name the picker below the composer shows while this mode is in force. */
  readonly chip: string;
}

/** The menu's three rows, in its order. `ask` is the default. */
export const MODE_CHOICES: readonly ModeChoice[] = [
  {
    mode: "ask",
    name: "Allow once",
    description: "Ask me each time the agent needs something outside the usual.",
    chip: "Allow once",
  },
  {
    mode: "session",
    name: "Allow for this session",
    description: "Don't ask again in this session.",
    chip: "This session",
  },
  {
    mode: "always",
    name: "Always allow",
    description: "Don't ask in any session. You can change this in Settings.",
    chip: "Always allow",
  },
];

export function modeChoice(mode: ApprovalMode): ModeChoice {
  return MODE_CHOICES.find((choice) => choice.mode === mode) as ModeChoice;
}

/**
 * What a session's asks are answered by now. The workspace's `always` wins,
 * since it is the user's choice for every session; otherwise this session's
 * own latest choice, and asking when there is none. Null when the workspace's
 * default is not known, since either answer could then be wrong.
 */
export function effectiveMode(
  sessionChoice: ApprovalMode | null,
  workspaceDefault: "ask" | "always" | null,
): ApprovalMode | null {
  if (workspaceDefault === null) {
    return null;
  }
  if (workspaceDefault === "always") {
    return "always";
  }
  return sessionChoice === "session" ? "session" : "ask";
}

/** The harnesses whose own gate asks (record 09); Codex runs with approvals off and Pi has none. */
const HARNESSES_THAT_ASK: readonly string[] = ["opencode", "claude"];

/** Whether the picker means anything for a harness; no choice is OpenCode, the default. */
export function harnessAsksPermission(runtimeId: string | null): boolean {
  return runtimeId === null || HARNESSES_THAT_ASK.includes(runtimeId);
}

export function isPermissionCategory(value: string): value is PermissionCategory {
  return (PERMISSION_CATEGORIES as readonly string[]).includes(value);
}

/** A card's second line, and Settings' row names. */
export const CATEGORY_LABEL: Readonly<Record<PermissionCategory, string>> = {
  outside_project: "Files outside the project",
  secret_file: "Secret files",
  repeated_action: "Repeated action",
  start_subagent: "Starting a subagent",
  other_request: "Other request",
};

/** The answers a card offers. Secret files are never saved, so only once or no. */
export function cardScopes(category: PermissionCategory): readonly ApprovalScope[] {
  return category === "secret_file" ? ["once"] : ["once", "session", "always"];
}

export const SCOPE_BUTTON: Readonly<Record<ApprovalScope, string>> = {
  once: "Allow once",
  session: "Allow for this session",
  always: "Always allow",
};

/** The muted line under each of the card's answers: what it does. */
export const SCOPE_DESCRIPTION: Readonly<Record<ApprovalScope, string>> = {
  once: "Just this request.",
  session: "Don't ask again in this session.",
  always: "Don't ask again in any session.",
};

/** The card's last answer, under the allows. */
export const DENY_DESCRIPTION = "The agent carries on without it.";

const RESOLVED_PREFIX: Readonly<Record<ApprovalScope, string>> = {
  once: "Allowed once",
  session: "Allowed for this session",
  always: "Always allowed",
};

function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}`;
}

/** The timeline's one folded line for a settled permission approval. */
export function settledLine(approval: ApprovalView): string {
  const what = lowerFirst(approval.title);
  if (approval.state === "approved") {
    return `${RESOLVED_PREFIX[approval.resolution?.scope ?? "once"]}: ${what}`;
  }
  if (approval.state === "rejected") {
    return `Denied: ${what}`;
  }
  return approval.expiredEffect === "tool_denied"
    ? `Denied, no answer in time: ${what}`
    : `Ended with the sandbox: ${what}`;
}

/** The open permission card, if one is waiting; secrets keep their own card in the timeline. */
export function openPermissionApproval(view: SessionView): ApprovalView | null {
  for (const id of view.openApprovalIds) {
    const approval = view.approvals.get(id);
    if (
      approval !== undefined &&
      approval.state === "requested" &&
      isPermissionCategory(approval.category)
    ) {
      return approval;
    }
  }
  return null;
}

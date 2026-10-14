/**
 * Lookup tables behind `ActionRow`. Each is a `Record` over a protocol union,
 * so a new category or provider is a compile error here rather than a row
 * that renders without a mark or with the wrong word.
 */

import type { PayloadOf, SandboxActionStep, ToolView } from "@oncue/protocol";
import {
  Braces,
  CircleDot,
  FilePen,
  FileText,
  GitBranch,
  Globe,
  MonitorPlay,
  Package,
  Search,
  ShieldQuestionMark,
  SquareTerminal,
  TestTube,
} from "lucide-react";
import type { ComponentType } from "react";
import { GitHubMark, ModalMark } from "@/components/brand/icons";
import type { StatusTone } from "@/features/status-tone";

export type ToolCategory = PayloadOf<"tool.requested">["category"];
export type ToolFailureCategory = PayloadOf<"tool.failed">["category"];
export type SandboxProvider = PayloadOf<"sandbox.provisioning">["provider"];

export type ActionMark = ComponentType<{ className?: string }>;

// `git_remote` gets GitHub's mark so the row shows where the side effect landed (record 13).
export const CATEGORY_MARK: Record<ToolCategory, ActionMark> = {
  file_read: FileText,
  file_write: FilePen,
  search: Search,
  shell: SquareTerminal,
  git_local: GitBranch,
  git_remote: GitHubMark,
  browser: MonitorPlay,
  web: Globe,
  verification: TestTube,
  artifact: Package,
  policy_propose: ShieldQuestionMark,
  other: Braces,
};

// `fake` is the local in-process driver; it has no brand, so it gets a glyph.
export const PROVIDER_MARK: Record<SandboxProvider, ActionMark> = {
  modal: ModalMark,
  fake: CircleDot,
};

/**
 * Short failure forms for the closed row, one per category so a policy denial
 * never reads like a timeout. The expanded panel shows the event's `errorText`.
 */
export const FAILURE_SUMMARY: Record<ToolFailureCategory, string> = {
  denied_by_policy: "Denied by policy",
  approval_rejected: "You declined this",
  approval_expired: "Approval expired",
  not_found: "Not found",
  timeout: "Timed out",
  runtime_error: "Failed",
  network: "Network error",
  unknown: "Failed for an unknown reason",
};

// A declined or expired approval never reaches `tool.failed`, so its failure
// is read from the approval rather than from `failure`.
const APPROVAL_DENIAL: Record<"rejected" | "expired", ToolFailureCategory> = {
  rejected: "approval_rejected",
  expired: "approval_expired",
};

export function toolFailureCategory(
  tool: Pick<ToolView, "failure" | "approval">,
): ToolFailureCategory | null {
  if (tool.failure !== null) {
    return tool.failure.category;
  }
  const approval = tool.approval?.state;
  if (approval === "rejected" || approval === "expired") {
    return APPROVAL_DENIAL[approval];
  }
  return null;
}

/**
 * Failure text for a sandbox row, whose label names the event rather than the
 * outcome. `null` on steps that did not end badly; a total `Record` so a new
 * step is a compile error.
 */
export const SANDBOX_FAILURE_SUMMARY: Record<SandboxActionStep, string | null> = {
  requested: null,
  provisioning: null,
  attached: null,
  connected: null,
  ready: null,
  idle: null,
  checkpointed: null,
  reconnecting: null,
  disconnected: null,
  lost: "Lost the agent runtime",
  replaced: null,
  stopped: null,
  failed: "The sandbox failed",
};

// A denial is the policy working, so it reads as caution rather than failure.
export const FAILURE_TONE: Record<ToolFailureCategory, StatusTone> = {
  denied_by_policy: "caution",
  approval_rejected: "caution",
  approval_expired: "caution",
  not_found: "danger",
  timeout: "danger",
  runtime_error: "danger",
  network: "danger",
  unknown: "danger",
};

// Below a second it stays in milliseconds, since "0s" reads as a missing number.
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 100) / 10}s`;
  }
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** What a settled call printed, read from its durable result. */
export type ResultOutput = {
  readonly text: string;
  /** Characters the bridge cut from the end to fit the inline limit; 0 when nothing was cut. */
  readonly droppedChars: number;
};

/**
 * The output in a call's durable `tool.completed` result, or `null`. The
 * bridge sends a real call's output here, redacted and cut to the inline
 * limit. The result is sandbox JSON, so its shape is checked, not cast.
 */
export function resultOutput(result: ToolView["result"]): ResultOutput | null {
  if (result === null || result.kind !== "inline") {
    return null;
  }
  const value: unknown = result.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { output, droppedChars } = value as {
    readonly output?: unknown;
    readonly droppedChars?: unknown;
  };
  if (typeof output !== "string") {
    return null;
  }
  const dropped =
    typeof droppedChars === "number" && Number.isFinite(droppedChars) && droppedChars > 0
      ? Math.floor(droppedChars)
      : 0;
  return { text: output, droppedChars: dropped };
}

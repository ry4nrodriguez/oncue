/**
 * The browser's copy of the `/api/approval-settings` contract (record 09,
 * "Agent permissions"): the workspace's default approval mode and its saved
 * "Always allow" rules. A defensive parser and thin `fetch` wrappers that
 * never throw. A session's own mode is not here; it travels as the session's
 * `approval.mode` command.
 */

import type { PermissionCategory } from "@oncue/protocol";
import { PERMISSION_CATEGORIES } from "@oncue/protocol";

export interface ApprovalSettings {
  readonly defaultMode: "ask" | "always";
  readonly rules: readonly { readonly category: PermissionCategory; readonly createdAt: string }[];
}

export type ApprovalSettingsResult =
  | { readonly kind: "read"; readonly settings: ApprovalSettings }
  | { readonly kind: "denied" }
  | { readonly kind: "unreachable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCategory(value: unknown): value is PermissionCategory {
  return typeof value === "string" && (PERMISSION_CATEGORIES as readonly string[]).includes(value);
}

/** Pure. Never throws. A body it cannot read is unreachable, never "nothing saved". */
export function parseApprovalSettingsResponse(
  status: number,
  body: unknown,
): ApprovalSettingsResult {
  if (status === 401 || status === 403) {
    return { kind: "denied" };
  }
  if (status !== 200 || !isRecord(body) || !Array.isArray(body.rules)) {
    return { kind: "unreachable" };
  }
  if (body.defaultMode !== "ask" && body.defaultMode !== "always") {
    return { kind: "unreachable" };
  }
  const rules = body.rules.flatMap((rule: unknown) =>
    isRecord(rule) && isCategory(rule.category) && typeof rule.createdAt === "string"
      ? [{ category: rule.category, createdAt: rule.createdAt }]
      : [],
  );
  return { kind: "read", settings: { defaultMode: body.defaultMode, rules } };
}

async function settingsFrom(request: Promise<Response>): Promise<ApprovalSettingsResult> {
  try {
    const response = await request;
    const body = await response.json().catch(() => null);
    return parseApprovalSettingsResponse(response.status, body);
  } catch {
    return { kind: "unreachable" };
  }
}

export function readApprovalSettings(): Promise<ApprovalSettingsResult> {
  return settingsFrom(fetch("/api/approval-settings"));
}

export function setApprovalDefault(mode: "ask" | "always"): Promise<ApprovalSettingsResult> {
  return settingsFrom(
    fetch("/api/approval-settings/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  );
}

export function removeApprovalRule(category: PermissionCategory): Promise<ApprovalSettingsResult> {
  return settingsFrom(
    fetch(`/api/approval-settings/rules/${encodeURIComponent(category)}`, { method: "DELETE" }),
  );
}

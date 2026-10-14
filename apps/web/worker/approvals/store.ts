// The workspace's agent permission settings in D1 (record 09, "Agent
// permissions", migrations 0017 and 0021). Every statement names the workspace from a
// verified actor or the session's own row, so another workspace's rows read
// as absent. A session's own mode and rules live in its object, not here.

import type { PermissionCategory } from "@oncue/protocol";

/** What a workspace may default to. "Allow for this session" is a session's own choice. */
export type WorkspaceDefaultMode = "ask" | "always";

/** The categories a workspace may always allow. Secret files ask in every mode. */
export const SAVABLE_CATEGORIES: readonly PermissionCategory[] = [
  "outside_project",
  "repeated_action",
  "start_subagent",
  "other_request",
];

export function isSavableCategory(value: unknown): value is PermissionCategory {
  return typeof value === "string" && (SAVABLE_CATEGORIES as readonly string[]).includes(value);
}

export interface WorkspaceRule {
  readonly category: PermissionCategory;
  readonly createdAt: string;
}

export interface WorkspaceApprovals {
  readonly defaultMode: WorkspaceDefaultMode;
  readonly rules: readonly WorkspaceRule[];
}

export const NO_WORKSPACE_APPROVALS: WorkspaceApprovals = { defaultMode: "ask", rules: [] };

/**
 * The default and the saved rules in one round trip: at most one setting row
 * and one row per savable category, each read by its primary key. A row the
 * CHECK should have refused reads as nothing allowed.
 */
export async function readWorkspaceApprovals(
  db: D1Database,
  workspaceId: string,
): Promise<WorkspaceApprovals> {
  const [setting, rules] = await db.batch([
    db
      .prepare("SELECT default_mode FROM workspace_approval_setting WHERE workspace_id = ?")
      .bind(workspaceId),
    db
      .prepare(
        "SELECT category, created_at FROM workspace_approval_rule WHERE workspace_id = ? ORDER BY created_at LIMIT 8",
      )
      .bind(workspaceId),
  ]);
  const mode = (setting?.results?.[0] as { default_mode?: unknown } | undefined)?.default_mode;
  return {
    defaultMode: mode === "always" ? "always" : "ask",
    rules: ((rules?.results ?? []) as { category: unknown; created_at: unknown }[]).flatMap(
      (row) =>
        isSavableCategory(row.category) && typeof row.created_at === "string"
          ? [{ category: row.category, createdAt: row.created_at }]
          : [],
    ),
  };
}

/**
 * Sets the default unless a later choice is already stored: two choices whose
 * writes land out of order leave the later one in force.
 */
export async function writeWorkspaceDefault(
  db: D1Database,
  workspaceId: string,
  mode: WorkspaceDefaultMode,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO workspace_approval_setting (workspace_id, default_mode, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET default_mode = excluded.default_mode, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= workspace_approval_setting.updated_at`,
    )
    .bind(workspaceId, mode, now)
    .run();
}

/** Saving a rule twice keeps the first time it was saved. */
export async function saveWorkspaceRule(
  db: D1Database,
  workspaceId: string,
  category: PermissionCategory,
  now: string,
): Promise<"saved" | "not_savable"> {
  if (!isSavableCategory(category)) {
    return "not_savable";
  }
  await db
    .prepare(
      `INSERT INTO workspace_approval_rule (workspace_id, category, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT (workspace_id, category) DO NOTHING`,
    )
    .bind(workspaceId, category, now)
    .run();
  return "saved";
}

export async function removeWorkspaceRule(
  db: D1Database,
  workspaceId: string,
  category: PermissionCategory,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM workspace_approval_rule WHERE workspace_id = ? AND category = ?")
    .bind(workspaceId, category)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Every saved "Always allow" rule for the workspace, gone: "Allow once" means ask for everything. */
export async function clearWorkspaceRules(db: D1Database, workspaceId: string): Promise<void> {
  await db
    .prepare("DELETE FROM workspace_approval_rule WHERE workspace_id = ?")
    .bind(workspaceId)
    .run();
}

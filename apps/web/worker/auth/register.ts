// Registration, steps 4 to 7 of record 05 (the token and the allowlist are
// checked before this). `usr_` and `wsp_` ids are SHA-256 of the Clerk subject,
// so racing first requests compute identical ids and one atomic batch of
// `INSERT ... ON CONFLICT DO NOTHING` registers at most once. Registering again
// is a no-op returning the same Actor.

import type { Actor } from "./actor";
import { constructActor } from "./actor";

const ID_NAMESPACE = "oncue-identity-v1";

async function digestHex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function deriveUserId(subject: string): Promise<string> {
  return `usr_${await digestHex(`${ID_NAMESPACE}:usr:${subject}`)}`;
}

export async function deriveWorkspaceId(subject: string): Promise<string> {
  return `wsp_${await digestHex(`${ID_NAMESPACE}:wsp:${subject}`)}`;
}

export async function registerActor(db: D1Database, subject: string): Promise<Actor> {
  const userId = await deriveUserId(subject);
  const workspaceId = await deriveWorkspaceId(subject);
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT (id) DO NOTHING",
      )
      .bind(userId, now, now),
    db
      .prepare(
        "INSERT INTO external_identity (provider, subject, user_id, created_at) VALUES ('clerk', ?, ?, ?) ON CONFLICT (provider, subject) DO NOTHING",
      )
      .bind(subject, userId, now),
    db
      .prepare(
        "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT (id) DO NOTHING",
      )
      .bind(workspaceId, userId, now, now),
    db
      .prepare(
        "INSERT INTO workspace_member (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?) ON CONFLICT (workspace_id, user_id) DO NOTHING",
      )
      .bind(workspaceId, userId, now),
  ]);
  return constructActor(userId, workspaceId);
}

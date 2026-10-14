// Reads the facts `deriveSetup` decides on. Only active model connections, only
// verified repositories, and only an active Modal connection count: the browser
// names these on submit, and anything else would be refused. A user whose key
// or Modal credential stopped working, or whose repository was removed, sees
// that setup step again.
//
// A model key that stopped working is reported beside the active ones, never
// among them: Home says what happened to it and still offers only keys a
// session can start on.

import {
  activeSessionsByConnection,
  listActiveConnectionSummaries,
  listConnections,
} from "../broker/connections";
import { readGitHubFact } from "../github/repositories";
import { hasActiveModalConnection } from "../modal/connections";
import { deriveSetup, type InactiveModelConnectionSummary, type SetupState } from "./derive";

/**
 * The workspace's keys that stopped working and were not revoked, each with
 * the active sessions still on it. The sessions are counted only when there
 * is such a key, so the usual read costs one query.
 */
export async function listInactiveConnectionSummaries(
  db: D1Database,
  workspaceId: string,
): Promise<readonly InactiveModelConnectionSummary[]> {
  const inactive: InactiveModelConnectionSummary[] = [];
  for (const { connectionId, provider, status } of await listConnections(db, workspaceId)) {
    // A revoked key is gone for good and its provider takes a new one, so only
    // a key that can still be replaced in place is reported.
    if (status !== "active" && status !== "revoked") {
      inactive.push({ modelConnectionId: connectionId, provider, status, activeSessions: 0 });
    }
  }
  if (inactive.length === 0) {
    return inactive;
  }
  const sessions = await activeSessionsByConnection(db, workspaceId);
  return inactive.map((connection) => ({
    ...connection,
    activeSessions: sessions.get(connection.modelConnectionId) ?? 0,
  }));
}

export async function readSetup(db: D1Database, workspaceId: string): Promise<SetupState> {
  return deriveSetup({
    github: await readGitHubFact(db, workspaceId),
    modelConnections: await listActiveConnectionSummaries(db, workspaceId),
    inactiveModelConnections: await listInactiveConnectionSummaries(db, workspaceId),
    modal: (await hasActiveModalConnection(db, workspaceId)) ? "connected" : "none",
  });
}

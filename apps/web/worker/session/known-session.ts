/**
 * Whether the control plane has ever recorded a session id.
 *
 * The bridge's upgrade and the one-time bearer routes cannot check what they
 * are handed in the Worker: the credential's hash lives only in the session's
 * own object. Asking the object means waking it, and for an id nobody created
 * that makes a new object, which builds its whole schema and is never
 * removed. Anyone who can reach the Worker could do that at no cost to
 * themselves and at a cost in objects and daily quota to the deployment.
 *
 * Every session's index row is written before its object is created
 * (record 03), and a deleted session leaves its deletion request behind as a
 * receipt (record 19), so an id in neither table was never a session. A
 * deleted session must still reach its object, which answers its bridge with
 * the close code that ends it at once.
 *
 * Both arms are point lookups: the index row by primary key, the receipt
 * through `idx_deletion_request_session`.
 */
export const KNOWN_SESSION_SQL = `SELECT 1 AS known FROM session_index WHERE session_id = ?
   UNION ALL
   SELECT 1 AS known FROM deletion_request WHERE session_id = ?
   LIMIT 1`;

/**
 * An unreadable database answers yes. The object still checks the credential,
 * so this lookup guards only against waste, and a sandbox must not lose its
 * session because D1 could not be read for a moment.
 */
export async function isKnownSession(db: D1Database, sessionId: string): Promise<boolean> {
  try {
    const row = await db.prepare(KNOWN_SESSION_SQL).bind(sessionId, sessionId).first();
    return row !== null;
  } catch {
    return true;
  }
}

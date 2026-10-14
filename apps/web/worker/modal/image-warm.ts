// Asks the sandbox controller to prepare the sandbox image in a workspace's own
// Modal account before a session needs it (record 02, "Images and startup").
// Modal caches an image per workspace, so each workspace builds every new
// image once, for minutes. Asking at Modal connect and after each release
// moves that build out of the first session's start.
//
// The ask is fire and forget: the controller starts the build and answers at
// once, and the build continues there. A session's own provisioning still
// prepares the image and waits for it, so a warm that never happened costs
// time, never correctness. The claim on the row keeps concurrent page loads
// from asking twice.

import type { Keyring } from "../broker/envelope";
import { createModalSandboxDriver } from "../sandbox/modal-driver";
import type { ControllerSettings } from "../sandbox/origin";
import { openModalCredential } from "./connections";

/** A workspace asked this long ago is asked again, which catches a controller deployed without a Worker release. */
export const WARM_STALE_MS = 6 * 60 * 60 * 1000;

/** A failed or superseded ask is repeated no sooner than this, so a broken controller is not asked on every page load. */
export const WARM_RETRY_MS = 10 * 60 * 1000;

/** The ask waits for nothing, so it needs only a round trip. */
export const WARM_REQUEST_TIMEOUT_MS = 10_000;

export interface ImageWarmDeps {
  readonly db: D1Database;
  readonly keyring: Keyring<"credential">;
  readonly settings: ControllerSettings;
  readonly fetchImpl: typeof fetch;
  /** The Worker's `ONCUE_RELEASE`. */
  readonly release: string;
  readonly nowMs: number;
}

/**
 * `current`: nothing to do, or no active connection. `requested`: the
 * controller has the build. `no_credential` and `failed` leave the row to be
 * asked again after `WARM_RETRY_MS`.
 */
export type ImageWarmOutcome = "current" | "requested" | "no_credential" | "failed";

/**
 * Claims the workspace's warm and asks for it, when `force` says so (a new
 * connection) or the last ask was for another release or long ago.
 */
export async function warmWorkspaceImage(
  deps: ImageWarmDeps,
  workspaceId: string,
  force: boolean,
): Promise<ImageWarmOutcome> {
  const now = new Date(deps.nowMs).toISOString();
  const claimed = await deps.db
    .prepare(
      `UPDATE modal_connection SET image_warmed_release = ?, image_warmed_at = ?
        WHERE workspace_id = ? AND status = 'active'
          AND (? = 1
            OR image_warmed_at IS NULL
            OR image_warmed_at < ?
            OR (image_warmed_release IS NOT ? AND image_warmed_at < ?))`,
    )
    .bind(
      deps.release,
      now,
      workspaceId,
      force ? 1 : 0,
      new Date(deps.nowMs - WARM_STALE_MS).toISOString(),
      deps.release,
      new Date(deps.nowMs - WARM_RETRY_MS).toISOString(),
    )
    .run();
  if (claimed.meta.changes === 0) {
    return "current";
  }
  const opened = await openModalCredential(deps.db, deps.keyring, workspaceId);
  if (opened.kind !== "opened") {
    await unclaim(deps.db, workspaceId, now);
    return "no_credential";
  }
  const driver = createModalSandboxDriver({
    settings: deps.settings,
    credential: opened.credential,
    fetchImpl: deps.fetchImpl,
    timeoutMs: WARM_REQUEST_TIMEOUT_MS,
  });
  const answer = await driver.prepareImage(0);
  if (answer.kind !== "ok") {
    await unclaim(deps.db, workspaceId, now);
    return "failed";
  }
  return "requested";
}

/**
 * Forgets which release this claim was for but keeps when it was made, so
 * the next ask waits `WARM_RETRY_MS`. Only this claim's own row state is
 * changed: a later claim has a later time.
 */
async function unclaim(db: D1Database, workspaceId: string, claimedAt: string): Promise<void> {
  await db
    .prepare(
      "UPDATE modal_connection SET image_warmed_release = NULL WHERE workspace_id = ? AND image_warmed_at = ?",
    )
    .bind(workspaceId, claimedAt)
    .run();
}

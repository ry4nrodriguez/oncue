/**
 * Starts `warmWorkspaceImage` from a route, after the response: at Modal
 * connect (forced) and on every `GET /api/me` (only when the workspace's last
 * ask is for another release or old). A deployment with no controller, or no
 * keyring, has nothing to warm. Nothing here can fail the request it rides on.
 */

import { log } from "../log";
import { warmWorkspaceImage } from "../modal/image-warm";
import { readControllerConfig } from "../sandbox/origin";
import { cachedCredentialKeyring } from "./credential-keyring";

/** `ctx.waitUntil`, or nothing for a caller with no execution context. */
export type Defer = (work: Promise<unknown>) => void;

export async function startImageWarm(
  env: Env,
  workspaceId: string,
  force: boolean,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<void> {
  const controller = readControllerConfig(env, env.ONCUE_ENV);
  if (controller.kind === "unconfigured") {
    return;
  }
  const keyring = await cachedCredentialKeyring(env.ONCUE_BROKER_KEYRING);
  if (keyring.kind !== "ok") {
    return;
  }
  let outcome: string;
  try {
    outcome = await warmWorkspaceImage(
      {
        db: env.DB,
        keyring: keyring.keyring,
        settings: controller.settings,
        fetchImpl,
        release: env.ONCUE_RELEASE,
        nowMs: Date.now(),
      },
      workspaceId,
      force,
    );
  } catch {
    outcome = "threw";
  }
  if (outcome === "current") {
    return;
  }
  log({
    timestamp: new Date().toISOString(),
    severity: outcome === "requested" ? "info" : "warn",
    service: "worker",
    release: env.ONCUE_RELEASE,
    environment: env.ONCUE_ENV,
    operation: "modal.image_warm",
    result: outcome,
  });
}

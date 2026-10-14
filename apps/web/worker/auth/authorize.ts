// Steps 1 to 4 of record 05's authorization rule; the calling route owns steps
// 5 and 6. `authorizeActor` validates the Clerk session and resolves (or
// registers) the user; `authorizeSessionRequest` also resolves the session to
// its workspace from `session_index`, confirms ownership, and refuses a
// session being deleted (record 19). A client-supplied workspace id never
// enters the decision.
//
// `resource_not_found` and `not_owner` must look identical to a caller, or an
// attacker learns which session ids exist; the status and close-code maps
// enforce that once here.

import { atMostOne } from "../sql";
import type { Actor } from "./actor";
import { actorWorkspaceId } from "./actor";
import type { AllowlistCache } from "./allowlist";
import { checkAllowlist } from "./allowlist";
import { verifyClerkSession } from "./clerk";
import { registerActor } from "./register";

export type AuthorizeDenialReason =
  | "unauthenticated"
  | "not_allowlisted"
  | "resource_not_found"
  | "not_owner";

export type AuthorizeActorOutcome =
  | { readonly kind: "authorized"; readonly actor: Actor }
  | { readonly kind: "denied"; readonly reason: "unauthenticated" }
  | { readonly kind: "denied"; readonly reason: "not_allowlisted"; readonly clerkSubject: string };

export async function authorizeActor(
  env: Env,
  request: Request,
  allowlistCache: AllowlistCache,
): Promise<AuthorizeActorOutcome> {
  const verification = await verifyClerkSession(request, env.CLERK_JWT_KEY);
  if (verification.kind !== "verified") {
    return { kind: "denied", reason: "unauthenticated" };
  }

  const allowlistDecision = await checkAllowlist(
    env.DB,
    env.ONCUE_USER_ALLOWLIST,
    allowlistCache,
    Date.now(),
    verification.subject,
  );
  if (allowlistDecision.kind !== "allowed") {
    return { kind: "denied", reason: "not_allowlisted", clerkSubject: verification.subject };
  }

  const actor = await registerActor(env.DB, verification.subject);
  return { kind: "authorized", actor };
}

export type AuthorizeOutcome =
  | { readonly kind: "authorized"; readonly actor: Actor }
  | { readonly kind: "denied"; readonly reason: AuthorizeDenialReason };

export const AUTHORIZE_DENIAL_HTTP_STATUS: Record<AuthorizeDenialReason, number> = {
  unauthenticated: 401,
  not_allowlisted: 403,
  resource_not_found: 403,
  not_owner: 403,
};

/** Collapses like the close code, so the reason cannot reveal whether a session exists. */
export const AUTHORIZE_DENIAL_WS_CLOSE_REASON: Record<AuthorizeDenialReason, string> = {
  unauthenticated: "unauthenticated",
  not_allowlisted: "forbidden",
  resource_not_found: "forbidden",
  not_owner: "forbidden",
};

export const AUTHORIZE_DENIAL_WS_CLOSE_CODE: Record<AuthorizeDenialReason, number> = {
  unauthenticated: 4401,
  not_allowlisted: 4403,
  resource_not_found: 4403,
  not_owner: 4403,
};

type SessionWorkspaceRow = {
  readonly workspace_id: string;
  readonly state: string;
};

export interface SessionRequestOptions {
  /**
   * Whether a session being deleted still authorizes. Only the delete route
   * says yes, so a repeated delete is answered the same way; everything else
   * treats a deleting session as gone.
   */
  readonly allowDeletionPending?: boolean;
}

export async function authorizeSessionRequest(
  env: Env,
  request: Request,
  sessionId: string,
  allowlistCache: AllowlistCache,
  options: SessionRequestOptions = {},
): Promise<AuthorizeOutcome> {
  const actorOutcome = await authorizeActor(env, request, allowlistCache);
  if (actorOutcome.kind === "denied") {
    return { kind: "denied", reason: actorOutcome.reason };
  }
  const actor = actorOutcome.actor;

  const resource = await atMostOne<SessionWorkspaceRow>(
    env.DB.prepare("SELECT workspace_id, state FROM session_index WHERE session_id = ?").bind(
      sessionId,
    ),
  );
  if (resource.kind === "absent") {
    return { kind: "denied", reason: "resource_not_found" };
  }
  if (resource.row.workspace_id !== actorWorkspaceId(actor)) {
    return { kind: "denied", reason: "not_owner" };
  }
  // Checked after ownership, and denied as missing: a deleting session is
  // gone to its owner and still unknowable to anyone else.
  if (resource.row.state === "deletion_pending" && options.allowDeletionPending !== true) {
    return { kind: "denied", reason: "resource_not_found" };
  }

  return { kind: "authorized", actor };
}

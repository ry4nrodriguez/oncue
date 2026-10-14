/**
 * `/api/approval-settings`: the workspace's agent permission settings (record
 * 09, "Agent permissions"). The approvals picker, on Home and in a session,
 * reads and saves the default and shows what this answers, which is what is in
 * force; Settings lists the default and the saved "Always allow" rules with
 * Remove. Every statement names the verified actor's workspace, so
 * no route takes a workspace id. A session's own mode is changed through its
 * object (`approval.mode`), never here.
 *
 *   GET    /api/approval-settings                     the default and the rules
 *   PUT    /api/approval-settings/default  { mode }   "ask" or "always"
 *   DELETE /api/approval-settings/rules/<category>    remove one saved rule
 */

import {
  clearWorkspaceRules,
  isSavableCategory,
  readWorkspaceApprovals,
  removeWorkspaceRule,
  writeWorkspaceDefault,
} from "../approvals/store";
import { actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { authorizeActor } from "../auth/authorize";
import { isPlainObject } from "../broker/providers/adapter";
import { safeJsonParse } from "../json";

export type ApprovalSettingsRoute =
  | { readonly kind: "read" }
  | { readonly kind: "set_default" }
  | { readonly kind: "remove_rule"; readonly category: string };

const BASE = "/api/approval-settings";
const RULE_PREFIX = `${BASE}/rules/`;

/** Which route a request names, or null. The category is checked by the handler. */
export function matchApprovalSettingsRoute(
  pathname: string,
  method: string,
): ApprovalSettingsRoute | null {
  if (pathname === BASE && method === "GET") {
    return { kind: "read" };
  }
  if (pathname === `${BASE}/default` && method === "PUT") {
    return { kind: "set_default" };
  }
  if (pathname.startsWith(RULE_PREFIX) && method === "DELETE") {
    const category = pathname.slice(RULE_PREFIX.length);
    return category.length === 0 || category.includes("/")
      ? null
      : { kind: "remove_rule", category };
  }
  return null;
}

export async function handleApprovalSettings(
  route: ApprovalSettingsRoute,
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
  now: () => string = () => new Date().toISOString(),
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return Response.json(
      { error: outcome.reason },
      { status: outcome.reason === "unauthenticated" ? 401 : 403 },
    );
  }
  const workspaceId = actorWorkspaceId(outcome.actor);
  switch (route.kind) {
    case "read":
      return Response.json(await readWorkspaceApprovals(env.DB, workspaceId));
    case "set_default": {
      const parsed = safeJsonParse(await request.text());
      const mode = parsed.ok && isPlainObject(parsed.value) ? parsed.value.mode : undefined;
      if (mode !== "ask" && mode !== "always") {
        return Response.json({ error: "invalid_request", reason: "mode" }, { status: 400 });
      }
      await writeWorkspaceDefault(env.DB, workspaceId, mode, now());
      // The picker names the whole mode in force, so going back to asking
      // drops any one-kind allows a card saved along the way.
      if (mode === "ask") {
        await clearWorkspaceRules(env.DB, workspaceId);
      }
      return Response.json(await readWorkspaceApprovals(env.DB, workspaceId));
    }
    case "remove_rule": {
      if (!isSavableCategory(route.category)) {
        return Response.json({ error: "invalid_request", reason: "category" }, { status: 400 });
      }
      await removeWorkspaceRule(env.DB, workspaceId, route.category);
      return Response.json(await readWorkspaceApprovals(env.DB, workspaceId));
    }
  }
}

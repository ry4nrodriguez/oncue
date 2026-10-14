/**
 * `GET /api/me`: registration's front door (record 05). `authorizeActor`
 * decides; this route shapes the response. A blocked subject never reaches
 * `registerActor`.
 *
 * The blocked body includes the caller's own Clerk subject only when
 * `ONCUE_ENV` is `local`, so a developer can copy it into `.dev.vars`; the
 * hosted and local shapes are built on separate branches so it cannot leak.
 * The 200 body carries `setup`, so the auth gate and setup screens always read
 * the same snapshot in one round trip.
 */

import { actorUserId, actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { authorizeActor } from "../auth/authorize";
import { PROVIDER_IDS, type ProviderId } from "../broker/providers/adapter";
import { catalogFor, type ModelSpec } from "../broker/providers/catalog";
import { runtimeSummaries } from "../runtime/resolve";
import { readSetup } from "../setup/read";
import { type Defer, startImageWarm } from "./image-warm";

/** Every provider's models, connected or not: the composer lists them all and offers Connect for the rest. */
export function modelCatalog(): Readonly<Record<ProviderId, readonly ModelSpec[]>> {
  return Object.fromEntries(
    PROVIDER_IDS.map((provider) => [provider, catalogFor(provider)]),
  ) as Record<ProviderId, readonly ModelSpec[]>;
}

/**
 * A ready workspace's setup plus what its composer may offer: the allowed
 * harnesses and the whole model catalog, so missing keys can be offered a
 * Connect.
 */
export function withRuntimes<T extends { readonly kind: string }>(
  setup: T,
  allowlist: string | undefined,
):
  | T
  | (T & {
      readonly runtimes: ReturnType<typeof runtimeSummaries>;
      readonly catalog: ReturnType<typeof modelCatalog>;
    }) {
  return setup.kind === "ready"
    ? { ...setup, runtimes: runtimeSummaries(allowlist), catalog: modelCatalog() }
    : setup;
}

export async function handleMe(
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
  defer: Defer = () => undefined,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied" && outcome.reason === "unauthenticated") {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (outcome.kind === "denied") {
    if (env.ONCUE_ENV === "local") {
      return Response.json(
        { error: "not_allowlisted", clerkSubject: outcome.clerkSubject },
        { status: 403 },
      );
    }
    return Response.json({ error: "not_allowlisted" }, { status: 403 });
  }

  const workspaceId = actorWorkspaceId(outcome.actor);
  // Every app load passes here, so a release reaches each workspace's image
  // before its first session does; a current workspace costs one row.
  defer(startImageWarm(env, workspaceId, false));
  const setup = await readSetup(env.DB, workspaceId);
  return Response.json(
    {
      userId: actorUserId(outcome.actor),
      workspaceId,
      // The deployment's harness allowlist, never the workspace's own choice.
      setup: withRuntimes(
        setup,
        (env as { readonly ONCUE_RUNTIME_ALLOWLIST?: string | undefined }).ONCUE_RUNTIME_ALLOWLIST,
      ),
    },
    { status: 200 },
  );
}

// The allowlist cache is module-scoped so its 60-second TTL holds across
// requests in an isolate; every route shares this one instance.
//
// The same-origin guard runs before dispatch and before any cookie is read, so
// a new route is protected unless it is listed in `SAME_ORIGIN_EXEMPTIONS`.

import {
  handleDownloadArtifact,
  handleRestoreArtifact,
  handleUploadArtifact,
  matchArtifactPath,
} from "./artifacts/upload";
import {
  handleDiscardAttachment,
  handleFetchAttachment,
  handleUploadAttachment,
  handleViewAttachment,
  matchAttachmentRoute,
} from "./attachments/routes";
import { sweepUnclaimedAttachments } from "./attachments/store";
import { createAllowlistCache } from "./auth/allowlist";
import { refuseCrossSiteRequest } from "./auth/same-origin";
import { PROVIDER_ADAPTERS, resolveProviderOrigin } from "./broker/providers/adapter";
import { realDeletionObjects, runDeletion, runPendingDeletions } from "./deletion/job";
import { log } from "./log";
import { handleApprovalSettings, matchApprovalSettingsRoute } from "./routes/approval-settings";
import { extractBranchesRepositoryId, handleListBranches } from "./routes/branches";
import {
  extractBrokerTokenSessionId,
  extractForwardSessionId,
  handleForwardModelRequest,
  handleIssueBrokerToken,
  handleRefreshBrokerToken,
} from "./routes/broker";
import { handleGitHubWebhookRequest } from "./routes/github-webhook";
import { handleMe } from "./routes/me";
import {
  handleDisconnectModalConnection,
  handleReadModalConnection,
  handleSaveModalConnection,
} from "./routes/modal-connection";
import {
  extractModelConnectionId,
  extractRecheckModelConnectionId,
  extractRevokeModelConnectionId,
  handleCreateModelConnection,
  handleListModelConnections,
  handleRecheckModelConnection,
  handleReplaceModelConnectionCredential,
  handleRevokeModelConnection,
} from "./routes/model-connections";
import {
  extractRemoveRepositoryId,
  extractRestoreRepositoryId,
  handleCreateInstallUrl,
  handleGitHubCallback,
  handleListRepositories,
  handleSetRepositoryRemoved,
} from "./routes/repositories";
import { handleSecretsRequest, matchSecretsRoute } from "./routes/secrets";
import {
  handleArchiveSession,
  matchArchiveRoute,
  realArchiveCaller,
} from "./routes/session-archive";
import {
  extractDeleteSessionId,
  handleDeleteSession,
  realDeleteDeps,
} from "./routes/session-delete";
import { handleSessionFile, matchSessionFileRoute } from "./routes/session-files";
import { extractKeepAliveSessionId, handleKeepAlive } from "./routes/session-keep-alive";
import { extractStopSessionId, handleStopSandbox, realStopCaller } from "./routes/session-stop";
import {
  handleCreateSession,
  realObjectCaller,
  realSessionProbe,
  sweepCreatingSessions,
} from "./routes/sessions";
import { handleListSessions } from "./routes/sessions-list";
import { handleWebSocketUpgrade } from "./routes/ws";
import { handleBridgeWebSocketUpgrade } from "./routes/ws-bridge";

export { SessionObject } from "./session/session-object";

const allowlistCache = createAllowlistCache();

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const crossSiteRefusal = refuseCrossSiteRequest(request);
    if (crossSiteRefusal !== null) {
      return crossSiteRefusal;
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return handleHealth(env);
    }

    if (url.pathname === "/api/me" && request.method === "GET") {
      return handleMe(request, env, allowlistCache, (work) => ctx.waitUntil(work));
    }

    if (url.pathname === "/api/sessions" && request.method === "POST") {
      return handleCreateSession(request, env, realObjectCaller(env), allowlistCache);
    }

    if (url.pathname === "/api/sessions" && request.method === "GET") {
      return handleListSessions(request, env, allowlistCache);
    }

    if (url.pathname === "/api/repositories" && request.method === "GET") {
      return handleListRepositories(request, env, allowlistCache);
    }

    if (url.pathname === "/api/github/install-url" && request.method === "POST") {
      return handleCreateInstallUrl(request, env, allowlistCache);
    }

    if (request.method === "GET") {
      const branchesRepositoryId = extractBranchesRepositoryId(url.pathname);
      if (branchesRepositoryId !== null) {
        return handleListBranches(request, env, branchesRepositoryId, allowlistCache);
      }
    }

    if (request.method === "DELETE") {
      const removeId = extractRemoveRepositoryId(url.pathname);
      if (removeId !== null) {
        return handleSetRepositoryRemoved(request, env, removeId, true, allowlistCache);
      }
    }
    if (request.method === "POST") {
      const restoreId = extractRestoreRepositoryId(url.pathname);
      if (restoreId !== null) {
        return handleSetRepositoryRemoved(request, env, restoreId, false, allowlistCache);
      }
    }

    // A GET by navigation from GitHub, which the same-origin guard does not
    // cover; the signed `state` proves OnCue started the flow.
    if (url.pathname === "/api/github/callback" && request.method === "GET") {
      return handleGitHubCallback(request, env, allowlistCache);
    }

    // Authenticated by its HMAC signature, not a cookie; GitHub is always a
    // cross-site caller, so `SAME_ORIGIN_EXEMPTIONS` lists it.
    if (url.pathname === "/api/github/webhook" && request.method === "POST") {
      return handleGitHubWebhookRequest(request, env);
    }

    if (url.pathname === "/api/model-connections" && request.method === "GET") {
      return handleListModelConnections(request, env, allowlistCache);
    }

    if (url.pathname === "/api/model-connections" && request.method === "POST") {
      return handleCreateModelConnection(request, env, allowlistCache);
    }

    if (request.method === "POST") {
      const stopSessionId = extractStopSessionId(url.pathname);
      if (stopSessionId !== null) {
        return handleStopSandbox(request, env, stopSessionId, realStopCaller(env), allowlistCache);
      }
      const keepAliveSessionId = extractKeepAliveSessionId(url.pathname);
      if (keepAliveSessionId !== null) {
        return handleKeepAlive(request, env, keepAliveSessionId, allowlistCache);
      }
    }

    // An unchanged file, read from GitHub at the session's base commit
    // (record 13). The session object is not woken.
    const fileSessionId = matchSessionFileRoute(url.pathname, request.method);
    if (fileSessionId !== null) {
      return handleSessionFile(request, env, fileSessionId, allowlistCache);
    }

    // Upload, discard, and view are cookie-authorized; the bridge's fetch
    // carries a one-time bearer the session object minted.
    const attachmentRoute = matchAttachmentRoute(url.pathname, request.method);
    if (attachmentRoute !== null) {
      switch (attachmentRoute.kind) {
        case "upload":
          return handleUploadAttachment(request, env, allowlistCache);
        case "discard":
          return handleDiscardAttachment(
            request,
            env,
            attachmentRoute.attachmentId,
            allowlistCache,
          );
        case "view":
          return handleViewAttachment(request, env, attachmentRoute, allowlistCache);
        case "fetch":
          return handleFetchAttachment(request, env, attachmentRoute);
      }
    }

    // A sandbox's upload and restore carry a one-time bearer, not a cookie; the
    // download is authorized like any other session route.
    const artifactPath = matchArtifactPath(url.pathname);
    if (artifactPath !== null) {
      if (request.method === "PUT" && !artifactPath.restore) {
        return handleUploadArtifact(request, env, artifactPath);
      }
      if (request.method === "GET") {
        return artifactPath.restore
          ? handleRestoreArtifact(request, env, artifactPath)
          : handleDownloadArtifact(request, env, artifactPath, allowlistCache);
      }
    }

    if (request.method === "POST") {
      const revokeConnectionId = extractRevokeModelConnectionId(url.pathname);
      if (revokeConnectionId !== null) {
        return handleRevokeModelConnection(request, env, revokeConnectionId, allowlistCache);
      }
      const recheckConnectionId = extractRecheckModelConnectionId(url.pathname);
      if (recheckConnectionId !== null) {
        return handleRecheckModelConnection(request, env, recheckConnectionId, allowlistCache);
      }
    }

    if (request.method === "PUT") {
      const replaceConnectionId = extractModelConnectionId(url.pathname);
      if (replaceConnectionId !== null) {
        return handleReplaceModelConnectionCredential(
          request,
          env,
          replaceConnectionId,
          allowlistCache,
        );
      }
    }

    // Development secrets: no response carries a value.
    const secretsRoute = matchSecretsRoute(url.pathname, request.method);
    if (secretsRoute !== null) {
      return handleSecretsRequest(secretsRoute, request, env, allowlistCache);
    }

    const approvalSettingsRoute = matchApprovalSettingsRoute(url.pathname, request.method);
    if (approvalSettingsRoute !== null) {
      return handleApprovalSettings(approvalSettingsRoute, request, env, allowlistCache);
    }

    // Singular: a workspace has one Modal account, so there is no `:id` for a
    // caller to name someone else's connection.
    if (url.pathname === "/api/modal-connection" && request.method === "GET") {
      return handleReadModalConnection(request, env, allowlistCache);
    }

    if (url.pathname === "/api/modal-connection" && request.method === "POST") {
      return handleSaveModalConnection(request, env, allowlistCache, (work) => ctx.waitUntil(work));
    }

    if (url.pathname === "/api/modal-connection" && request.method === "DELETE") {
      return handleDisconnectModalConnection(request, env, allowlistCache);
    }

    if (url.pathname === "/api/broker/token/refresh" && request.method === "POST") {
      return handleRefreshBrokerToken(request, env);
    }

    if (request.method === "POST") {
      const tokenSessionId = extractBrokerTokenSessionId(url.pathname);
      if (tokenSessionId !== null) {
        return handleIssueBrokerToken(request, env, tokenSessionId, allowlistCache);
      }
      const forwardSessionId = extractForwardSessionId(url.pathname);
      if (forwardSessionId !== null) {
        // `waitUntil` marks a rejected connection invalid without delaying the
        // sandbox's response.
        return handleForwardModelRequest(request, env, forwardSessionId, (work) =>
          ctx.waitUntil(work),
        );
      }
    }

    if (request.method === "DELETE") {
      const deleteSessionId = extractDeleteSessionId(url.pathname);
      if (deleteSessionId !== null) {
        // The job's first attempt runs after the response, so a slow stop or
        // R2 never holds the browser; the scheduled handler retries it.
        const deps = realDeleteDeps(
          env,
          (requestId) => runDeletion(env, realDeletionObjects(env), requestId),
          (work) => ctx.waitUntil(work),
        );
        return handleDeleteSession(request, env, deleteSessionId, deps, allowlistCache);
      }
    }

    const archiveRoute = matchArchiveRoute(url.pathname, request.method);
    if (archiveRoute !== null) {
      return handleArchiveSession(
        request,
        env,
        archiveRoute,
        realArchiveCaller(env),
        allowlistCache,
      );
    }

    // Checked before `/ws/`: the bridge authenticates with a generation-scoped
    // bootstrap credential, never a Clerk cookie.
    if (url.pathname.startsWith("/ws/bridge/")) {
      return handleBridgeWebSocketUpgrade(request, env);
    }

    if (url.pathname.startsWith("/ws/")) {
      return handleWebSocketUpgrade(request, env, allowlistCache);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller, env, _ctx): Promise<void> {
    await runScheduledSweeps(env, {
      creating: () => sweepCreatingSessions(env.DB, realSessionProbe(env)),
      attachments: () => sweepUnclaimedAttachments(env.DB, env.ARTIFACTS),
      deletions: () => runPendingDeletions(env, realDeletionObjects(env)),
    });
  },
} satisfies ExportedHandler<Env>;

/**
 * Every sweep runs on every tick, each on its own: one that throws is logged
 * and the rest still run, so a D1 hiccup in one cannot starve the others.
 */
export async function runScheduledSweeps(
  env: Pick<Env, "ONCUE_RELEASE" | "ONCUE_ENV">,
  sweeps: Readonly<Record<string, () => Promise<unknown>>>,
): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const [name, sweep] of Object.entries(sweeps)) {
    try {
      await sweep();
    } catch {
      failed.push(name);
      log({
        timestamp: new Date().toISOString(),
        severity: "error",
        service: "web-worker",
        release: env.ONCUE_RELEASE,
        environment: env.ONCUE_ENV,
        operation: "scheduled.sweep",
        result: "failed",
        errorCategory: name,
      });
    }
  }
  return failed;
}

/**
 * Whether provider traffic is redirected away from the real providers. A test
 * with a real key checks this before starting, because key validation reaches
 * the provider before any later assertion could. Uses `resolveProviderOrigin`
 * so it reports what the broker will do; hosted always answers false.
 */
function providerTrafficRedirected(env: Env): boolean {
  const adapter = PROVIDER_ADAPTERS.anthropic;
  return (
    resolveProviderOrigin(adapter, env.ONCUE_ENV, env.ONCUE_PROVIDER_DOUBLE_ORIGIN) !==
    adapter.origin
  );
}

function handleHealth(env: Env): Response {
  log({
    timestamp: new Date().toISOString(),
    severity: "info",
    service: "web-worker",
    release: env.ONCUE_RELEASE,
    environment: env.ONCUE_ENV,
    operation: "api.health",
    result: "ok",
  });

  return Response.json({
    ok: true,
    env: env.ONCUE_ENV,
    release: env.ONCUE_RELEASE,
    providerTrafficRedirected: providerTrafficRedirected(env),
  });
}

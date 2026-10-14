/**
 * `POST /api/github/webhook`: the HTTP shell around `worker/github/webhooks.ts`.
 *
 * The body is read once with `request.text()` and passed unparsed, because the
 * signature is an HMAC over GitHub's exact bytes. The route is exempt from the
 * same-origin guard (`SAME_ORIGIN_EXEMPTIONS`); the signature authenticates it
 * instead. Everything except a bad signature answers 202, since GitHub retries
 * any failure and a 5xx would cause a redelivery storm.
 */

import { handleGitHubWebhook, type WebhookDeps, type WebhookOutcomeKind } from "../github/webhooks";
import { log } from "../log";

// A total table, so a new outcome kind is a compile error.
const OUTCOME_STATUS: Record<WebhookOutcomeKind, number> = {
  unauthorized: 401,
  replayed: 202,
  unreadable: 202,
  ignored: 202,
  applied: 202,
  audited: 202,
};

function nonEmpty(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function handleGitHubWebhookRequest(request: Request, env: Env): Promise<Response> {
  const webhookSecret = env.ONCUE_GITHUB_WEBHOOK_SECRET;
  if (webhookSecret === undefined || webhookSecret.length === 0) {
    // Without a secret nothing can be verified, and an unverifiable delivery must
    // never be treated as genuine.
    return Response.json({ error: "github_unconfigured" }, { status: 401 });
  }

  const deliveryId = nonEmpty(request.headers.get("x-github-delivery"));
  const eventName = nonEmpty(request.headers.get("x-github-event"));
  if (deliveryId === null || eventName === null) {
    // Not something GitHub sends; nothing is recorded.
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const deps: WebhookDeps = {
    db: env.DB,
    webhookSecret,
    now: () => new Date().toISOString(),
    log,
    release: env.ONCUE_RELEASE,
    environment: env.ONCUE_ENV,
    // No slug, no bot login to match: a push then never reads as the App's own.
    appSlug: env.ONCUE_GITHUB_APP_SLUG ?? "",
    // A failure to reach one session must not stop the others being told, so
    // these answer false instead of throwing.
    tellPullRequestState: async (sessionId, change) => {
      try {
        const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
        const answer = await stub.fetch("https://session/internal/pull-request-state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(change),
        });
        return answer.ok;
      } catch {
        return false;
      }
    },
    lockDownSession: async (sessionId) => {
      try {
        const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
        const answer = await stub.fetch("https://session/internal/incident", { method: "POST" });
        return answer.ok;
      } catch {
        return false;
      }
    },
  };

  const outcome = await handleGitHubWebhook(deps, {
    deliveryId,
    eventName,
    signature: request.headers.get("x-hub-signature-256"),
    rawBody: await request.text(),
  });

  // The body names only the outcome, so it cannot confirm which installations
  // or repositories exist.
  return Response.json({ outcome: outcome.kind }, { status: OUTCOME_STATUS[outcome.kind] });
}

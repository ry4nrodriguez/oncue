import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  githubAppAuthorizationRevokedPayload,
  installationWebhookPayload,
  signWebhook,
} from "../test/github-double";
import { handleGitHubWebhookRequest } from "./github-webhook";

// Tests the HTTP shell only; `worker/github/webhooks.test.ts` covers each
// event. Anything but a bad signature must be acknowledged, or GitHub retries.

const URL_UNDER_TEST = "https://oncue.example/api/github/webhook";
const SECRET = "whsec_lane_fixture";
const NOW = "2026-09-05T00:00:00.000Z";
const ACCOUNT = { login: "acme", type: "Organization" } as const;
const SENDER = { id: 42, login: "octocat" } as const;

// The secret is set explicitly, even to `undefined`: `env` carries one from
// `.dev.vars`, which would make the unconfigured case pass for the wrong reason.
function envWith(webhookSecret: string | undefined): Env {
  return { ...env, ONCUE_GITHUB_WEBHOOK_SECRET: webhookSecret } as unknown as Env;
}

// `null` means "no secret"; `undefined` would re-trigger the parameter default.
async function post(
  body: string,
  headers: Record<string, string>,
  webhookSecret: string | null = SECRET,
): Promise<{ status: number; body: unknown }> {
  const request = new Request(URL_UNDER_TEST, { method: "POST", headers, body });
  const response = await handleGitHubWebhookRequest(
    request,
    envWith(webhookSecret === null ? undefined : webhookSecret),
  );
  return { status: response.status, body: await response.json() };
}

async function signedHeaders(
  body: string,
  overrides: { deliveryId?: string; event?: string } = {},
): Promise<Record<string, string>> {
  return {
    "x-github-delivery": overrides.deliveryId ?? `d-${crypto.randomUUID()}`,
    "x-github-event": overrides.event ?? "installation",
    "x-hub-signature-256": await signWebhook(SECRET, body),
  };
}

async function seedInstallation(githubInstallationId: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, status, created_at, updated_at) VALUES ('usr_wh', 'active', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(NOW, NOW),
    env.DB.prepare(
      "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES ('wsp_wh', 'usr_wh', 'private', ?, ?) ON CONFLICT DO NOTHING",
    ).bind(NOW, NOW),
  ]);
  await env.DB.prepare(
    `INSERT INTO github_installation (
       installation_row_id, workspace_id, github_installation_id, github_user_id,
       account_login, account_type, status, user_token_reference, refresh_token_reference,
       user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
     ) VALUES ('ghi_wh', 'wsp_wh', ?, 42, 'acme', 'Organization', 'active',
               'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)`,
  )
    .bind(githubInstallationId, NOW, NOW, NOW, NOW, NOW)
    .run();
}

async function installationStatus(): Promise<string | undefined> {
  const row = await env.DB.prepare(
    "SELECT status FROM github_installation WHERE installation_row_id = 'ghi_wh'",
  ).first<{ status: string }>();
  return row?.status;
}

async function deliveryCount(deliveryId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM webhook_delivery WHERE delivery_id = ?",
  )
    .bind(deliveryId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM webhook_delivery"),
    env.DB.prepare("DELETE FROM repository_connection"),
    env.DB.prepare("DELETE FROM github_installation"),
  ]);
});

describe("handleGitHubWebhookRequest", () => {
  it("refuses a body whose signature does not verify, and records no delivery", async () => {
    const body = JSON.stringify(installationWebhookPayload("deleted", 4001, ACCOUNT, SENDER));
    const deliveryId = "d-forged";

    const result = await post(body, {
      "x-github-delivery": deliveryId,
      "x-github-event": "installation",
      "x-hub-signature-256": await signWebhook("the wrong secret", body),
    });

    expect(result).toEqual({ status: 401, body: { outcome: "unauthorized" } });
    // The ledger must stay clean, or anyone could pre-record a delivery id and
    // have GitHub's real attempt discarded as a replay.
    expect(await deliveryCount(deliveryId)).toBe(0);
  });

  it("refuses a request carrying no signature at all", async () => {
    const body = JSON.stringify(installationWebhookPayload("deleted", 4001, ACCOUNT, SENDER));

    const result = await post(body, {
      "x-github-delivery": "d-unsigned",
      "x-github-event": "installation",
    });

    expect(result.status).toBe(401);
  });

  // Without a secret, no delivery can be treated as genuine.
  it("refuses everything when the deployment has no webhook secret", async () => {
    const body = JSON.stringify(installationWebhookPayload("deleted", 4001, ACCOUNT, SENDER));

    const result = await post(body, await signedHeaders(body), null);

    expect(result).toEqual({ status: 401, body: { error: "github_unconfigured" } });
  });

  it("refuses a request with no delivery id or no event name", async () => {
    const body = "{}";
    const signature = await signWebhook(SECRET, body);

    expect(
      (await post(body, { "x-github-event": "push", "x-hub-signature-256": signature })).status,
    ).toBe(400);
    expect(
      (await post(body, { "x-github-delivery": "d-1", "x-hub-signature-256": signature })).status,
    ).toBe(400);
  });

  it("applies a verified installation deletion and acknowledges it", async () => {
    await seedInstallation(4001);
    const body = JSON.stringify(installationWebhookPayload("deleted", 4001, ACCOUNT, SENDER));

    const result = await post(body, await signedHeaders(body));

    expect(result).toEqual({ status: 202, body: { outcome: "applied" } });
    expect(await installationStatus()).toBe("deleted");
  });

  it("acknowledges a replayed delivery id without applying it a second time", async () => {
    await seedInstallation(4001);
    const suspend = JSON.stringify(installationWebhookPayload("suspend", 4001, ACCOUNT, SENDER));
    const deliveryId = "d-replayed";

    const first = await post(suspend, await signedHeaders(suspend, { deliveryId }));
    expect(first.body).toEqual({ outcome: "applied" });
    expect(await installationStatus()).toBe("suspended");

    // A different payload under the SAME delivery id. If the ledger were not
    // consulted first, this would delete the installation.
    const remove = JSON.stringify(installationWebhookPayload("deleted", 4001, ACCOUNT, SENDER));
    const second = await post(remove, await signedHeaders(remove, { deliveryId }));

    expect(second).toEqual({ status: 202, body: { outcome: "replayed" } });
    expect(await installationStatus()).toBe("suspended");
  });

  // Record 07: a webhook alone never adds an installation, but the route still
  // acknowledges it so GitHub stops resending.
  it("acknowledges an installation creation without creating anything", async () => {
    const body = JSON.stringify(installationWebhookPayload("created", 9999, ACCOUNT, SENDER));

    const result = await post(body, await signedHeaders(body));

    expect(result.status).toBe(202);
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM github_installation").first<{
      count: number;
    }>();
    expect(row?.count).toBe(0);
  });

  it("acknowledges an authorization revocation", async () => {
    await seedInstallation(4001);
    const body = JSON.stringify(githubAppAuthorizationRevokedPayload(42, "octocat"));

    const result = await post(
      body,
      await signedHeaders(body, { event: "github_app_authorization" }),
    );

    expect(result.status).toBe(202);
    expect(await installationStatus()).toBe("unauthorized");
  });

  it("acknowledges an event this build does not handle", async () => {
    // Review comments (record 16) are handled by no arm.
    const body = JSON.stringify({ action: "created" });

    const result = await post(body, await signedHeaders(body, { event: "issue_comment" }));

    expect(result).toEqual({ status: 202, body: { outcome: "ignored" } });
  });

  it("acknowledges a pull_request delivery for a pull request no session opened", async () => {
    const body = JSON.stringify({
      action: "closed",
      number: 41,
      pull_request: { number: 41, merged: true, draft: false },
      repository: { id: 987_654 },
      sender: { login: "octocat" },
    });

    const result = await post(body, await signedHeaders(body, { event: "pull_request" }));

    expect(result).toEqual({ status: 202, body: { outcome: "ignored" } });
  });

  // A valid signature over an unreadable body is acknowledged, or GitHub would
  // retry forever.
  it("acknowledges a verified body that is not JSON", async () => {
    const body = "{ not json";

    const result = await post(body, await signedHeaders(body));

    expect(result).toEqual({ status: 202, body: { outcome: "unreadable" } });
  });

  // The signature covers exact bytes, and `JSON.stringify` would not reproduce
  // GitHub's spacing.
  it("verifies the exact bytes rather than a re-serialized copy", async () => {
    await seedInstallation(4001);
    const spaced = `${JSON.stringify(installationWebhookPayload("deleted", 4001, ACCOUNT, SENDER), null, 2)}\n`;

    const result = await post(spaced, await signedHeaders(spaced));

    expect(result.body).toEqual({ outcome: "applied" });
  });

  it("never answers with a body naming an installation or a repository", async () => {
    await seedInstallation(4001);
    const body = JSON.stringify(installationWebhookPayload("deleted", 4001, ACCOUNT, SENDER));

    const result = await post(body, await signedHeaders(body));

    const text = JSON.stringify(result.body);
    expect(text.includes("4001")).toBe(false);
    expect(text.includes("ghi_wh")).toBe(false);
    expect(text.includes("acme")).toBe(false);
  });
});

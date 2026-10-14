import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { RELEASED_REF_WINDOW_MS, releasedRefHash } from "../deletion/released-refs";
import { LOG_FIELD_ALLOWLIST, log } from "../log";
import {
  githubAppAuthorizationRevokedPayload,
  installationRepositoriesWebhookPayload,
  installationWebhookPayload,
  pushWebhookPayload,
  signWebhook,
} from "../test/github-double";
import {
  deriveInstallationRowId,
  insertOrUpdateInstallation,
  replaceRepositoryConnections,
  setInstallationStatus,
} from "./store";
import {
  handleGitHubWebhook,
  MAX_INCIDENT_SESSIONS,
  type PullRequestStateChange,
  SIGNATURE_PREFIX,
  verifyWebhookSignature,
  type WebhookDeps,
  type WebhookOutcome,
} from "./webhooks";

const NOW = "2026-09-05T00:00:00.000Z";
const SECRET = "whsec_test_only_never_logged";
const USER = "usr_gh_webhook";
const OTHER_USER = "usr_gh_webhook_other";
const WORKSPACE = "wsp_gh_webhook";
const OTHER_WORKSPACE = "wsp_gh_webhook_other";
const GITHUB_INSTALLATION = 7001;
const OTHER_GITHUB_INSTALLATION = 7002;
const GITHUB_USER = 4242;
const OTHER_GITHUB_USER = 4343;
const ACCOUNT = { login: "octocat", type: "User" } as const;
const SENDER = { id: GITHUB_USER, login: "octocat" };
const REPO_A = { id: 101, full_name: "octocat/alpha", default_branch: "main" };
const REPO_B = { id: 102, full_name: "octocat/beta", default_branch: "main" };
const REPO_C = { id: 103, full_name: "octocat/gamma", default_branch: "main" };
const REPO_D = { id: 202, full_name: "octocat/delta", default_branch: "main" };
const TASK_BRANCH = "oncue/fix-login-7f3a";

const APP_SLUG = "oncue-test";
const APP_BOT = { id: 9_000_001, login: `${APP_SLUG}[bot]`, type: "Bot" };

/** Every session the incident rule told to lock down, in order; a test may make one unreachable. */
let lockedDown: string[] = [];
let toldPullRequest: Array<{ sessionId: string; change: PullRequestStateChange }> = [];
let unreachable: ReadonlySet<string> = new Set();

const deps: WebhookDeps = {
  db: env.DB,
  webhookSecret: SECRET,
  now: () => NOW,
  log,
  release: "test",
  environment: "local",
  appSlug: APP_SLUG,
  lockDownSession: async (sessionId) => {
    lockedDown.push(sessionId);
    return !unreachable.has(sessionId);
  },
  tellPullRequestState: async (sessionId, change) => {
    toldPullRequest.push({ sessionId, change });
    return !unreachable.has(sessionId);
  },
};

let consoleLog: MockInstance<typeof console.log>;

/** Every line `log()` wrote, parsed, with the allowlist asserted on each. */
function loggedLines(): Record<string, unknown>[] {
  return consoleLog.mock.calls.map(([line]) => {
    const parsed = JSON.parse(String(line)) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      expect(LOG_FIELD_ALLOWLIST.has(key)).toBe(true);
    }
    return parsed;
  });
}

let deliveryCounter = 0;
function nextDeliveryId(): string {
  deliveryCounter += 1;
  return `delivery-${deliveryCounter}`;
}

interface DeliverOptions {
  readonly deliveryId?: string;
  readonly signature?: string | null;
  readonly rawBody?: string;
}

/** Signs the exact bytes the handler will see, the way GitHub does. */
async function deliver(
  eventName: string,
  payload: unknown,
  options: DeliverOptions = {},
): Promise<WebhookOutcome> {
  const rawBody = options.rawBody ?? JSON.stringify(payload);
  const signature =
    options.signature === undefined ? await signWebhook(SECRET, rawBody) : options.signature;
  return handleGitHubWebhook(deps, {
    deliveryId: options.deliveryId ?? nextDeliveryId(),
    eventName,
    signature,
    rawBody,
  });
}

async function seedWorkspaces(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(USER, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(WORKSPACE, USER, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO user (id, status, created_at, updated_at)
       VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(OTHER_USER, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at)
       VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(OTHER_WORKSPACE, OTHER_USER, NOW, NOW),
  ]);
}

async function insertInstallation(
  workspaceId: string,
  githubInstallationId: number,
  githubUserId: number,
): Promise<string> {
  const installationRowId = await deriveInstallationRowId(workspaceId, githubInstallationId);
  await insertOrUpdateInstallation(env.DB, {
    installationRowId,
    workspaceId,
    githubInstallationId,
    githubUserId,
    accountLogin: ACCOUNT.login,
    accountType: ACCOUNT.type,
    sealedUserToken: "oncue1.1.usernonce.usercipher",
    sealedRefreshToken: "oncue1.1.refreshnonce.refreshcipher",
    userTokenExpiresAt: "2026-09-05T08:00:00.000Z",
    refreshTokenExpiresAt: "2027-03-05T00:00:00.000Z",
    now: NOW,
  });
  return installationRowId;
}

let idCounter = 0;
async function linkRepositories(
  workspaceId: string,
  installationRowId: string,
  repositories: readonly { id: number; full_name: string; default_branch: string }[],
): Promise<void> {
  await replaceRepositoryConnections(env.DB, {
    workspaceId,
    installationRowId,
    repositories: repositories.map((repository) => ({
      githubRepositoryId: repository.id,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
    })),
    newId: () => {
      idCounter += 1;
      return `rc_wh_${idCounter}`;
    },
    now: NOW,
  });
}

async function insertSession(
  sessionId: string,
  workspaceId: string,
  githubRepositoryId: number,
  taskBranch: string | null,
): Promise<void> {
  const connection = await env.DB.prepare(
    "SELECT repository_connection_id FROM repository_connection WHERE workspace_id = ? AND github_repository_id = ?",
  )
    .bind(workspaceId, githubRepositoryId)
    .first<{ repository_connection_id: string }>();
  if (connection === null) {
    throw new Error("seed a repository connection before a session on it");
  }
  await env.DB.prepare(
    `INSERT INTO session_index (
       session_id, workspace_id, task_id, state, sandbox_generation,
       repository_connection_id, task_branch, base_commit_sha, created_at, updated_at
     ) VALUES (?, ?, NULL, 'active', 1, ?, ?, 'a1b2c3', ?, ?)`,
  )
    .bind(sessionId, workspaceId, connection.repository_connection_id, taskBranch, NOW, NOW)
    .run();
}

async function installationStatuses(): Promise<Record<string, string>> {
  const result = await env.DB.prepare(
    "SELECT workspace_id, github_installation_id, status FROM github_installation ORDER BY workspace_id, github_installation_id",
  ).all<{ workspace_id: string; github_installation_id: number; status: string }>();
  const statuses: Record<string, string> = {};
  for (const row of result.results) {
    statuses[`${row.workspace_id}:${row.github_installation_id}`] = row.status;
  }
  return statuses;
}

async function repositoryStatuses(): Promise<Record<string, string>> {
  const result = await env.DB.prepare(
    "SELECT workspace_id, github_repository_id, status FROM repository_connection ORDER BY workspace_id, github_repository_id",
  ).all<{ workspace_id: string; github_repository_id: number; status: string }>();
  const statuses: Record<string, string> = {};
  for (const row of result.results) {
    statuses[`${row.workspace_id}:${row.github_repository_id}`] = row.status;
  }
  return statuses;
}

async function deliveryIds(): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT delivery_id FROM webhook_delivery ORDER BY delivery_id",
  ).all<{ delivery_id: string }>();
  return result.results.map((row) => row.delivery_id);
}

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return row?.count ?? -1;
}

/** Two workspaces linking the same installation, plus one other installation held by another user. */
async function seedTwoWorkspaces(): Promise<{ mine: string; theirs: string; other: string }> {
  const mine = await insertInstallation(WORKSPACE, GITHUB_INSTALLATION, GITHUB_USER);
  const theirs = await insertInstallation(OTHER_WORKSPACE, GITHUB_INSTALLATION, GITHUB_USER);
  const other = await insertInstallation(WORKSPACE, OTHER_GITHUB_INSTALLATION, OTHER_GITHUB_USER);
  return { mine, theirs, other };
}

beforeEach(async () => {
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
  lockedDown = [];
  toldPullRequest = [];
  unreachable = new Set();
  await seedWorkspaces();
  await env.DB.prepare("DELETE FROM session_index").run();
  await env.DB.prepare("DELETE FROM deletion_request").run();
  await env.DB.prepare("DELETE FROM repository_connection").run();
  await env.DB.prepare("DELETE FROM github_installation").run();
  await env.DB.prepare("DELETE FROM webhook_delivery").run();
});

afterEach(() => {
  consoleLog.mockRestore();
});

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ zen: "Keep it logically awesome." });

  it("accepts the signature the double produces over the same bytes", async () => {
    const header = await signWebhook(SECRET, body);

    expect(header.startsWith(SIGNATURE_PREFIX)).toBe(true);
    expect(await verifyWebhookSignature(SECRET, body, header)).toBe(true);
  });

  it("refuses an absent header", async () => {
    expect(await verifyWebhookSignature(SECRET, body, null)).toBe(false);
  });

  it("refuses a header without the sha256= prefix", async () => {
    const header = await signWebhook(SECRET, body);

    expect(await verifyWebhookSignature(SECRET, body, header.slice(SIGNATURE_PREFIX.length))).toBe(
      false,
    );
    expect(await verifyWebhookSignature(SECRET, body, `sha1=${header.slice(7)}`)).toBe(false);
  });

  it("refuses a digest of the right length with the wrong content", async () => {
    const header = await signWebhook(SECRET, body);
    const lastChar = header.slice(-1);
    const flipped = `${header.slice(0, -1)}${lastChar === "0" ? "1" : "0"}`;

    expect(flipped.length).toBe(header.length);
    expect(await verifyWebhookSignature(SECRET, body, flipped)).toBe(false);
  });

  it("refuses a digest of the wrong length", async () => {
    const header = await signWebhook(SECRET, body);

    expect(await verifyWebhookSignature(SECRET, body, header.slice(0, -2))).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, `${header}00`)).toBe(false);
  });

  it("refuses a signature minted under another secret", async () => {
    const header = await signWebhook("some-other-secret", body);

    expect(await verifyWebhookSignature(SECRET, body, header)).toBe(false);
  });

  it("is over the exact bytes: a re-serialised body with different whitespace does not verify", async () => {
    const header = await signWebhook(SECRET, body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);

    expect(reserialised).not.toBe(body);
    expect(await verifyWebhookSignature(SECRET, reserialised, header)).toBe(false);
  });
});

describe("handleGitHubWebhook", () => {
  describe("signature and ledger, in that order", () => {
    it("refuses a bad signature, records no delivery, changes no row, and logs nothing", async () => {
      await seedTwoWorkspaces();
      const payload = installationWebhookPayload("deleted", GITHUB_INSTALLATION, ACCOUNT, SENDER);
      const before = await installationStatuses();

      const outcome = await deliver("installation", payload, {
        deliveryId: "forged-1",
        signature: await signWebhook("wrong-secret", JSON.stringify(payload)),
      });

      expect(outcome).toEqual({ kind: "unauthorized" });
      expect(await deliveryIds()).toEqual([]);
      expect(await installationStatuses()).toEqual(before);
      expect(loggedLines()).toEqual([]);
    });

    it("refuses an absent signature the same way", async () => {
      const payload = installationWebhookPayload("deleted", GITHUB_INSTALLATION, ACCOUNT, SENDER);

      const outcome = await deliver("installation", payload, { signature: null });

      expect(outcome).toEqual({ kind: "unauthorized" });
      expect(await deliveryIds()).toEqual([]);
    });

    it("acknowledges a replayed delivery id without applying it again", async () => {
      await seedTwoWorkspaces();
      const payload = installationWebhookPayload("suspend", GITHUB_INSTALLATION, ACCOUNT, SENDER);

      const first = await deliver("installation", payload, { deliveryId: "dup-1" });
      expect(first).toEqual({ kind: "applied", changedRows: 2 });
      expect((await installationStatuses())[`${WORKSPACE}:${GITHUB_INSTALLATION}`]).toBe(
        "suspended",
      );

      // The user re-authorised in between, so a redelivery that applied
      // again would undo a legitimate restoration.
      await setInstallationStatus(env.DB, GITHUB_INSTALLATION, "active", NOW);

      const second = await deliver("installation", payload, { deliveryId: "dup-1" });

      expect(second).toEqual({ kind: "replayed" });
      expect((await installationStatuses())[`${WORKSPACE}:${GITHUB_INSTALLATION}`]).toBe("active");
      expect(await deliveryIds()).toEqual(["dup-1"]);
    });

    it("records the delivery id and event name on a first delivery", async () => {
      await deliver("ping", { zen: "Design for failure." }, { deliveryId: "ping-1" });

      const row = await env.DB.prepare(
        "SELECT event_name, received_at FROM webhook_delivery WHERE delivery_id = 'ping-1'",
      ).first<{ event_name: string; received_at: string }>();
      expect(row).toEqual({ event_name: "ping", received_at: NOW });
    });
  });

  describe("bodies this build cannot read", () => {
    it("acknowledges malformed JSON under a valid signature and logs it, without the body", async () => {
      const rawBody = '{"action": "deleted", "installation": {"id": 7001';

      const outcome = await deliver("installation", null, { deliveryId: "bad-json", rawBody });

      expect(outcome).toEqual({ kind: "unreadable" });
      expect(await deliveryIds()).toEqual(["bad-json"]);
      const lines = loggedLines();
      expect(lines).toEqual([
        {
          timestamp: NOW,
          severity: "warn",
          service: "github-webhook",
          release: "test",
          environment: "local",
          operation: "github.webhook",
          result: "payload not readable",
          deliveryId: "bad-json",
        },
      ]);
      const text = JSON.stringify(lines);
      expect(text.includes("7001")).toBe(false);
      expect(text.includes(SECRET)).toBe(false);
    });

    it("acknowledges valid JSON that is not an object", async () => {
      const outcome = await deliver("installation", [1, 2, 3]);

      expect(outcome).toEqual({ kind: "unreadable" });
      expect(loggedLines().map((line) => line.result)).toEqual(["payload not readable"]);
    });

    it("acknowledges an unknown event name and applies nothing", async () => {
      await seedTwoWorkspaces();
      const before = await installationStatuses();

      const outcome = await deliver("star", { action: "created", sender: SENDER });

      expect(outcome).toEqual({ kind: "ignored" });
      expect(await installationStatuses()).toEqual(before);
      expect(loggedLines()).toEqual([]);
    });
  });

  describe("github_app_authorization", () => {
    it("revoked: every installation the GitHub user linked becomes unauthorized, in every workspace", async () => {
      await seedTwoWorkspaces();

      const outcome = await deliver(
        "github_app_authorization",
        githubAppAuthorizationRevokedPayload(GITHUB_USER, "octocat"),
      );

      expect(outcome).toEqual({ kind: "applied", changedRows: 2 });
      expect(await installationStatuses()).toEqual({
        [`${WORKSPACE}:${GITHUB_INSTALLATION}`]: "unauthorized",
        [`${OTHER_WORKSPACE}:${GITHUB_INSTALLATION}`]: "unauthorized",
        [`${WORKSPACE}:${OTHER_GITHUB_INSTALLATION}`]: "active",
      });
    });

    it("revoked for a user this control plane never linked applies to no row", async () => {
      await seedTwoWorkspaces();

      const outcome = await deliver(
        "github_app_authorization",
        githubAppAuthorizationRevokedPayload(99999, "stranger"),
      );

      expect(outcome).toEqual({ kind: "applied", changedRows: 0 });
      expect(Object.values(await installationStatuses())).toEqual(["active", "active", "active"]);
    });

    it("any other action changes nothing", async () => {
      await seedTwoWorkspaces();

      const outcome = await deliver("github_app_authorization", {
        ...githubAppAuthorizationRevokedPayload(GITHUB_USER, "octocat"),
        action: "granted",
      });

      expect(outcome).toEqual({ kind: "ignored" });
      expect(Object.values(await installationStatuses())).toEqual(["active", "active", "active"]);
    });

    it("revoked without a sender object is unreadable, not applied", async () => {
      await seedTwoWorkspaces();

      const outcome = await deliver("github_app_authorization", { action: "revoked" });

      expect(outcome).toEqual({ kind: "unreadable" });
      expect(Object.values(await installationStatuses())).toEqual(["active", "active", "active"]);
    });
  });

  describe("installation", () => {
    it("deleted: every workspace's link to the installation becomes deleted", async () => {
      await seedTwoWorkspaces();

      const outcome = await deliver(
        "installation",
        installationWebhookPayload("deleted", GITHUB_INSTALLATION, ACCOUNT, SENDER),
      );

      expect(outcome).toEqual({ kind: "applied", changedRows: 2 });
      expect(await installationStatuses()).toEqual({
        [`${WORKSPACE}:${GITHUB_INSTALLATION}`]: "deleted",
        [`${OTHER_WORKSPACE}:${GITHUB_INSTALLATION}`]: "deleted",
        [`${WORKSPACE}:${OTHER_GITHUB_INSTALLATION}`]: "active",
      });
    });

    it("suspend: the installation becomes suspended and the other one is untouched", async () => {
      await seedTwoWorkspaces();

      const outcome = await deliver(
        "installation",
        installationWebhookPayload("suspend", OTHER_GITHUB_INSTALLATION, ACCOUNT, SENDER),
      );

      expect(outcome).toEqual({ kind: "applied", changedRows: 1 });
      expect(await installationStatuses()).toEqual({
        [`${WORKSPACE}:${GITHUB_INSTALLATION}`]: "active",
        [`${OTHER_WORKSPACE}:${GITHUB_INSTALLATION}`]: "active",
        [`${WORKSPACE}:${OTHER_GITHUB_INSTALLATION}`]: "suspended",
      });
    });

    it("created: no installation row appears, because a webhook alone never adds one", async () => {
      await seedTwoWorkspaces();
      const before = await installationStatuses();

      const outcome = await deliver(
        "installation",
        installationWebhookPayload("created", 8888, ACCOUNT, SENDER),
      );

      expect(outcome).toEqual({ kind: "ignored" });
      expect(await countRows("github_installation")).toBe(3);
      expect(await installationStatuses()).toEqual(before);
      expect(await deliveryIds()).toHaveLength(1);
    });

    it("unsuspend: a suspended installation stays suspended until the verified user-link check restores it", async () => {
      await seedTwoWorkspaces();
      await setInstallationStatus(env.DB, GITHUB_INSTALLATION, "suspended", NOW);

      const outcome = await deliver(
        "installation",
        installationWebhookPayload("unsuspend", GITHUB_INSTALLATION, ACCOUNT, SENDER),
      );

      expect(outcome).toEqual({ kind: "ignored" });
      expect((await installationStatuses())[`${WORKSPACE}:${GITHUB_INSTALLATION}`]).toBe(
        "suspended",
      );
    });

    it("new_permissions_accepted: acknowledged, nothing changes", async () => {
      await seedTwoWorkspaces();
      const before = await installationStatuses();

      // The double's fixture types only the four actions it needs; the fifth
      // documented action is the same shape with a different `action`.
      const outcome = await deliver("installation", {
        ...installationWebhookPayload("created", GITHUB_INSTALLATION, ACCOUNT, SENDER),
        action: "new_permissions_accepted",
      });

      expect(outcome).toEqual({ kind: "ignored" });
      expect(await installationStatuses()).toEqual(before);
    });

    it("an action this build does not know is acknowledged, nothing changes", async () => {
      await seedTwoWorkspaces();
      const before = await installationStatuses();

      const outcome = await deliver("installation", {
        ...installationWebhookPayload("created", GITHUB_INSTALLATION, ACCOUNT, SENDER),
        action: "renamed",
      });

      expect(outcome).toEqual({ kind: "ignored" });
      expect(await installationStatuses()).toEqual(before);
    });

    it("a body with no action is unreadable", async () => {
      const { action: _dropped, ...withoutAction } = installationWebhookPayload(
        "deleted",
        GITHUB_INSTALLATION,
        ACCOUNT,
        SENDER,
      );

      expect(await deliver("installation", withoutAction)).toEqual({ kind: "unreadable" });
    });

    it("a body whose installation id is not a number is unreadable and changes nothing", async () => {
      await seedTwoWorkspaces();

      const outcome = await deliver("installation", {
        ...installationWebhookPayload("deleted", GITHUB_INSTALLATION, ACCOUNT, SENDER),
        installation: { id: String(GITHUB_INSTALLATION), account: ACCOUNT },
      });

      expect(outcome).toEqual({ kind: "unreadable" });
      expect(Object.values(await installationStatuses())).toEqual(["active", "active", "active"]);
    });
  });

  describe("installation_repositories", () => {
    it("removed: exactly the named repositories disconnect and the rest stay verified", async () => {
      const { mine, theirs, other } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A, REPO_B, REPO_C]);
      await linkRepositories(OTHER_WORKSPACE, theirs, [REPO_A, REPO_C]);
      // Held through the OTHER installation. Named in the removal below to
      // prove the disconnect is scoped to the installation the event is about.
      await linkRepositories(WORKSPACE, other, [REPO_D]);

      const outcome = await deliver(
        "installation_repositories",
        installationRepositoriesWebhookPayload(
          "removed",
          GITHUB_INSTALLATION,
          [
            { id: REPO_A.id, full_name: REPO_A.full_name },
            { id: REPO_B.id, full_name: REPO_B.full_name },
            { id: REPO_D.id, full_name: REPO_D.full_name },
          ],
          SENDER,
        ),
      );

      expect(outcome).toEqual({ kind: "applied", changedRows: 3 });
      expect(await repositoryStatuses()).toEqual({
        [`${WORKSPACE}:${REPO_A.id}`]: "disconnected",
        [`${WORKSPACE}:${REPO_B.id}`]: "disconnected",
        [`${WORKSPACE}:${REPO_C.id}`]: "verified",
        [`${WORKSPACE}:${REPO_D.id}`]: "verified",
        [`${OTHER_WORKSPACE}:${REPO_A.id}`]: "disconnected",
        [`${OTHER_WORKSPACE}:${REPO_C.id}`]: "verified",
      });
    });

    it("removed for an installation this control plane does not hold applies to no row", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);

      const outcome = await deliver(
        "installation_repositories",
        installationRepositoriesWebhookPayload(
          "removed",
          8888,
          [{ id: REPO_A.id, full_name: REPO_A.full_name }],
          SENDER,
        ),
      );

      expect(outcome).toEqual({ kind: "applied", changedRows: 0 });
      expect(await repositoryStatuses()).toEqual({ [`${WORKSPACE}:${REPO_A.id}`]: "verified" });
    });

    it("added: no repository row appears, because a webhook alone never adds one", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);

      const outcome = await deliver(
        "installation_repositories",
        installationRepositoriesWebhookPayload(
          "added",
          GITHUB_INSTALLATION,
          [{ id: REPO_B.id, full_name: REPO_B.full_name }],
          SENDER,
        ),
      );

      expect(outcome).toEqual({ kind: "ignored" });
      expect(await repositoryStatuses()).toEqual({ [`${WORKSPACE}:${REPO_A.id}`]: "verified" });
    });

    it("removed without an installation id is unreadable", async () => {
      const { installation: _dropped, ...withoutInstallation } =
        installationRepositoriesWebhookPayload(
          "removed",
          GITHUB_INSTALLATION,
          [{ id: REPO_A.id, full_name: REPO_A.full_name }],
          SENDER,
        );

      expect(await deliver("installation_repositories", withoutInstallation)).toEqual({
        kind: "unreadable",
      });
    });

    it("removed with a repositories_removed that is not a list is unreadable", async () => {
      const outcome = await deliver("installation_repositories", {
        ...installationRepositoriesWebhookPayload("removed", GITHUB_INSTALLATION, [], SENDER),
        repositories_removed: { id: REPO_A.id },
      });

      expect(outcome).toEqual({ kind: "unreadable" });
    });

    it("removed with an entry that carries no numeric id disconnects nothing", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A, REPO_B]);

      const outcome = await deliver("installation_repositories", {
        ...installationRepositoriesWebhookPayload("removed", GITHUB_INSTALLATION, [], SENDER),
        repositories_removed: [{ id: REPO_A.id, full_name: REPO_A.full_name }, "octocat/beta"],
      });

      expect(outcome).toEqual({ kind: "unreadable" });
      expect(Object.values(await repositoryStatuses())).toEqual(["verified", "verified"]);
    });
  });

  describe("pull_request", () => {
    const delivery = (action: string, pullRequest: Record<string, unknown>, extra = {}) => ({
      action,
      number: 7,
      pull_request: { number: 7, draft: true, merged: false, ...pullRequest },
      repository: REPO_A,
      sender: SENDER,
      ...extra,
    });

    async function sessionOwningPullRequest(sessionId = "ses_wh_pr", number = 7): Promise<void> {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A, REPO_B]);
      await insertSession(sessionId, WORKSPACE, REPO_A.id, TASK_BRANCH);
      await env.DB.prepare("UPDATE session_index SET pull_request_number = ? WHERE session_id = ?")
        .bind(number, sessionId)
        .run();
    }

    it.each([
      [
        "closed and merged",
        "closed",
        { merged: true, merge_commit_sha: "abc123" },
        "merged",
        "abc123",
      ],
      [
        "closed without merging",
        "closed",
        { merged: false, merge_commit_sha: "abc123" },
        "closed",
        null,
      ],
      ["marked ready", "ready_for_review", { draft: false }, "open", null],
      ["converted back to a draft", "converted_to_draft", { draft: true }, "draft", null],
      ["reopened as a draft", "reopened", { draft: true }, "draft", null],
      ["reopened ready", "reopened", { draft: false }, "open", null],
    ])("%s tells the session that opened it", async (_name, action, pullRequest, to, mergedSha) => {
      await sessionOwningPullRequest();

      const outcome = await deliver("pull_request", delivery(action, pullRequest));

      expect(outcome).toEqual({ kind: "applied", changedRows: 1 });
      expect(toldPullRequest).toEqual([
        {
          sessionId: "ses_wh_pr",
          change: { number: 7, to, actor: "octocat", mergedSha, changedAt: NOW },
        },
      ]);
      expect(loggedLines()).toEqual([]);
    });

    it("counts only the sessions it reached, and names an unknown sender as such", async () => {
      await sessionOwningPullRequest();
      unreachable = new Set(["ses_wh_pr"]);

      const outcome = await deliver(
        "pull_request",
        delivery("closed", { merged: false }, { sender: undefined }),
      );

      expect(outcome).toEqual({ kind: "applied", changedRows: 0 });
      expect(toldPullRequest[0]?.change.actor).toBe("unknown");
    });

    it("ignores a pull request no session opened, on this repository or another", async () => {
      await sessionOwningPullRequest();

      expect(
        await deliver("pull_request", { ...delivery("closed", { merged: true }), number: 8 }),
      ).toEqual({ kind: "ignored" });
      expect(
        await deliver("pull_request", {
          ...delivery("closed", { merged: true }),
          repository: REPO_B,
        }),
      ).toEqual({ kind: "ignored" });
      expect(toldPullRequest).toEqual([]);
    });

    it.each(["opened", "edited", "synchronize", "labeled"])(
      "ignores %s, which changes no state",
      async (action) => {
        await sessionOwningPullRequest();
        expect(await deliver("pull_request", delivery(action, {}))).toEqual({ kind: "ignored" });
        expect(toldPullRequest).toEqual([]);
      },
    );

    it.each([
      ["no pull_request object", { pull_request: "nope" }],
      ["no number", { number: "7" }],
      ["no repository id", { repository: { full_name: "octocat/alpha" } }],
    ])("with %s is unreadable", async (_name, change) => {
      expect(
        await deliver("pull_request", { ...delivery("closed", { merged: true }), ...change }),
      ).toEqual({ kind: "unreadable" });
    });

    it("with no action at all is ignored", async () => {
      const { action: _dropped, ...withoutAction } = delivery("closed", { merged: true });
      expect(await deliver("pull_request", withoutAction)).toEqual({ kind: "ignored" });
    });
  });

  describe("push", () => {
    it("to a task branch this control plane created is normal and logs nothing", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      await insertSession("ses_wh_1", WORKSPACE, REPO_A.id, TASK_BRANCH);

      const outcome = await deliver(
        "push",
        pushWebhookPayload(REPO_A, `refs/heads/${TASK_BRANCH}`, "a1b2c3", "d4e5f6", SENDER),
      );

      expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: false, lockedDown: 0 });
      expect(loggedLines()).toEqual([]);
    });

    it("to another workspace's task branch on the same repository is also normal", async () => {
      const { mine, theirs } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      await linkRepositories(OTHER_WORKSPACE, theirs, [REPO_A]);
      await insertSession("ses_wh_theirs", OTHER_WORKSPACE, REPO_A.id, "oncue/their-work-0a0a");

      const outcome = await deliver(
        "push",
        pushWebhookPayload(REPO_A, "refs/heads/oncue/their-work-0a0a", "a1b2c3", "d4e5f6", SENDER),
      );

      expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: false, lockedDown: 0 });
      expect(loggedLines()).toEqual([]);
    });

    it("by a person to any other ref is their own work: nothing is logged, locked down, or changed", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      await insertSession("ses_wh_1", WORKSPACE, REPO_A.id, TASK_BRANCH);
      const before = await repositoryStatuses();

      const outcome = await deliver(
        "push",
        pushWebhookPayload(REPO_A, "refs/heads/main", "a1b2c3", "d4e5f6", SENDER),
        { deliveryId: "push-main" },
      );

      expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: true, lockedDown: 0 });
      expect(loggedLines()).toEqual([]);
      expect(lockedDown).toEqual([]);
      expect(await repositoryStatuses()).toEqual(before);
      expect(await installationStatuses()).toEqual({
        [`${WORKSPACE}:${GITHUB_INSTALLATION}`]: "active",
        [`${OTHER_WORKSPACE}:${GITHUB_INSTALLATION}`]: "active",
        [`${WORKSPACE}:${OTHER_GITHUB_INSTALLATION}`]: "active",
      });
    });

    it("by the App's own bot outside every session branch locks down every active session of the repository and alerts", async () => {
      const { mine, theirs } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A, REPO_B]);
      await linkRepositories(OTHER_WORKSPACE, theirs, [REPO_A]);
      await insertSession("ses_wh_mine", WORKSPACE, REPO_A.id, TASK_BRANCH);
      await insertSession("ses_wh_theirs", OTHER_WORKSPACE, REPO_A.id, "oncue/their-work-0a0a");
      await insertSession("ses_wh_other_repo", WORKSPACE, REPO_B.id, "oncue/elsewhere-1b1b");
      await insertSession("ses_wh_archived", WORKSPACE, REPO_A.id, "oncue/old-2c2c");
      await env.DB.prepare("UPDATE session_index SET state = 'archived' WHERE session_id = ?")
        .bind("ses_wh_archived")
        .run();
      // Neither is the repository's to lock down: one is being erased, one never started.
      await insertSession("ses_wh_deleting", WORKSPACE, REPO_A.id, "oncue/gone-3d3d");
      await insertSession("ses_wh_creating", WORKSPACE, REPO_A.id, null);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE session_index SET state = 'deletion_pending' WHERE session_id = 'ses_wh_deleting'",
        ),
        env.DB.prepare(
          "UPDATE session_index SET state = 'creating' WHERE session_id = 'ses_wh_creating'",
        ),
      ]);
      unreachable = new Set(["ses_wh_theirs"]);

      const outcome = await deliver(
        "push",
        pushWebhookPayload(REPO_A, "refs/heads/main", "a1b2c3", "d4e5f6", APP_BOT),
        { deliveryId: "push-incident" },
      );

      // An archived session keeps its push policy and pushes again once
      // restored, so it is locked down with the active ones.
      expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: true, lockedDown: 2 });
      expect([...lockedDown].sort()).toEqual(["ses_wh_archived", "ses_wh_mine", "ses_wh_theirs"]);
      const lines = loggedLines();
      expect(lines).toEqual([
        {
          timestamp: NOW,
          severity: "error",
          service: "github-webhook",
          release: "test",
          environment: "local",
          operation: "github.incident.foreign_push",
          result: "locked down 2 of 3 sessions",
          deliveryId: "push-incident",
        },
      ]);
      const text = JSON.stringify(lines);
      for (const payloadText of ["refs/heads/main", "a1b2c3", "d4e5f6", SECRET]) {
        expect(text.includes(payloadText)).toBe(false);
      }
    });

    // No branch shape under `oncue/` is exempt: the App's bot pushing to a ref no
    // session owns is an incident, whether or not the ref was just created.
    it.each([
      [
        "creates an oncue/ branch WITH commits",
        "refs/heads/oncue/orphan-9f9f",
        { created: true, commits: [{ id: "d4e5f6" }] },
      ],
      [
        "only CREATES an oncue/ branch, with no commits",
        "refs/heads/oncue/orphan-9f9f",
        { created: true, commits: [] },
      ],
      ["creates a branch outside oncue/", "refs/heads/release", { created: true, commits: [] }],
      [
        "pushes to an existing oncue/ branch no session owns",
        "refs/heads/oncue/orphan-9f9f",
        { created: false, commits: [] },
      ],
      [
        "creates an oncue/ branch and says nothing about commits",
        "refs/heads/oncue/orphan-9f9f",
        { created: true },
      ],
    ])("by the App's bot that %s is still the incident", async (_name, ref, extra) => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      await insertSession("ses_wh_1", WORKSPACE, REPO_A.id, TASK_BRANCH);

      const outcome = await deliver("push", {
        ...pushWebhookPayload(REPO_A, ref, "a1b2c3", "d4e5f6", APP_BOT),
        ...extra,
      });

      expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: true, lockedDown: 1 });
    });

    /** A deletion receipt for a session that pushed to `ref`, closed `agoMs` before now. */
    async function insertReceipt(repositoryId: number, ref: string, agoMs: number): Promise<void> {
      const closedAt = new Date(Date.parse(NOW) - agoMs).toISOString();
      await env.DB.prepare(
        `INSERT INTO deletion_request (id, session_id, workspace_id, requested_by_user_id,
           requested_at, completed_at, outcome, released_ref_hash)
         VALUES (?, 'ses_wh_deleted', ?, 'user_wh', ?, ?, 'deleted', ?)`,
      )
        .bind(
          `del_wh_${agoMs}`,
          WORKSPACE,
          closedAt,
          closedAt,
          await releasedRefHash(repositoryId, ref),
        )
        .run();
    }

    it("by the App's bot to the branch of a session deleted a short while ago is that session's late push: nothing is locked down", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      await insertSession("ses_wh_1", WORKSPACE, REPO_A.id, TASK_BRANCH);
      // The deleted session's index row is gone; only its receipt remembers the branch.
      await insertReceipt(REPO_A.id, "refs/heads/oncue/deleted-4e4e", 60_000);

      const outcome = await deliver(
        "push",
        pushWebhookPayload(REPO_A, "refs/heads/oncue/deleted-4e4e", "a1b2c3", "d4e5f6", APP_BOT),
      );

      expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: false, lockedDown: 0 });
      expect(lockedDown).toEqual([]);
      expect(loggedLines()).toEqual([]);
    });

    it("reads a live session's row first: one that took a released branch over is its holder, and no receipt is asked", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      // A person's own branch, worked on directly by a session since deleted,
      // then taken over by another session.
      await insertReceipt(REPO_A.id, "refs/heads/feature/login", 60_000);
      await insertSession("ses_wh_took_over", WORKSPACE, REPO_A.id, "feature/login");
      const asked: string[] = [];
      const db = new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare") {
            return (sql: string) => {
              asked.push(sql);
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      let pushes = 0;
      const push = async () => {
        const rawBody = JSON.stringify(
          pushWebhookPayload(REPO_A, "refs/heads/feature/login", "a1b2c3", "d4e5f6", APP_BOT),
        );
        pushes += 1;
        return handleGitHubWebhook(
          { ...deps, db },
          {
            deliveryId: `push-live-${pushes}`,
            eventName: "push",
            signature: await signWebhook(SECRET, rawBody),
            rawBody,
          },
        );
      };

      expect(await push()).toEqual({
        kind: "audited",
        outsideSessionBranch: false,
        lockedDown: 0,
      });
      expect(asked.some((sql) => sql.includes("released_ref_hash"))).toBe(false);

      // The holder archived still holds it; once its row is gone the receipt answers.
      await env.DB.prepare("UPDATE session_index SET state = 'archived' WHERE session_id = ?")
        .bind("ses_wh_took_over")
        .run();
      expect(await push()).toMatchObject({ outsideSessionBranch: false });
      expect(asked.some((sql) => sql.includes("released_ref_hash"))).toBe(false);
      await env.DB.prepare("DELETE FROM session_index WHERE session_id = ?")
        .bind("ses_wh_took_over")
        .run();
      expect(await push()).toEqual({
        kind: "audited",
        outsideSessionBranch: false,
        lockedDown: 0,
      });
      expect(asked.some((sql) => sql.includes("released_ref_hash"))).toBe(true);
      expect(lockedDown).toEqual([]);
    });

    it("is the incident again once the receipt is older than the window, or names another repository", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A, REPO_B]);
      await insertSession("ses_wh_1", WORKSPACE, REPO_A.id, TASK_BRANCH);
      await insertReceipt(REPO_A.id, "refs/heads/oncue/long-gone-5f5f", RELEASED_REF_WINDOW_MS);
      await insertReceipt(REPO_B.id, "refs/heads/oncue/elsewhere-6a6a", 60_000);

      for (const ref of ["refs/heads/oncue/long-gone-5f5f", "refs/heads/oncue/elsewhere-6a6a"]) {
        const outcome = await deliver(
          "push",
          pushWebhookPayload(REPO_A, ref, "a1b2c3", "d4e5f6", APP_BOT),
          { deliveryId: `push-${ref}` },
        );
        expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: true, lockedDown: 1 });
      }
      expect(lockedDown).toEqual(["ses_wh_1", "ses_wh_1"]);
    });

    it("locks down an active session that has no branch yet: it is still the repository's", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      await insertSession("ses_wh_named", WORKSPACE, REPO_A.id, TASK_BRANCH);
      await insertSession("ses_wh_unnamed", WORKSPACE, REPO_A.id, null);

      const outcome = await deliver(
        "push",
        pushWebhookPayload(REPO_A, "refs/heads/oncue/orphan-9f9f", "a1b2c3", "d4e5f6", APP_BOT),
      );

      expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: true, lockedDown: 2 });
      expect([...lockedDown].sort()).toEqual(["ses_wh_named", "ses_wh_unnamed"]);
    });

    // A session working directly on an existing branch holds it from creation,
    // so its push is its own; the branch a session merely started from is not.
    it("by the App's bot to the existing branch a session works on is that session's own push", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      await insertSession("ses_wh_existing", WORKSPACE, REPO_A.id, "feature/login");
      await env.DB.prepare(
        "UPDATE session_index SET branch_mode = 'existing_branch', base_branch = 'feature/login' WHERE session_id = ?",
      )
        .bind("ses_wh_existing")
        .run();
      await insertSession("ses_wh_started", WORKSPACE, REPO_A.id, null);
      await env.DB.prepare(
        "UPDATE session_index SET branch_mode = 'new_branch', base_branch = 'release/1.4' WHERE session_id = ?",
      )
        .bind("ses_wh_started")
        .run();

      expect(
        await deliver(
          "push",
          pushWebhookPayload(REPO_A, "refs/heads/feature/login", "a1b2c3", "d4e5f6", APP_BOT),
        ),
      ).toEqual({ kind: "audited", outsideSessionBranch: false, lockedDown: 0 });
      expect(lockedDown).toEqual([]);

      expect(
        await deliver(
          "push",
          pushWebhookPayload(REPO_A, "refs/heads/release/1.4", "a1b2c3", "d4e5f6", APP_BOT),
          { deliveryId: "push-start-branch" },
        ),
      ).toEqual({ kind: "audited", outsideSessionBranch: true, lockedDown: 2 });
    });

    it("by the App's bot to a session branch is the bridge's own push: nothing happens", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      await insertSession("ses_wh_1", WORKSPACE, REPO_A.id, TASK_BRANCH);

      const outcome = await deliver(
        "push",
        pushWebhookPayload(REPO_A, `refs/heads/${TASK_BRANCH}`, "a1b2c3", "d4e5f6", APP_BOT),
      );

      expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: false, lockedDown: 0 });
      expect(lockedDown).toEqual([]);
      expect(loggedLines()).toEqual([]);
    });

    it.each([
      ["another App's bot", { id: 1, login: "dependabot[bot]", type: "Bot" }],
      [
        "a person who named themselves after the bot",
        { id: 2, login: `${APP_SLUG}[bot]`, type: "User" },
      ],
      ["no sender at all", undefined],
    ])("by %s is not the App's own push", async (_name, sender) => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      await insertSession("ses_wh_1", WORKSPACE, REPO_A.id, TASK_BRANCH);

      const outcome = await deliver("push", {
        ...pushWebhookPayload(REPO_A, "refs/heads/main", "a1b2c3", "d4e5f6", SENDER),
        sender,
      });

      expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: true, lockedDown: 0 });
      expect(lockedDown).toEqual([]);
    });

    it("says so when more sessions were active than one delivery handles", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      for (let index = 0; index <= MAX_INCIDENT_SESSIONS; index += 1) {
        await insertSession(`ses_wh_many_${index}`, WORKSPACE, REPO_A.id, `oncue/many-${index}`);
      }

      const outcome = await deliver(
        "push",
        pushWebhookPayload(REPO_A, "refs/heads/main", "a1b2c3", "d4e5f6", APP_BOT),
      );

      expect(outcome).toMatchObject({ lockedDown: MAX_INCIDENT_SESSIONS });
      expect(lockedDown).toHaveLength(MAX_INCIDENT_SESSIONS);
      expect(loggedLines()[0]?.result).toBe(
        `locked down ${MAX_INCIDENT_SESSIONS} of ${MAX_INCIDENT_SESSIONS} sessions; more were active than one delivery handles`,
      );
    });

    it("to a repository with no session at all is outside every session branch, and a person's is still theirs", async () => {
      const outcome = await deliver(
        "push",
        pushWebhookPayload(REPO_A, `refs/heads/${TASK_BRANCH}`, "a1b2c3", "d4e5f6", SENDER),
      );

      expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: true, lockedDown: 0 });
      expect(loggedLines()).toEqual([]);
    });

    it("ignores a session on the same repository that has no task branch", async () => {
      const { mine } = await seedTwoWorkspaces();
      await linkRepositories(WORKSPACE, mine, [REPO_A]);
      await env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, task_id, state, sandbox_generation, created_at, updated_at)
         VALUES ('ses_wh_no_branch', ?, NULL, 'active', 1, ?, ?)`,
      )
        .bind(WORKSPACE, NOW, NOW)
        .run();

      const outcome = await deliver(
        "push",
        pushWebhookPayload(REPO_A, "refs/heads/main", "a1b2c3", "d4e5f6", SENDER),
      );

      expect(outcome).toEqual({ kind: "audited", outsideSessionBranch: true, lockedDown: 0 });
    });

    it("without a ref is unreadable", async () => {
      const { ref: _dropped, ...withoutRef } = pushWebhookPayload(
        REPO_A,
        "refs/heads/main",
        "a1b2c3",
        "d4e5f6",
        SENDER,
      );

      expect(await deliver("push", withoutRef)).toEqual({ kind: "unreadable" });
    });

    it("without a repository id is unreadable", async () => {
      const outcome = await deliver("push", {
        ...pushWebhookPayload(REPO_A, "refs/heads/main", "a1b2c3", "d4e5f6", SENDER),
        repository: { full_name: REPO_A.full_name },
      });

      expect(outcome).toEqual({ kind: "unreadable" });
    });
  });
});

/**
 * GitHub webhook verification and dispatch (record 07).
 *
 * A webhook alone never adds or restores an installation's access: the secret
 * proves GitHub sent it, not which OnCue user may hold the installation. Every
 * arm either disables something or does nothing; only the verified user-link
 * flow in `install.ts` adds access.
 *
 * Order is fixed: signature, delivery ledger, parse, dispatch. The ledger
 * comes after the signature so an unverified request cannot pre-record a real
 * delivery id and get GitHub's genuine attempt discarded as a replay.
 *
 * Nothing here logs the secret or payload text; `result` strings are fixed
 * literals.
 */

import { isPlainObject, readStringField } from "../broker/providers/adapter";
import { wasReleasedRef } from "../deletion/released-refs";
import { safeJsonParse } from "../json";
import type { LogFields } from "../log";
import {
  disconnectRepositoriesByGitHubIds,
  type InstallationStatus,
  listInstallationsByGitHubId,
  recordDelivery,
  setInstallationStatus,
  setInstallationStatusForGitHubUser,
} from "./store";

/** GitHub's `X-Hub-Signature-256` header shape: this prefix, then lowercase hex. */
export const SIGNATURE_PREFIX = "sha256=";

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// No `===` and no early return: either would leak, through timing, how long a
// prefix of the guess was right. The length check leaks only the public
// digest length.
function constantTimeEqual(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * HMAC-SHA256 over the exact bytes GitHub sent. `rawBody` must be the request
 * text read once and never re-serialised, or the digest will not match. A
 * missing header, a wrong prefix, and a wrong digest all answer false alike.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (header === null || !header.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const expected = await hmacSha256Hex(secret, rawBody);
  return constantTimeEqual(expected, header.slice(SIGNATURE_PREFIX.length));
}

export interface WebhookDeps {
  readonly db: D1Database;
  readonly webhookSecret: string;
  /** ISO timestamp, injected so a test owns the clock. */
  readonly now: () => string;
  readonly log: (fields: LogFields) => void;
  readonly release: string;
  readonly environment: string;
  /** The App's slug. Its installation pushes as `<slug>[bot]`, which is how the push arm knows a push is OnCue's own. */
  readonly appSlug: string;
  /** Tells one session's object to lock down (`/internal/incident`). Resolves false when the object could not be reached. */
  readonly lockDownSession: (sessionId: string) => Promise<boolean>;
  /** Tells the session that owns a pull request what GitHub now says of it (`/internal/pull-request-state`). Resolves false when the object could not be reached. */
  readonly tellPullRequestState: (
    sessionId: string,
    change: PullRequestStateChange,
  ) => Promise<boolean>;
}

/** What the `pull_request` arm reads off a delivery. `actor` is a GitHub login: untrusted text, passed on as such. */
export interface PullRequestStateChange {
  readonly number: number;
  readonly to: "draft" | "open" | "closed" | "merged";
  readonly actor: string;
  readonly mergedSha: string | null;
  readonly changedAt: string;
}

/** The most sessions one delivery will lock down. A repository with more active sessions than this is logged as such; the bound keeps one webhook's work finite. */
export const MAX_INCIDENT_SESSIONS = 25;

/** The four things the route reads off the request before calling in. */
export interface WebhookInput {
  /** `X-GitHub-Delivery`. */
  readonly deliveryId: string;
  /** `X-GitHub-Event`. */
  readonly eventName: string;
  /** `X-Hub-Signature-256`, or null when the header is absent. */
  readonly signature: string | null;
  /** The request text, read once, never re-serialised. */
  readonly rawBody: string;
}

/**
 * Every way a delivery can end; the route maps kinds to statuses with a total
 * `Record`. `applied` with zero rows means the transition ran and matched
 * nothing. `audited` is the push arm's answer and changes no row.
 */
export type WebhookOutcome =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "replayed" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "ignored" }
  | { readonly kind: "applied"; readonly changedRows: number }
  | {
      readonly kind: "audited";
      readonly outsideSessionBranch: boolean;
      /** Sessions locked down because the push was the App's own. Zero for anyone else's push. */
      readonly lockedDown: number;
    };

export type WebhookOutcomeKind = WebhookOutcome["kind"];

const SERVICE = "github-webhook";

// A valid signature over an unreadable body means GitHub sent a shape this
// build does not know. Acknowledge it so GitHub stops retrying, and log only
// the delivery id.
function unreadable(deps: WebhookDeps, deliveryId: string): WebhookOutcome {
  deps.log({
    timestamp: deps.now(),
    severity: "warn",
    service: SERVICE,
    release: deps.release,
    environment: deps.environment,
    operation: "github.webhook",
    result: "payload not readable",
    deliveryId,
  });
  return { kind: "unreadable" };
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** `payload.<objectKey>.<numberKey>`, or null when either level is not what GitHub documents. */
function readNestedNumber(
  source: Record<string, unknown>,
  objectKey: string,
  numberKey: string,
): number | null {
  const nested = source[objectKey];
  return isPlainObject(nested) ? readNumber(nested[numberKey]) : null;
}

type EventHandler = (
  deps: WebhookDeps,
  payload: Record<string, unknown>,
  deliveryId: string,
) => Promise<WebhookOutcome>;

/**
 * `github_app_authorization` `revoked`: disables every installation row the
 * revoking user's token vouched for, matched on the `github_user_id` that
 * `install.ts` recorded from `GET /user`.
 */
const onAppAuthorization: EventHandler = async (deps, payload, deliveryId) => {
  if (readStringField(payload, "action") !== "revoked") {
    // A webhook alone never adds an installation to a workspace.
    return { kind: "ignored" };
  }
  const githubUserId = readNestedNumber(payload, "sender", "id");
  if (githubUserId === null) {
    return unreadable(deps, deliveryId);
  }
  const changedRows = await setInstallationStatusForGitHubUser(
    deps.db,
    githubUserId,
    "unauthorized",
    deps.now(),
  );
  return { kind: "applied", changedRows };
};

const INSTALLATION_ACTIONS = [
  "created",
  "deleted",
  "suspend",
  "unsuspend",
  "new_permissions_accepted",
] as const;
type InstallationAction = (typeof INSTALLATION_ACTIONS)[number];

function isInstallationAction(action: string): action is InstallationAction {
  return (INSTALLATION_ACTIONS as readonly string[]).includes(action);
}

// A total table, so a new action is a compile error; `null` is a deliberate
// no-op.
const INSTALLATION_TRANSITION: Record<InstallationAction, InstallationStatus | null> = {
  // A `created` webhook must not add an installation: only `install.ts`, holding
  // a user token that sees it in `GET /user/installations`, may write a row.
  created: null,
  deleted: "deleted",
  suspend: "suspended",
  // Restoring access is the same authority as adding it, so a webhook never does
  // it: the row stays suspended until the user reconnects through `completeInstall`.
  unsuspend: null,
  // Record 07: accepting new permissions never expands a workspace, and no
  // metadata from this event is cached.
  new_permissions_accepted: null,
};

const onInstallation: EventHandler = async (deps, payload, deliveryId) => {
  const action = readStringField(payload, "action");
  const githubInstallationId = readNestedNumber(payload, "installation", "id");
  if (action === null || githubInstallationId === null) {
    return unreadable(deps, deliveryId);
  }
  if (!isInstallationAction(action)) {
    return { kind: "ignored" };
  }
  const status = INSTALLATION_TRANSITION[action];
  if (status === null) {
    return { kind: "ignored" };
  }
  const changedRows = await setInstallationStatus(
    deps.db,
    githubInstallationId,
    status,
    deps.now(),
  );
  return { kind: "applied", changedRows };
};

function repositoryId(entry: unknown): number | null {
  return isPlainObject(entry) ? readNumber(entry.id) : null;
}

function isNumber(value: number | null): value is number {
  return value !== null;
}

/**
 * `installation_repositories` `removed`: disconnects exactly the named
 * repositories on every workspace's link to the installation, leaving the
 * others authorized.
 */
const onInstallationRepositories: EventHandler = async (deps, payload, deliveryId) => {
  if (readStringField(payload, "action") !== "removed") {
    // `added` changes nothing: a webhook alone never adds access the verified
    // user-link flow has not confirmed.
    return { kind: "ignored" };
  }
  const githubInstallationId = readNestedNumber(payload, "installation", "id");
  const removed = payload.repositories_removed;
  if (githubInstallationId === null || !Array.isArray(removed)) {
    return unreadable(deps, deliveryId);
  }
  const removedIds = removed.map(repositoryId);
  if (!removedIds.every(isNumber)) {
    return unreadable(deps, deliveryId);
  }
  const installations = await listInstallationsByGitHubId(deps.db, githubInstallationId);
  let changedRows = 0;
  for (const installation of installations) {
    changedRows += await disconnectRepositoriesByGitHubIds(
      deps.db,
      installation.installationRowId,
      removedIds,
      deps.now(),
    );
  }
  return { kind: "applied", changedRows };
};

/**
 * Every task branch created for the repository, as full refs, across all
 * workspaces. Sessions without a task branch are excluded.
 */
async function listTaskBranchRefs(
  db: D1Database,
  githubRepositoryId: number,
): Promise<readonly string[]> {
  const result = await db
    .prepare(
      `SELECT si.task_branch AS task_branch
         FROM session_index AS si
         JOIN repository_connection AS rc
           ON rc.repository_connection_id = si.repository_connection_id
        WHERE rc.github_repository_id = ? AND si.task_branch IS NOT NULL`,
    )
    .bind(githubRepositoryId)
    .all<{ readonly task_branch: string }>();
  return result.results.map((row) => `refs/heads/${row.task_branch}`);
}

/**
 * The repository's sessions that can still push, newest first, for the
 * incident rule: active ones, and archived ones, whose archive checkpoint may
 * still be pushing and which push again once restored. A token is scoped to a
 * repository, not a session, so a foreign push cannot be pinned on one
 * session.
 */
async function listLiveSessionIds(
  db: D1Database,
  githubRepositoryId: number,
): Promise<readonly string[]> {
  const result = await db
    .prepare(
      `SELECT si.session_id AS session_id
         FROM session_index AS si
         JOIN repository_connection AS rc
           ON rc.repository_connection_id = si.repository_connection_id
        WHERE rc.github_repository_id = ? AND si.state IN ('active', 'archived')
        ORDER BY si.created_at DESC
        LIMIT ?`,
    )
    .bind(githubRepositoryId, MAX_INCIDENT_SESSIONS + 1)
    .all<{ readonly session_id: string }>();
  return result.results.map((row) => row.session_id);
}

/**
 * `push`. Record 07's incident is a push from the App's own installation
 * (sender `<slug>[bot]`) to a ref other than a session branch, meaning the
 * bridge's exact-ref check failed or a token escaped. That locks down every
 * active or archived session of the repository (`/internal/incident`) and
 * logs an `error` with operation `github.incident.foreign_push`. Anyone
 * else's push is only audited, and so is a push to the branch of a session
 * deleted within the last few days. The ref is attacker-chosen text and is
 * not logged.
 */
const onPush: EventHandler = async (deps, payload, deliveryId) => {
  const ref = readStringField(payload, "ref");
  const githubRepositoryId = readNestedNumber(payload, "repository", "id");
  if (ref === null || githubRepositoryId === null) {
    return unreadable(deps, deliveryId);
  }
  const sessionRefs = await listTaskBranchRefs(deps.db, githubRepositoryId);
  const outsideSessionBranch = !sessionRefs.includes(ref);
  const sender = payload.sender;
  const byTheApp =
    isPlainObject(sender) && sender.type === "Bot" && sender.login === `${deps.appSlug}[bot]`;
  if (!outsideSessionBranch || !byTheApp) {
    return { kind: "audited", outsideSessionBranch, lockedDown: 0 };
  }
  if (await wasReleasedRef(deps.db, githubRepositoryId, ref, new Date(deps.now()))) {
    // The branch of a session deleted a short while ago: its index row is
    // gone and the branch stays on GitHub, so this is that session's own push
    // delivered late, not a push outside every session.
    return { kind: "audited", outsideSessionBranch: false, lockedDown: 0 };
  }
  const found = await listLiveSessionIds(deps.db, githubRepositoryId);
  const sessionIds = found.slice(0, MAX_INCIDENT_SESSIONS);
  let lockedDown = 0;
  for (const sessionId of sessionIds) {
    if (await deps.lockDownSession(sessionId)) {
      lockedDown += 1;
    }
  }
  deps.log({
    timestamp: deps.now(),
    severity: "error",
    service: SERVICE,
    release: deps.release,
    environment: deps.environment,
    operation: "github.incident.foreign_push",
    result: `locked down ${lockedDown} of ${sessionIds.length} sessions${
      found.length > MAX_INCIDENT_SESSIONS ? "; more were active than one delivery handles" : ""
    }`,
    deliveryId,
  });
  return { kind: "audited", outsideSessionBranch, lockedDown };
};

/** The state after each action followed here; every other action is ignored. */
function pullRequestStateAfter(
  action: string | null,
  pullRequest: Record<string, unknown>,
): PullRequestStateChange["to"] | null {
  switch (action) {
    case "closed":
      return pullRequest.merged === true ? "merged" : "closed";
    case "reopened":
      return pullRequest.draft === true ? "draft" : "open";
    case "ready_for_review":
      return "open";
    case "converted_to_draft":
      return "draft";
    default:
      return null;
  }
}

/**
 * `pull_request`. OnCue opens drafts and never marks them ready, closes, or
 * merges them, so this arm tells the owning session about a person's act on
 * GitHub. Pull requests no session opened are ignored.
 */
const onPullRequest: EventHandler = async (deps, payload, deliveryId) => {
  const pullRequest = payload.pull_request;
  const number = readNumber(payload.number);
  const githubRepositoryId = readNestedNumber(payload, "repository", "id");
  if (!isPlainObject(pullRequest) || number === null || githubRepositoryId === null) {
    return unreadable(deps, deliveryId);
  }
  const to = pullRequestStateAfter(readStringField(payload, "action"), pullRequest);
  if (to === null) {
    return { kind: "ignored" };
  }
  const sender = payload.sender;
  const owners = await deps.db
    .prepare(
      `SELECT si.session_id AS session_id
         FROM session_index AS si
         JOIN repository_connection AS rc
           ON rc.repository_connection_id = si.repository_connection_id
        WHERE rc.github_repository_id = ? AND si.pull_request_number = ?`,
    )
    .bind(githubRepositoryId, number)
    .all<{ readonly session_id: string }>();
  let told = 0;
  for (const owner of owners.results) {
    const reached = await deps.tellPullRequestState(owner.session_id, {
      number,
      to,
      actor: (isPlainObject(sender) ? readStringField(sender, "login") : null) ?? "unknown",
      mergedSha: to === "merged" ? readStringField(pullRequest, "merge_commit_sha") : null,
      changedAt: deps.now(),
    });
    if (reached) {
      told += 1;
    }
  }
  return owners.results.length === 0 ? { kind: "ignored" } : { kind: "applied", changedRows: told };
};

const HANDLED_EVENTS = [
  "github_app_authorization",
  "installation",
  "installation_repositories",
  "push",
  "pull_request",
] as const;
export type HandledEvent = (typeof HANDLED_EVENTS)[number];

function isHandledEvent(eventName: string): eventName is HandledEvent {
  return (HANDLED_EVENTS as readonly string[]).includes(eventName);
}

// Total over the union, so a new subscribed event fails to compile until it
// has a handler.
const EVENT_HANDLERS: Record<HandledEvent, EventHandler> = {
  github_app_authorization: onAppAuthorization,
  installation: onInstallation,
  installation_repositories: onInstallationRepositories,
  push: onPush,
  pull_request: onPullRequest,
};

export async function handleGitHubWebhook(
  deps: WebhookDeps,
  input: WebhookInput,
): Promise<WebhookOutcome> {
  // Before the ledger: an unverified request must not record a delivery id.
  if (!(await verifyWebhookSignature(deps.webhookSecret, input.rawBody, input.signature))) {
    return { kind: "unauthorized" };
  }
  const delivery = await recordDelivery(deps.db, input.deliveryId, input.eventName, deps.now());
  if (delivery === "replay") {
    return { kind: "replayed" };
  }
  const parsed = safeJsonParse(input.rawBody);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return unreadable(deps, input.deliveryId);
  }
  if (!isHandledEvent(input.eventName)) {
    // GitHub can deliver events outside this build's subscription. Acknowledge so
    // it stops retrying.
    return { kind: "ignored" };
  }
  return EVENT_HANDLERS[input.eventName](deps, parsed.value, input.deliveryId);
}

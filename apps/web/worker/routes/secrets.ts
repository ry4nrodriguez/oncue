/**
 * Development secrets for one repository (record 08):
 *
 *   GET    /api/repositories/:connectionId/secrets          the saved names
 *   PUT    /api/repositories/:connectionId/secrets/:name    save or replace a value
 *   DELETE /api/repositories/:connectionId/secrets/:name    remove it
 *   GET    /api/repositories/:connectionId/secret-requests  what the project file asks for
 *
 * No route returns a value: the store has no field to hold one. A value
 * arrives once, in a request body and never a URL, and no response echoes the
 * request. Another workspace's repository connection reads as nonexistent.
 */

import { actorWorkspaceId } from "../auth/actor";
import type { AllowlistCache } from "../auth/allowlist";
import { authorizeActor } from "../auth/authorize";
import { isPlainObject } from "../broker/providers/adapter";
import { isWorkableBranchName } from "../github/branches";
import { VERIFY_REFUSAL_STATUS, verifyInstallation } from "../github/install";
import { resolveRepository } from "../github/repositories";
import { safeJsonParse } from "../json";
import { log } from "../log";
import { planDisclosure } from "../secrets/declaration";
import { readRepositoryDeclaration } from "../secrets/disclosure";
import {
  deleteDevelopmentSecret,
  listDevelopmentSecrets,
  readLastDisclosedNames,
  type SecretScope,
  saveDevelopmentSecret,
  savedSecretNames,
} from "../secrets/store";
import { cachedCredentialKeyring } from "./credential-keyring";
import { readGitHubConfig } from "./repositories";

export type SecretsRoute =
  | { readonly kind: "list"; readonly repositoryConnectionId: string }
  | { readonly kind: "requests"; readonly repositoryConnectionId: string }
  | { readonly kind: "save"; readonly repositoryConnectionId: string; readonly name: string }
  | { readonly kind: "delete"; readonly repositoryConnectionId: string; readonly name: string };

const LIST_PATH = /^\/api\/repositories\/([^/]+)\/(secrets|secret-requests)$/;
const ITEM_PATH = /^\/api\/repositories\/([^/]+)\/secrets\/([^/]+)$/;

/** A path segment as text, or null for a percent-escape that is not one: a bad URL is no route, not a 500. */
function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** The route a path and method name, or null. The name is checked by the store, not here. */
export function matchSecretsRoute(pathname: string, method: string): SecretsRoute | null {
  const list = LIST_PATH.exec(pathname);
  if (list !== null) {
    const repositoryConnectionId = segment(list[1] as string);
    return method === "GET" && repositoryConnectionId !== null
      ? { kind: list[2] === "secrets" ? "list" : "requests", repositoryConnectionId }
      : null;
  }
  const item = ITEM_PATH.exec(pathname);
  if (item === null || (method !== "PUT" && method !== "DELETE")) {
    return null;
  }
  const repositoryConnectionId = segment(item[1] as string);
  const name = segment(item[2] as string);
  if (repositoryConnectionId === null || name === null) {
    return null;
  }
  return { kind: method === "PUT" ? "save" : "delete", repositoryConnectionId, name };
}

// One line per failed declaration read: the category only, never the
// repository name, a token, or GitHub's body.
function logUnread(env: Env, result: string, errorCategory: string): void {
  log({
    timestamp: new Date().toISOString(),
    severity: "warn",
    service: "web-worker",
    release: env.ONCUE_RELEASE,
    environment: env.ONCUE_ENV,
    operation: "api.secret_requests.read",
    result,
    errorCategory,
  });
}

// The same code and status the create route answers with, so the composer
// says "Reconnect GitHub".
function reconnectGitHub(status: number, reason: string): Response {
  return Response.json({ error: "github_reverification_required", reason }, { status });
}

/**
 * What the disclosure card shows before launch (record 08): the commit read,
 * and each required and optional name, marked saved and new. Names only. An
 * unreadable file is reported as such, never as "asks for nothing". The file
 * is read at the tip of `branch`, the branch the session would start from,
 * else the default branch.
 *
 * The installation is verified first, as the create route does, and a mint
 * GitHub answers 404 means the installation is gone: both answer
 * `github_reverification_required`.
 */
async function secretRequests(
  env: Env,
  scope: SecretScope,
  branch: string | null,
): Promise<Response> {
  const resolved = await resolveRepository(env.DB, scope.workspaceId, {
    repositoryConnectionId: scope.repositoryConnectionId,
  });
  if (resolved.kind === "refused" && resolved.reason === "not_connected") {
    // A webhook or earlier verification already marked the installation inactive.
    logUnread(env, "reverification_required", "repository_not_connected");
    return reconnectGitHub(409, resolved.reason);
  }
  if (resolved.kind !== "resolved") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const config = await readGitHubConfig(env);
  if (config.kind === "unconfigured") {
    return Response.json({ error: "github_unconfigured" }, { status: 503 });
  }
  const repository = resolved.repository;
  const verified = await verifyInstallation(
    config.deps,
    scope.workspaceId,
    repository.installationRowId,
  );
  if (verified.kind === "refused") {
    logUnread(env, "reverification_required", `installation_${verified.reason}`);
    return reconnectGitHub(VERIFY_REFUSAL_STATUS[verified.reason], verified.reason);
  }
  const read = await readRepositoryDeclaration(
    config.appDeps,
    {
      installationId: repository.githubInstallationId,
      repositoryId: repository.githubRepositoryId,
      fullName: repository.fullName,
      branch: branch ?? repository.defaultBranch,
    },
    null,
  );
  if (read.kind === "failed" && read.reason === "base_branch_missing" && branch !== null) {
    // The chosen branch is gone: the composer says so rather than "unreadable".
    return Response.json({ error: "branch_refused", reason: "missing" }, { status: 409 });
  }
  if (read.kind === "failed") {
    if (read.reason === "installation_missing") {
      logUnread(env, "reverification_required", read.errorCategory);
      return reconnectGitHub(VERIFY_REFUSAL_STATUS.reverification_required, read.reason);
    }
    logUnread(env, "unreadable", read.errorCategory);
    return Response.json({ error: "unreadable", reason: read.reason }, { status: 502 });
  }
  const { baseSha, declaration } = read;
  if (declaration.kind === "unreadable") {
    logUnread(env, "unreadable", `declaration_${declaration.category}`);
    return Response.json({ error: "unreadable", reason: declaration.category }, { status: 502 });
  }
  if (declaration.kind === "invalid") {
    return Response.json(
      { baseSha, state: "invalid", line: declaration.line, reason: declaration.reason },
      { status: 200 },
    );
  }
  if (declaration.kind === "none") {
    return Response.json({ baseSha, state: "none" }, { status: 200 });
  }
  const disclosure = planDisclosure(
    declaration.secrets,
    await savedSecretNames(env.DB, scope),
    await readLastDisclosedNames(env.DB, scope),
  );
  return Response.json({ baseSha, state: "declared", ...disclosure }, { status: 200 });
}

function invalid(reason: string): Response {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

export async function handleSecretsRequest(
  route: SecretsRoute,
  request: Request,
  env: Env,
  allowlistCache: AllowlistCache,
): Promise<Response> {
  const outcome = await authorizeActor(env, request, allowlistCache);
  if (outcome.kind === "denied") {
    return Response.json(
      { error: outcome.reason },
      { status: outcome.reason === "unauthenticated" ? 401 : 403 },
    );
  }
  const scope = {
    workspaceId: actorWorkspaceId(outcome.actor),
    repositoryConnectionId: route.repositoryConnectionId,
  };

  if (route.kind === "list") {
    return Response.json({ secrets: await listDevelopmentSecrets(env.DB, scope) }, { status: 200 });
  }

  if (route.kind === "requests") {
    const branch = new URL(request.url).searchParams.get("branch");
    if (branch !== null && !isWorkableBranchName(branch)) {
      return invalid("branch");
    }
    return secretRequests(env, scope, branch);
  }

  if (route.kind === "delete") {
    const removed = await deleteDevelopmentSecret(env.DB, scope, route.name);
    return removed
      ? Response.json({ deleted: true }, { status: 200 })
      : Response.json({ error: "not_found" }, { status: 404 });
  }

  const parsed = safeJsonParse(await request.text());
  const value = parsed.ok && isPlainObject(parsed.value) ? parsed.value.value : undefined;
  if (typeof value !== "string") {
    return invalid("value_missing");
  }
  const keyring = await cachedCredentialKeyring(env.ONCUE_BROKER_KEYRING);
  if (keyring.kind !== "ok") {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
  const result = await saveDevelopmentSecret(
    env.DB,
    {
      keyring: keyring.keyring,
      now: new Date().toISOString(),
      newSecretId: () => `dsc_${crypto.randomUUID()}`,
    },
    scope,
    route.name,
    value,
  );
  if (result.kind === "saved") {
    return Response.json({ secret: result.secret }, { status: 200 });
  }
  return result.reason === "unknown_repository"
    ? Response.json({ error: "not_found" }, { status: 404 })
    : invalid(result.reason);
}

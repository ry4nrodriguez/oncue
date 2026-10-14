// The shell half of `dispatch.ts`: what the bridge is owed, sent one frame at a
// time with each grant minted at send time.

import { buildCommandFrame, buildGrantFrame, type ModelGrantCatalogEntry } from "@oncue/bridge";
import {
  buildEvent,
  DEFAULT_RUNTIME_ID,
  type EffortLevel,
  isTerminal,
  type ProtocolCommand,
  type ProtocolEvent,
  type RunState,
} from "@oncue/protocol";
import { ARTIFACT_LIMITS } from "../../artifacts/policy";
import { PROVIDER_IDS } from "../../broker/providers/adapter";
import { catalogFor, findModel } from "../../broker/providers/catalog";
import { mintToken, TOKEN_TTL_MS } from "../../broker/tokens";
import {
  type GitHubAppDeps,
  mintInstallationToken,
  revokeInstallationToken,
} from "../../github/app";
import { log } from "../../log";
import { readGitHubConfig } from "../../routes/repositories";
import { commandAttachments, mintAttachmentFetches } from "../attachment-access";
import { cloneBranch, grantTaskBranch } from "../branch-naming";
import {
  chargedRunId,
  type DispatchInput,
  type DispatchPlan,
  type DispatchRow,
  type DispatchStateView,
  GIT_GRANT_TIMEOUT_MS,
  type HeldMessage,
  type OutboundFrame,
  PUSH_GRANT_TIMEOUT_MS,
  planDispatch,
  type SessionRepository,
} from "../dispatch";
import { type GrantRevocation, grantDeliverable } from "../lifecycle";
import { GIT_TOKEN_LIFETIME_MS } from "./constants";
import { cachedTokenKeyring, mintBootstrapCredential, sha256Hex } from "./credentials";
import {
  confirmExistingBranch,
  type ExistingBranchVerdict,
  readExistingBranch,
  WITHHELD_MESSAGE,
} from "./existing-branch";
import type { SessionHost } from "./host";
import {
  pushedTaskBranch,
  readBaseBranch,
  readDurableHeadSha,
  readRestoreArtifactId,
  settlePublish,
} from "./store-git";
import { readAttachment, readStopRow } from "./store-lifecycle";
import { applyDispatchRow, readRunModel, readRunState, readRuntimeId } from "./store-session";
import type { SessionRow } from "./types";
import { grantModel } from "./wire";

export function readDispatchState(host: SessionHost, session: SessionRow): DispatchStateView {
  const rows = [
    ...host.objectCtx.storage.sql.exec<{
      intent_id: string;
      generation: number;
      state: string;
      payload_json: string;
      attempts: number;
      created_at: string;
    }>(
      "SELECT intent_id, generation, state, payload_json, attempts, created_at FROM bridge_dispatch WHERE generation = ? ORDER BY created_at ASC, rowid ASC",
      session.sandboxGeneration,
    ),
  ].map(
    (row): DispatchRow => ({
      intentId: row.intent_id,
      generation: row.generation,
      kind: JSON.parse(row.payload_json) as DispatchRow["kind"],
      state: row.state as DispatchRow["state"],
      attempts: row.attempts,
      createdAt: row.created_at,
    }),
  );
  const held = [
    ...host.objectCtx.storage.sql.exec<{
      message_id: string;
      command_id: string;
      issued_by_user_id: string;
      text: string;
      attachments_json: string;
      held_at: string;
      skip_required_checks: number;
      named_effort: number;
      effort: string | null;
    }>(
      `SELECT q.message_id, q.command_id, q.issued_by_user_id, q.text, q.attachments_json, q.held_at,
                EXISTS(SELECT 1 FROM check_skip_request AS s WHERE s.message_id = q.message_id) AS skip_required_checks,
                (e.message_id IS NOT NULL) AS named_effort, e.effort
         FROM queued_message AS q LEFT JOIN queued_message_effort AS e ON e.message_id = q.message_id
         WHERE q.released_at IS NULL ORDER BY q.held_at ASC, q.rowid ASC`,
    ),
  ].map(
    (row): HeldMessage => ({
      messageId: row.message_id,
      commandId: row.command_id,
      issuedByUserId: row.issued_by_user_id,
      text: row.text,
      attachments: JSON.parse(row.attachments_json) as unknown[],
      heldAt: row.held_at,
      skipRequiredChecks: row.skip_required_checks === 1,
      // The column came from the protocol's own picklist on the way in.
      ...(row.named_effort === 1 ? { effort: row.effort as EffortLevel | null } : {}),
    }),
  );
  const repositoryRows = [
    ...host.objectCtx.storage.sql.exec<{
      installation_id: number;
      repository_id: number;
      full_name: string;
      clone_url: string;
      task_branch: string | null;
      base_sha: string;
      git_grant_revoked: number;
    }>(
      "SELECT installation_id, repository_id, full_name, clone_url, task_branch, base_sha, git_grant_revoked FROM session_repository LIMIT 1",
    ),
  ];
  const repositoryRow = repositoryRows[0];
  const repository: SessionRepository | null =
    repositoryRow === undefined
      ? null
      : {
          kind: "git_grant",
          installationId: repositoryRow.installation_id,
          repositoryId: repositoryRow.repository_id,
          fullName: repositoryRow.full_name,
          cloneUrl: repositoryRow.clone_url,
          // Before the first push names the task branch, the sandbox clones the base
          // branch at the base commit.
          branch: cloneBranch(
            pushedTaskBranch(host.objectCtx.storage.sql, repositoryRow.task_branch),
            readBaseBranch(host.objectCtx.storage.sql),
          ),
          taskBranch: repositoryRow.task_branch,
          baseSha: repositoryRow.base_sha,
          headSha: readDurableHeadSha(host.objectCtx.storage.sql, repositoryRow.base_sha),
          restoreArtifactId: readRestoreArtifactId(host.objectCtx.storage.sql),
          gitGrantRevoked: repositoryRow.git_grant_revoked === 1,
        };
  return {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    generation: session.sandboxGeneration,
    runtimeReady:
      host.objectCtx.storage.sql
        .exec<{ ready: number }>(
          "SELECT EXISTS(SELECT 1 FROM event WHERE event_type = 'runtime.ready' AND sandbox_generation = ?) AS ready",
          session.sandboxGeneration,
        )
        .one().ready === 1,
    bridgeAttached: host.currentBridge(session) !== null,
    rows,
    held,
    currentRunId: session.currentRunId,
    currentRunOpen:
      session.currentRunId !== null &&
      !isTerminal(
        "run",
        readRunState(host.objectCtx.storage.sql, session.currentRunId) as RunState,
      ),
    repository,
    model:
      session.currentRunId === null
        ? null
        : readRunModel(host.objectCtx.storage.sql, session.currentRunId),
  };
}

/** The catalog as the model grant carries it: every provider's models with the facts a harness is configured from. */
function grantCatalog(): ModelGrantCatalogEntry[] {
  return PROVIDER_IDS.flatMap((provider) =>
    catalogFor(provider).map((spec) => ({
      provider,
      modelId: spec.modelId,
      spec: {
        name: spec.name,
        contextWindow: spec.contextWindow,
        maxOutput: spec.maxOutput,
        effortLevels: spec.effort,
        imageInput: spec.imageInput,
      },
    })),
  );
}

/** Reads the session fresh, plans, applies. Every caller has a session row. */
export async function dispatch(host: SessionHost, input: DispatchInput): Promise<void> {
  const session = host.readSession() as SessionRow;
  await applyDispatch(host, session, planDispatch(host.readDispatchState(session), input));
}

async function applyDispatch(
  host: SessionHost,
  session: SessionRow,
  plan: DispatchPlan,
): Promise<void> {
  const now = new Date().toISOString();
  if (plan.rows.length > 0 || plan.events.length > 0) {
    host.commitControlEvents(session, plan.events, now, () => {
      for (const row of plan.rows) {
        applyDispatchRow(host.objectCtx.storage.sql, row, now);
      }
    });
  }
  // The broker checks a token's generation against the projected
  // `session_index`, so the projection lands before a token naming the new
  // generation can.
  if (plan.frames.some((frame) => frame.kind === "model_grant")) {
    await host.drainOutboxNow();
  }
  for (const frame of plan.frames) {
    await sendFrame(host, session, frame);
  }
  if (plan.revokeGitToken) {
    await host.revokeTokens("git");
  }
  if (plan.checkpointRefused) {
    await host.signalStop({ kind: "checkpoint_unavailable" });
  }
  if (plan.secretsSettled !== null) {
    host.recordSecretsSettled(session, plan.secretsSettled);
    host.secretGrantDeadlineMs = host.computeSecretGrantDeadlineMs();
    host.secretGrantDeadlineLoaded = true;
  }
  if (plan.continuation !== null) {
    await startContinuation(host, plan.continuation.command, plan.continuation.runId, now);
  }
}

/**
 * Sends one frame. A grant is minted at send time and dropped once sent. A
 * failed mint leaves the row pending with its attempt counted, so the next
 * `bridge_connected` retries; a failed git mint also ends the run, since a
 * sandbox that cannot clone cannot work.
 */
async function sendFrame(
  host: SessionHost,
  session: SessionRow,
  frame: OutboundFrame,
): Promise<void> {
  // The only way a frame leaves toward a sandbox. With no current bridge
  // nothing is minted and the row stays open.
  const bridge = host.currentBridge(session);
  if (bridge === null) {
    return;
  }
  const identity = { sessionId: session.id, generation: session.sandboxGeneration };
  const nowMs = Date.now();
  switch (frame.kind) {
    case "command": {
      // One fetch token per composer attachment, minted now and never stored. A
      // held `run_next` follow-up is never sent; the `run.start` that releases it
      // carries its attachments.
      const refs = commandAttachments(frame.command);
      const attachments =
        refs.length === 0
          ? []
          : await mintAttachmentFetches({
              sql: host.objectCtx.storage.sql,
              sessionId: session.id,
              generation: session.sandboxGeneration,
              origin: bridge.origin,
              refs,
              nowMs,
              mint: mintBootstrapCredential,
              hash: sha256Hex,
            });
      bridge.ws.send(
        JSON.stringify(
          buildCommandFrame(identity, frame.command, frame.runId, frame.context, attachments),
        ),
      );
      return;
    }
    case "model_grant": {
      const keyring = await cachedTokenKeyring(host.objectEnv.ONCUE_BROKER_KEYRING);
      if (keyring.kind !== "ok") {
        host.leavePending(session, frame.intentId, "model_grant", "keyring_unavailable");
        return;
      }
      const token = await mintToken(
        keyring.keyring,
        {
          sessionId: session.id,
          sandboxGeneration: session.sandboxGeneration,
          connectionId: frame.need.connectionId,
          workspaceId: session.workspaceId,
          modelId: frame.need.modelId,
          // The token carries the effort the broker writes into every request; another
          // effort gets a fresh grant.
          effort: frame.need.effort,
        },
        nowMs,
      );
      // The effort and the catalog's facts ride with the grant: the bridge declares
      // the model to OpenCode from them and holds no catalog. The provider id came
      // from a CHECK-constrained column, so it is one of the two.
      const spec = findModel(frame.need.providerId, frame.need.modelId);
      bridge.ws.send(
        JSON.stringify(
          buildGrantFrame(identity, {
            kind: "model",
            grantId: frame.intentId,
            expiresAt: new Date(nowMs + TOKEN_TTL_MS).toISOString(),
            token,
            brokerOrigin: bridge.origin,
            model: grantModel(frame.need.providerId, frame.need.modelId),
            runtime: readRuntimeId(host.objectCtx.storage.sql) ?? DEFAULT_RUNTIME_ID,
            effort: frame.need.effort,
            modelSpec:
              spec === null
                ? null
                : {
                    name: spec.name,
                    contextWindow: spec.contextWindow,
                    maxOutput: spec.maxOutput,
                    effortLevels: spec.effort,
                    imageInput: spec.imageInput,
                  },
            // Every model the session could be changed to (record 15), so a
            // harness that takes a model per prompt is started ready for each.
            catalog: grantCatalog(),
            workspace: frame.need.workspace,
          }),
        ),
      );
      return;
    }
    case "git_grant": {
      const config = await readGitHubConfig(host.objectEnv);
      if (config.kind !== "configured") {
        gitGrantNotMinted(host, session, frame.intentId, "github_unconfigured");
        return;
      }
      const minted = await mintInstallationToken(config.appDeps, {
        installationId: frame.need.installationId,
        repositoryIds: [frame.need.repositoryId],
        permissions: { contents: "read" },
      });
      if (minted.kind !== "minted") {
        gitGrantNotMinted(host, session, frame.intentId, "github_mint_failed");
        return;
      }
      host.volatileGitTokens.set(frame.intentId, {
        token: minted.token,
        deps: config.appDeps,
        kind: "git",
      });
      host.gitGrantDeadlineMs = nowMs + GIT_GRANT_TIMEOUT_MS;
      const restoreArtifactId = frame.need.restoreArtifactId ?? null;
      const restore =
        restoreArtifactId === null
          ? null
          : {
              artifactId: restoreArtifactId,
              url: `${bridge.origin}/api/sessions/${session.id}/artifacts/${restoreArtifactId}/restore`,
              token: await host.mintArtifactToken(
                restoreArtifactId,
                "restore",
                session.sandboxGeneration,
                nowMs,
              ),
            };
      await host.rearm();
      if (
        !(await stillDeliverable(
          host,
          session,
          frame.intentId,
          "git_grant",
          minted.token,
          config.appDeps,
        ))
      ) {
        return;
      }
      bridge.ws.send(
        JSON.stringify(
          buildGrantFrame(identity, {
            kind: "git",
            grantId: frame.intentId,
            expiresAt: new Date(nowMs + GIT_TOKEN_LIFETIME_MS).toISOString(),
            token: minted.token,
            repository: { fullName: frame.need.fullName, cloneUrl: frame.need.cloneUrl },
            branch: frame.need.branch,
            taskBranch: grantTaskBranch(frame.need),
            baseSha: frame.need.baseSha,
            headSha: frame.need.headSha ?? frame.need.baseSha,
            restore,
          }),
        ),
      );
      return;
    }
    case "push_grant": {
      // Record 07: `contents: write` for the checkpoint's one push. GitHub cannot
      // narrow it to a ref, so the bridge refuses any destination but
      // `frame.need.ref` and this object revokes the token on the bridge's report.
      // A failed mint makes the checkpoint fall back to a patch bundle.
      const config = await readGitHubConfig(host.objectEnv);
      if (config.kind !== "configured") {
        host.leavePending(session, frame.intentId, "push_grant", "github_unconfigured");
        return;
      }
      // A branch the user chose to work on is asked about at every mint, the
      // first send and any redelivery (record 07).
      if (readExistingBranch(host.objectCtx.storage.sql) !== null) {
        const branch = frame.need.ref.slice("refs/heads/".length);
        const verdict = await confirmExistingBranch(host, session, config.appDeps, {
          installationId: frame.need.installationId,
          repositoryId: frame.need.repositoryId,
          fullName: frame.need.fullName,
          branch,
        });
        if (verdict !== "pushable") {
          // The confirmation awaited GitHub with the input gate open, so a
          // stop or a delete may have run meanwhile: commit against the row as
          // it is now, and not at all if the grant was cleared.
          if (dispatchStillOpen(host.objectCtx.storage.sql, frame.intentId)) {
            withholdPushGrant(
              host,
              host.readSession() as SessionRow,
              frame.intentId,
              branch,
              verdict,
            );
          }
          return;
        }
      }
      const minted = await mintInstallationToken(config.appDeps, {
        installationId: frame.need.installationId,
        repositoryIds: [frame.need.repositoryId],
        permissions: { contents: "write" },
      });
      if (minted.kind !== "minted") {
        host.leavePending(session, frame.intentId, "push_grant", "github_mint_failed");
        return;
      }
      host.volatileGitTokens.set(frame.intentId, {
        token: minted.token,
        deps: config.appDeps,
        kind: "push",
      });
      host.pushGrantDeadlineMs = nowMs + PUSH_GRANT_TIMEOUT_MS;
      await host.rearm();
      if (
        !(await stillDeliverable(
          host,
          session,
          frame.intentId,
          "push_grant",
          minted.token,
          config.appDeps,
        ))
      ) {
        return;
      }
      bridge.ws.send(
        JSON.stringify(
          buildGrantFrame(identity, {
            kind: "push",
            grantId: frame.intentId,
            expiresAt: new Date(nowMs + PUSH_GRANT_TIMEOUT_MS).toISOString(),
            token: minted.token,
            repository: { fullName: frame.need.fullName, cloneUrl: frame.need.cloneUrl },
            ref: frame.need.ref,
            parentSha: frame.need.parentSha,
          }),
        ),
      );
      return;
    }
    case "secret_grant":
      await host.sendSecretGrant(session, frame);
      return;
    case "upload_grant": {
      const token = await host.mintArtifactToken(
        frame.need.artifactId,
        "upload",
        session.sandboxGeneration,
        nowMs,
      );
      bridge.ws.send(
        JSON.stringify(
          buildGrantFrame(identity, {
            kind: "upload",
            grantId: frame.intentId,
            expiresAt: new Date(nowMs + ARTIFACT_LIMITS.tokenTtlMs).toISOString(),
            token,
            artifactId: frame.need.artifactId,
            url: `${bridge.origin}/api/sessions/${session.id}/artifacts/${frame.need.artifactId}`,
            maxBytes: frame.need.maxBytes,
          }),
        ),
      );
      return;
    }
  }
}

/**
 * Called right before a GitHub token's frame is sent, after every await: a
 * stop can reach its revoke step during those awaits and commit
 * `sandbox.credentials_revoked`. To keep that record true, a token that may no
 * longer be delivered (`grantDeliverable`) is removed from the map and revoked
 * here, never entering a frame. The row goes back to pending and the
 * generation's end deletes it.
 */
async function stillDeliverable(
  host: SessionHost,
  session: SessionRow,
  intentId: string,
  operation: "git_grant" | "push_grant",
  token: string,
  deps: GitHubAppDeps,
): Promise<boolean> {
  const generation = session.sandboxGeneration;
  if (
    grantDeliverable(
      readAttachment(host.objectCtx.storage.sql, generation),
      readStopRow(host.objectCtx.storage.sql, generation),
    )
  ) {
    return true;
  }
  host.volatileGitTokens.delete(intentId);
  await revokeInstallationToken(deps, token);
  host.leavePending(session, intentId, operation, "generation_stopping");
  return false;
}

function gitGrantNotMinted(
  host: SessionHost,
  session: SessionRow,
  intentId: string,
  errorCategory: string,
): void {
  host.leavePending(session, intentId, "git_grant", errorCategory);
  host.failRun(
    session,
    session.currentRunId as string,
    "provisioning",
    "git_grant_not_minted",
    "The control plane could not mint a repository token for the sandbox.",
  );
}

export function leavePending(
  host: SessionHost,
  session: SessionRow,
  intentId: string,
  operation: "model_grant" | "git_grant" | "push_grant" | "secret_grant",
  errorCategory: string,
): void {
  log({
    timestamp: new Date().toISOString(),
    severity: "warn",
    service: "session-object",
    release: host.objectEnv.ONCUE_RELEASE,
    environment: host.objectEnv.ONCUE_ENV,
    operation: `session.${operation}`,
    result: "failed",
    errorCategory,
    sandboxGeneration: String(session.sandboxGeneration),
    sessionId: session.id,
  });
  host.objectCtx.storage.sql.exec(
    "UPDATE bridge_dispatch SET state = 'pending' WHERE intent_id = ?",
    intentId,
  );
}

/**
 * A push grant the object will not mint: the row is rejected, so it is never
 * redelivered, and the checkpoint it was meant for keeps the work as a patch
 * bundle. When the grant was a publish the person asked for, the timeline says
 * why and the publish ends failed, so no pull request describes unpushed work.
 */
/** A grant row a generation's end has not deleted and nothing has settled. */
function dispatchStillOpen(sql: SqlStorage, intentId: string): boolean {
  return (
    sql
      .exec<{ open: number }>(
        "SELECT EXISTS(SELECT 1 FROM bridge_dispatch WHERE intent_id = ? AND state IN ('pending', 'sent')) AS open",
        intentId,
      )
      .one().open === 1
  );
}

function withholdPushGrant(
  host: SessionHost,
  session: SessionRow,
  intentId: string,
  branch: string,
  verdict: Exclude<ExistingBranchVerdict, "pushable">,
): void {
  const sql = host.objectCtx.storage.sql;
  const publish = sql
    .exec<{ run_id: string }>(
      "SELECT run_id FROM publish WHERE push_id = ? AND state = 'requested'",
      intentId,
    )
    .toArray()[0];
  const now = new Date().toISOString();
  const withheld =
    publish === undefined
      ? []
      : [
          buildEvent("git.push.withheld", {
            eventId: crypto.randomUUID(),
            sessionId: session.id,
            runId: publish.run_id,
            sandboxGeneration: session.sandboxGeneration,
            runtimeSequence: null,
            occurredAt: now,
            payload: {
              pushId: intentId,
              branch,
              reason: verdict,
              message: WITHHELD_MESSAGE[verdict],
            },
          }),
        ];
  host.commitControlEvents(session, withheld, now, () => {
    sql.exec("UPDATE bridge_dispatch SET state = 'rejected' WHERE intent_id = ?", intentId);
    if (publish !== undefined) {
      settlePublish(sql, intentId, "failed", null);
    }
  });
}

/** `run.failed` outside the provisioning path, with the cached run row in the same transaction. */
export function failRun(
  host: SessionHost,
  session: SessionRow,
  runId: string,
  stage: "provisioning" | "execution",
  category: string,
  message: string,
): void {
  // A run that already reached an outcome (a cancel landing during an await) keeps it.
  if (isTerminal("run", readRunState(host.objectCtx.storage.sql, runId) as RunState)) {
    return;
  }
  const now = new Date().toISOString();
  host.commitControlEvents(
    session,
    [host.runFailedEvent(session, runId, stage, category, message, now)],
    now,
    () => applyDispatchRow(host.objectCtx.storage.sql, { kind: "fail_run", runId }, now),
  );
  // A failed run takes its question with it: nothing is left to answer it.
  host.sweepQuestions();
}

export function runFailedEvent(
  session: SessionRow,
  runId: string,
  stage: "provisioning" | "execution",
  category: string,
  message: string,
  now: string,
): ProtocolEvent {
  return buildEvent("run.failed", {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    runId,
    sandboxGeneration: session.sandboxGeneration,
    runtimeSequence: null,
    occurredAt: now,
    payload: {
      stage,
      error: { category, message },
      summary: null,
      evidence: [],
      branch: null,
      pullRequestNumber: null,
      usage: null,
      durationMs: 0,
    },
  });
}

/**
 * Best effort and never throws: the bridge's own revoke and GitHub's expiry
 * are the backstops. The answer is what `sandbox.credentials_revoked` records.
 */
export async function revokeTokens(
  host: SessionHost,
  kind: "git" | "push",
): Promise<GrantRevocation["outcome"]> {
  const held = [...host.volatileGitTokens.entries()].filter(([, entry]) => entry.kind === kind);
  if (kind === "git") {
    host.gitGrantDeadlineMs = null;
  } else {
    host.pushGrantDeadlineMs = null;
  }
  if (held.length === 0) {
    return "not_held";
  }
  let outcome: GrantRevocation["outcome"] = "revoked";
  for (const [grantId, { token, deps }] of held) {
    host.volatileGitTokens.delete(grantId);
    const spentByBridge = host.bridgeSpentPushGrants.delete(grantId);
    const verdict = await revokeInstallationToken(deps, token);
    const alreadyDead = spentByBridge && verdict.kind === "failed" && verdict.status === 401;
    if (verdict.kind !== "revoked" && !alreadyDead) {
      outcome = "failed";
    }
  }
  return outcome;
}

/**
 * A held `run_next` message, released as a `run.start` continuing the run
 * that just ended. It takes a client command's path, then is offered to the
 * planner as `command_admitted` so the bridge gets it as soon as it can.
 */
async function startContinuation(
  host: SessionHost,
  command: ProtocolCommand,
  runId: string,
  now: string,
): Promise<void> {
  const session = host.readSession() as SessionRow;
  const plan = host.planAndCommit(
    session,
    command,
    { kind: "admit" },
    now,
    runId,
    null,
    "queued_message",
    // The released message runs on the model of the run that just ended.
    true,
  );
  if (plan.kind === "accept" && !(await host.resumeFor(command, runId))) {
    await host.dispatch({
      kind: "command_admitted",
      command,
      now,
      runId: chargedRunId(command, runId),
    });
  }
}

/** Record 07: a token is revoked after a short operation timeout when the bridge never reported. */
export async function expireGrants(host: SessionHost): Promise<void> {
  const nowMs = Date.now();
  if (host.gitGrantDeadlineMs !== null && nowMs >= host.gitGrantDeadlineMs) {
    applyDispatchRow(
      host.objectCtx.storage.sql,
      { kind: "mark_git_grant_revoked" },
      new Date(nowMs).toISOString(),
    );
    await host.revokeTokens("git");
  }
  if (host.pushGrantDeadlineMs !== null && nowMs >= host.pushGrantDeadlineMs) {
    await host.revokeTokens("push");
  }
  const secretDeadline = host.readSecretGrantDeadlineMs();
  if (secretDeadline !== null && nowMs >= secretDeadline) {
    host.settleUnansweredSecretGrants(host.readSession() as SessionRow, nowMs);
  }
}

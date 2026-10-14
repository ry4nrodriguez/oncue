// The session's draft pull request and GitHub's word on it, including the
// foreign-push lockdown.

import { buildEvent } from "@oncue/protocol";
import { openOrUpdateDraft, verificationSection } from "../../github/pull-requests";
import { log } from "../../log";
import { allowsPullRequest, lockedDown } from "../../policy/git-policy";
import { readGitHubConfig } from "../../routes/repositories";
import { pullRequestText } from "../pr-description";
import { evidenceRunFor } from "../publish-cover";
import { markPullRequestAdopted, readExistingBranch } from "./existing-branch";
import type { SessionHost } from "./host";
import {
  readDurableHeadSha,
  readRunsForCover,
  readRunWarnings,
  readSectionChecks,
} from "./store-git";
import { readDescription, readPolicy } from "./store-session";
import type { PullRequestStateBody, SessionRow, StopSandboxResult } from "./types";

/**
 * GitHub's word on the session's pull request, from the verified webhook.
 * Every change is a person's doing; OnCue only opens drafts. Deliveries are
 * at-least-once, so a recorded state changes nothing, and a number this
 * session does not own is ignored.
 */
export function recordPullRequestState(
  host: SessionHost,
  body: PullRequestStateBody,
): {
  readonly kind: "no_session" | "not_this_sessions" | "unchanged" | "recorded";
} {
  const session = host.readSession();
  if (session === null) {
    return { kind: "no_session" };
  }
  const sql = host.objectCtx.storage.sql;
  const row = sql
    .exec<{ number: number | null; state: PullRequestStateBody["to"] }>(
      "SELECT number, state FROM pull_request WHERE id = 1",
    )
    .toArray()[0];
  if (row === undefined || row.number !== body.number) {
    return { kind: "not_this_sessions" };
  }
  if (row.state === body.to) {
    return { kind: "unchanged" };
  }
  const now = new Date().toISOString();
  const changed = buildEvent("pull_request.state_changed", {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    runId: null,
    sandboxGeneration: session.sandboxGeneration,
    runtimeSequence: null,
    occurredAt: now,
    payload: {
      number: body.number,
      from: row.state,
      to: body.to,
      actor: body.actor,
      mergedSha: body.mergedSha,
      changedAt: body.changedAt,
    },
  });
  host.commitControlEvents(session, [changed], now, () => {
    sql.exec("UPDATE pull_request SET state = ? WHERE id = 1", body.to);
  });
  return { kind: "recorded" };
}

/**
 * Record 07's incident rule, this session's half: the App pushed to a ref that
 * is no session's branch. A token is scoped to the repository, so every
 * session of it locks down: policy to `push: "never"` and `pullRequest:
 * "never"` as `system` (which also withholds the next checkpoint's push
 * grant), and a live sandbox is stopped like a user's stop, revoking every
 * credential. It pushes again only after the user widens the policy.
 */
export async function lockDownAfterForeignPush(host: SessionHost): Promise<{
  readonly kind: "no_session" | "locked_down";
  readonly policyChanged: boolean;
  readonly stop: StopSandboxResult["kind"] | null;
}> {
  const session = host.readSession();
  if (session === null) {
    return { kind: "no_session", policyChanged: false, stop: null };
  }
  const stored = readPolicy(host.objectCtx.storage.sql).policy;
  const locked = lockedDown(stored);
  if (locked !== null) {
    host.commitPolicyUpdate(session, stored, locked, {
      proposalId: null,
      confirmedBy: "system",
      userId: null,
    });
  }
  const stop = await host.stopSandbox({
    requestedByUserId: session.ownerUserId,
    modalCredential: undefined,
  });
  return { kind: "locked_down", policyChanged: locked !== null, stop: stop.kind };
}

/**
 * Records 07 and 14: after a publish, where policy allows, open the session's
 * draft pull request or update the one it owns. The token is minted and
 * revoked inside `openOrUpdateDraft` and never leaves this Worker; the
 * verification section comes from this object's check rows. A failed publish
 * opens nothing; one with nothing new to push still does, since an earlier
 * checkpoint may have pushed the work (GitHub answers `no_commits` otherwise).
 */
export async function maybeOpenPullRequest(host: SessionHost, session: SessionRow): Promise<void> {
  const sql = host.objectCtx.storage.sql;
  const policy = readPolicy(host.objectCtx.storage.sql).policy;
  const target = sql
    .exec<{
      base_branch: string;
      app_origin: string;
      number: number | null;
      section_version: number;
      state: string;
    }>(
      "SELECT base_branch, app_origin, number, section_version, state FROM pull_request WHERE id = 1",
    )
    .toArray()[0];
  const published = sql
    .exec<{ run_id: string; state: string; head_sha: string | null }>(
      "SELECT run_id, state, head_sha FROM publish ORDER BY requested_at DESC LIMIT 1",
    )
    .toArray()[0];
  const repository = host.readDispatchState(session).repository;
  if (
    !allowsPullRequest(policy) ||
    target === undefined ||
    published === undefined ||
    published.state === "failed" ||
    repository === null ||
    // A person closed or merged it on GitHub. OnCue does not write to a finished
    // pull request or open a second one behind it.
    target.state === "closed" ||
    target.state === "merged"
  ) {
    return;
  }
  const config = await readGitHubConfig(host.objectEnv);
  if (config.kind !== "configured") {
    return;
  }
  const runId = published.run_id;
  // A publish with nothing new to push names no head: the branch's is the last checkpoint's.
  const headSha =
    published.head_sha ?? readDurableHeadSha(host.objectCtx.storage.sql, repository.baseSha);
  const sessionUrl = `${target.app_origin}/sessions/${session.id}`;
  // The agent's words when it gave them (record 07), else the user's request,
  // else the branch. The control plane cleans them either way.
  const description = readDescription(host.objectCtx.storage.sql);
  const text = pullRequestText(description, session.title, repository.branch);
  // On a branch the user chose, an open pull request is a person's: adopted, it
  // keeps their title and description (record 07).
  const existingBranch = readExistingBranch(sql);
  const title = text.title;
  // The checks describing the pushed code are the covering run's: the
  // publishing run unless it changed nothing (record 14).
  const evidenceRunId = evidenceRunFor(readRunsForCover(host.objectCtx.storage.sql, runId), runId);
  const run = sql
    .exec<{ outcome: string }>("SELECT outcome FROM run WHERE id = ?", evidenceRunId)
    .one();
  const outcome = await openOrUpdateDraft(config.appDeps, {
    installationId: repository.installationId,
    repositoryId: repository.repositoryId,
    fullName: repository.fullName,
    headBranch: repository.branch,
    baseBranch: target.base_branch,
    title,
    summary: text.summary,
    rewrite: existingBranch?.pullRequestAdopted === true ? null : text.rewrite,
    sessionUrl,
    section: verificationSection({
      outcome: run.outcome === "verified" ? "verified" : "completed_with_warnings",
      checks: readSectionChecks(host.objectCtx.storage.sql, evidenceRunId),
      warnings: readRunWarnings(host.objectCtx.storage.sql, session, evidenceRunId),
      sessionUrl,
      headSha,
    }),
    existingNumber: target.number,
    adoptOpenPullRequest: existingBranch !== null,
  });
  const now = new Date().toISOString();
  const envelope = {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    runId,
    sandboxGeneration: session.sandboxGeneration,
    runtimeSequence: null,
    occurredAt: now,
  };
  if (outcome.kind !== "created" && outcome.kind !== "updated") {
    log({
      timestamp: now,
      severity: "warn",
      service: "session-object",
      release: host.objectEnv.ONCUE_RELEASE,
      environment: host.objectEnv.ONCUE_ENV,
      operation: "session.pull_request",
      result: outcome.kind,
      sessionId: session.id,
      runId,
    });
    return;
  }
  const sectionVersion = target.section_version + 1;
  const event =
    outcome.kind === "created"
      ? buildEvent("pull_request.created", {
          ...envelope,
          payload: {
            number: outcome.number,
            url: outcome.url,
            title,
            draft: outcome.draft,
            baseBranch: target.base_branch,
            headBranch: repository.branch,
            headSha: outcome.headSha,
            verificationSectionVersion: sectionVersion,
          },
        })
      : buildEvent("pull_request.updated", {
          ...envelope,
          payload: {
            number: outcome.number,
            headSha: outcome.headSha,
            verificationSectionVersion: sectionVersion,
            changed: outcome.rewritten
              ? ["title", "body", "verification_section"]
              : ["verification_section"],
          },
        });
  // The first time the session learns its pull request, opened or adopted, it
  // records GitHub's draft state: an adopted one may already be ready for review.
  const firstLearned = target.number === null;
  host.commitControlEvents(session, [event], now, () => {
    sql.exec(
      "UPDATE pull_request SET number = ?, url = ?, section_version = ? WHERE id = 1",
      outcome.number,
      outcome.url,
      sectionVersion,
    );
    if (firstLearned) {
      sql.exec("UPDATE pull_request SET state = ? WHERE id = 1", outcome.draft ? "draft" : "open");
    }
    if (firstLearned && outcome.kind === "updated" && existingBranch !== null) {
      markPullRequestAdopted(sql);
    }
    // A description admitted during the await above is newer and is written by
    // the next update.
    if (description !== null && (outcome.kind === "created" || outcome.rewritten)) {
      sql.exec(
        "UPDATE pull_request_description SET applied_version = MAX(applied_version, ?) WHERE id = 1",
        description.version,
      );
    }
  });
  if (firstLearned) {
    // Record the pull request's number once, opened or adopted, so the
    // `pull_request` webhook can find the session. A failed index write is
    // logged, never thrown out of the frame that reported the push.
    await writeIndexColumn(
      host,
      "session.pull_request",
      session,
      "UPDATE session_index SET pull_request_number = ? WHERE session_id = ?",
      outcome.number,
    );
  }
}

/**
 * One `session_index` column written straight to D1, outside the outbox,
 * whose ordering guard would skip a write with no new event. A refused write
 * is logged, never thrown out of the frame that made the fact.
 */
function writeIndexColumn(
  host: SessionHost,
  operation: "session.pull_request",
  session: SessionRow,
  statement: string,
  value: string | number,
): Promise<void> {
  return host.objectEnv.DB.prepare(statement)
    .bind(value, session.id)
    .run()
    .then(
      () => undefined,
      () => {
        log({
          timestamp: new Date().toISOString(),
          severity: "error",
          service: "session-object",
          release: host.objectEnv.ONCUE_RELEASE,
          environment: host.objectEnv.ONCUE_ENV,
          operation,
          result: "index_write_failed",
          sessionId: session.id,
        });
      },
    );
}

// The user's push (records 07 and 14): checkpoints, checks before a publish,
// and the publish's end.

import type { DeliverableCommand } from "@oncue/bridge";
import { buildEvent, type ProtocolCommand, type ProtocolEventOf } from "@oncue/protocol";
import { allowsCheckpointPush, allowsPush } from "../../policy/git-policy";
import { chargedRunId, PUSH_GRANT_TIMEOUT_MS } from "../dispatch";
import type { StopSignal } from "../lifecycle";
import { CHECKS_BEFORE_PUBLISH_TEXT, coverFor } from "../publish-cover";
import type { SessionHost } from "./host";
import {
  readDurableHeadSha,
  readRepositoryBase,
  readRunsForCover,
  settlePublish,
} from "./store-git";
import { readPolicy, readRunModel } from "./store-session";
import type { RepositoryBase, SessionRow } from "./types";

/**
 * Record 11: the object issues `checkpoint.create` with a push grant naming
 * the session branch. A checkpoint is the object's durability push, so the Git
 * policy withholds the grant only under `push: "never"`; `manual` still pushes.
 */
export async function issueCheckpoint(
  host: SessionHost,
  session: SessionRow,
  reason: "idle" | "lifetime_ceiling",
): Promise<StopSignal> {
  const issued = await sendCheckpoint(
    host,
    session,
    reason,
    allowsCheckpointPush(readPolicy(host.objectCtx.storage.sql).policy)
      ? crypto.randomUUID()
      : null,
  );
  return { kind: issued ? "checkpoint_issued" : "checkpoint_unavailable" };
}

/**
 * `checkpoint.create`, preceded by the push grant when `pushGrantId` is set.
 * A stop's checkpoint and the user's publish share this path; only the reason
 * and who allowed the push differ.
 */
async function sendCheckpoint(
  host: SessionHost,
  session: SessionRow,
  reason: "idle" | "lifetime_ceiling" | "user_requested",
  pushGrantId: string | null,
): Promise<boolean> {
  if (host.currentBridge(session) === null) {
    return false;
  }
  const repository = readRepositoryBase(host.objectCtx.storage.sql) as RepositoryBase;
  // The push grant names the ref, so the branch is named first; a session that
  // cannot be named checkpoints without a grant, as a bundle.
  // A branch the user chose to work on is asked about again when the grant is
  // minted (`bridge-dispatch.ts`), so a redelivered grant is asked about too.
  const grantId =
    pushGrantId !== null && (await host.nameTaskBranch(session, repository)) === null
      ? null
      : pushGrantId;
  const now = new Date().toISOString();
  const command = {
    commandId: crypto.randomUUID(),
    sessionId: session.id,
    runId: null,
    issuedAt: now,
    issuedByUserId: session.ownerUserId,
    expected: { scope: "session", state: session.state },
    type: "checkpoint.create",
    payload: { reason },
  } as unknown as DeliverableCommand;
  const plan = host.planAndCommit(
    session,
    command,
    { kind: "admit" },
    now,
    crypto.randomUUID(),
    null,
    null,
    true,
  );
  if (plan.kind !== "accept") {
    return false;
  }
  await host.dispatch({
    kind: "checkpoint_requested",
    command,
    now,
    // Under `push: "never"` a stop sends no grant, and the bridge saves the
    // work as a patch bundle instead (record 07).
    push:
      grantId === null
        ? null
        : {
            grantId,
            parentSha: readDurableHeadSha(host.objectCtx.storage.sql, repository.baseSha),
          },
  });
  return true;
}

/**
 * Record 14: the code a push would carry is unchecked, so a checks-only run
 * goes first on the continued run's model. When it ends, `run_terminal` calls
 * `maybePublish` again and finds the code covered.
 */
async function startChecksBeforePublish(
  host: SessionHost,
  session: SessionRow,
  fromRunId: string,
): Promise<void> {
  const model = readRunModel(host.objectCtx.storage.sql, fromRunId);
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const command = {
    commandId: crypto.randomUUID(),
    sessionId: session.id,
    runId: null,
    issuedAt: now,
    issuedByUserId: session.ownerUserId,
    expected: { scope: "session", state: "active" },
    type: "run.start",
    payload: {
      instruction: {
        messageId: crypto.randomUUID(),
        text: CHECKS_BEFORE_PUBLISH_TEXT,
        attachments: [],
      },
      model,
      continuesRunId: fromRunId,
      checksOnly: true,
    },
    // Branded ids are minted here, as `planRunTerminal` mints its own.
  } as unknown as ProtocolCommand;
  // A run the object starts is still a new run: the "stop new runs" control
  // (record 22) holds it back like any other.
  const plan = host.planAndCommit(
    session,
    command,
    await host.decideAdmissionNow(),
    now,
    runId,
    null,
    null,
    true,
  );
  if (plan.kind !== "accept") {
    return;
  }
  // `maybePublish` gets here only with a bridge attached and no stop under way,
  // so the checks run on the current generation: nothing to resume.
  await host.dispatch({
    kind: "command_admitted",
    command,
    now,
    runId: chargedRunId(command, runId),
  });
}

/**
 * The user's push (records 07 and 09), called when a run ends or a policy
 * change is confirmed, never per frame. The object decides everything: the
 * policy allows a push, the run ended with work worth pushing, nothing else
 * is using the bridge's Git, and this run is not yet published. The ref is
 * the session branch, named by the grant; the model chooses nothing.
 */
export async function maybePublish(host: SessionHost): Promise<void> {
  const session = host.readSession() as SessionRow;
  const runId = session.currentRunId;
  const sql = host.objectCtx.storage.sql;
  const policy = readPolicy(host.objectCtx.storage.sql).policy;
  const repository = readRepositoryBase(host.objectCtx.storage.sql);
  if (
    runId === null ||
    !allowsPush(policy) ||
    repository === null ||
    host.currentBridge(session) === null ||
    host.lifecycleView(session, Date.now()).stop !== null
  ) {
    return;
  }
  const facts = sql
    .exec<{ published: number; open: number }>(
      `SELECT EXISTS(SELECT 1 FROM publish WHERE run_id = ?1) AS published,
                EXISTS(SELECT 1 FROM publish WHERE state = 'requested' AND requested_at > ?2) AS open`,
      runId,
      // A publish whose bridge went away never reports; past
      // `PUSH_GRANT_TIMEOUT_MS` its grant is dead and it no longer blocks the next.
      new Date(Date.now() - PUSH_GRANT_TIMEOUT_MS).toISOString(),
    )
    .one();
  if (facts.published === 1 || facts.open === 1) {
    return;
  }
  // Record 14: push only when some run's checks cover the code; otherwise run
  // the checks first and come back here when that run ends.
  const cover = coverFor(readRunsForCover(host.objectCtx.storage.sql, runId));
  if (cover.kind === "held") {
    return;
  }
  if (cover.kind === "unchecked") {
    await startChecksBeforePublish(host, session, runId);
    return;
  }
  const branch = await host.nameTaskBranch(session, repository);
  if (branch === null) {
    return;
  }
  const pushId = crypto.randomUUID();
  const now = new Date().toISOString();
  const requested = buildEvent("git.push.requested", {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    runId,
    sandboxGeneration: session.sandboxGeneration,
    runtimeSequence: null,
    occurredAt: now,
    payload: {
      pushId,
      branch,
      headSha: null,
      commitCount: 1,
      policy: { policyVersion: policy.version, rule: "auto_push", approvalId: null },
    },
  });
  host.commitControlEvents(session, [requested], now, () => {
    sql.exec(
      "INSERT INTO publish (push_id, run_id, state, head_sha, requested_at) VALUES (?,?,'requested',NULL,?)",
      pushId,
      runId,
      now,
    );
  });
  await sendCheckpoint(host, session, "user_requested", pushId);
}

/**
 * Marks every push grant of this generation spent: the bridge takes the token
 * when a checkpoint starts and revokes it on every path out, failure included.
 */
export function markPushGrantsSpent(host: SessionHost): void {
  const pushGrants = [...host.volatileGitTokens.entries()].filter(
    ([, entry]) => entry.kind === "push",
  );
  for (const [grantId] of pushGrants) {
    host.bridgeSpentPushGrants.add(grantId);
  }
}

/**
 * The bridge's checkpoint report ends a publish. Record 07 revokes the token
 * once the bridge reports, so a publish revokes here rather than waiting for a
 * stop or the deadline.
 */
export async function finishPublish(
  host: SessionHost,
  session: SessionRow,
  kind: ProtocolEventOf<"repository.checkpointed">["payload"]["kind"],
): Promise<void> {
  const sql = host.objectCtx.storage.sql;
  // Only a publish this object asked for, recent enough that its grant may be
  // alive, and not yet reported. Anything else is a stop's checkpoint (revoked
  // at the stop's revoke step) or an unprompted frame, which must never reach GitHub.
  const waiting = sql
    .exec<{ push_id: string; state: string }>(
      "SELECT push_id, state FROM publish WHERE reported_at IS NULL AND requested_at > ? ORDER BY requested_at DESC LIMIT 1",
      new Date(Date.now() - PUSH_GRANT_TIMEOUT_MS).toISOString(),
    )
    .toArray()[0];
  if (waiting === undefined) {
    return;
  }
  sql.exec(
    "UPDATE publish SET reported_at = ? WHERE push_id = ?",
    new Date().toISOString(),
    waiting.push_id,
  );
  if (waiting.state === "requested") {
    // No push either way. A checkpoint already on the branch had nothing new; one
    // left as a local commit or patch bundle is unpushed work, and no pull
    // request may describe it.
    settlePublish(
      host.objectCtx.storage.sql,
      waiting.push_id,
      kind === "branch_push" ? "nothing_to_push" : "failed",
      null,
    );
  }
  if (host.lifecycleView(session, Date.now()).stop === null) {
    await host.revokeTokens("push");
    await host.maybeOpenPullRequest(session);
  }
}

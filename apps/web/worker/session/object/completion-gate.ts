// Record 14's gate on `run.verified`: the judgement and the downgrade.

import { buildEvent, type CommittedEvent, type ProtocolEventOf } from "@oncue/protocol";
import { log } from "../../log";
import {
  type CheckRecord,
  judgeVerifiedClaim,
  type RefusalReason,
  type VerifiedJudgement,
  warningsFor,
} from "../completion";
import { planRunRow } from "../dispatch";
import { MAX_OUTCOME_REFUSALS } from "./constants";
import type { SessionHost } from "./host";
import { applyRunRow } from "./store-session";
import type { SessionRow } from "./types";

/** The gate's reads: the run row, the two verification tables by key, and each evidence artifact by id. */
export function judgeVerified(
  host: SessionHost,
  session: SessionRow,
  event: CommittedEvent,
): VerifiedJudgement {
  const runId = event.runId as string;
  const sql = host.objectCtx.storage.sql;
  const run = sql
    .exec<{ outcome: string | null }>("SELECT outcome FROM run WHERE id = ?", runId)
    .toArray()[0];
  const summary = sql
    .exec<{ required_total: number; user_skipped_count: number; sandbox_generation: number }>(
      "SELECT required_total, user_skipped_count, sandbox_generation FROM run_verification WHERE run_id = ?",
      runId,
    )
    .toArray()[0];
  const checks = sql
    .exec<{
      check_id: string;
      attempt: number;
      sandbox_generation: number;
      classification: CheckRecord["classification"];
      revision: string;
      result: CheckRecord["result"];
      evidence_artifact_id: string | null;
    }>(
      "SELECT check_id, attempt, sandbox_generation, classification, revision, result, evidence_artifact_id FROM verification_check WHERE run_id = ?",
      runId,
    )
    .toArray()
    .map(
      (row): CheckRecord => ({
        checkId: row.check_id,
        attempt: row.attempt,
        sandboxGeneration: row.sandbox_generation,
        classification: row.classification,
        revision: row.revision,
        result: row.result,
        evidenceArtifactId: row.evidence_artifact_id,
      }),
    );
  // At most twenty rows, and only when a run claims to be verified.
  const missingRequiredSecrets = sql
    .exec<{ name: string }>(
      // A required name is missing until this generation's bridge acknowledged its
      // file: selected is what the user chose, not what arrived.
      "SELECT name FROM session_secret WHERE kind = 'required' AND (selected = 0 OR supplied_generation IS NOT ?) ORDER BY name",
      session.sandboxGeneration,
    )
    .toArray()
    .map((row) => row.name);
  const declaration = sql
    .exec<{ invalid: number }>("SELECT invalid FROM session_declaration WHERE id = 1")
    .toArray()[0];
  return judgeVerifiedClaim({
    missingRequiredSecrets,
    declarationInvalid: declaration?.invalid === 1,
    runOutcome: run === undefined ? null : run.outcome,
    attachedGeneration: session.sandboxGeneration,
    summary:
      summary === undefined
        ? null
        : {
            requiredTotal: summary.required_total,
            userSkippedCount: summary.user_skipped_count,
            sandboxGeneration: summary.sandbox_generation,
          },
    checks,
    committedArtifactIds: {
      has: (artifactId) =>
        sql
          .exec<{ created: number }>(
            "SELECT EXISTS(SELECT 1 FROM artifact WHERE id = ? AND state = 'created') AS created",
            artifactId,
          )
          .one().created === 1,
    },
  });
}

/**
 * A refused `run.verified` is never stored. Unless the run already ended, the
 * object commits the outcome the records support instead, with the bridge's
 * summary and one warning per reason; it ends the run like a bridge terminal
 * (the row moves in the same transaction and the next held message is released).
 */
export async function refuseVerified(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  event: CommittedEvent & ProtocolEventOf<"run.verified">,
  reasons: readonly RefusalReason[],
): Promise<void> {
  const generation = session.sandboxGeneration;
  log({
    timestamp: new Date().toISOString(),
    severity: "warn",
    service: "session-object",
    release: host.objectEnv.ONCUE_RELEASE,
    environment: host.objectEnv.ONCUE_ENV,
    operation: "session.ingest",
    result: "refused",
    errorCategory: "verified_without_evidence",
    sandboxGeneration: String(generation),
    sessionId: session.id,
    runId: event.runId,
  });
  if (!reasons.some((reason) => reason.kind === "run_already_ended")) {
    const now = new Date().toISOString();
    const { summary, evidence, branch, pullRequestNumber, usage, durationMs } = event.payload;
    const downgraded = buildEvent("run.completed_with_warnings", {
      eventId: crypto.randomUUID(),
      sessionId: session.id,
      runId: event.runId,
      sandboxGeneration: generation,
      runtimeSequence: null,
      occurredAt: now,
      payload: {
        summary,
        warnings: warningsFor(reasons),
        evidence,
        branch,
        pullRequestNumber,
        usage,
        durationMs,
      },
    });
    const [committed] = host.commitControlEvents(session, [downgraded], now, () => {
      applyRunRow(host.objectCtx.storage.sql, planRunRow(downgraded, session.currentRunId), now);
    });
    await host.reactToCommittedFrame(committed as CommittedEvent);
  }
  const refused = (host.outcomeRefusals.get(ws) ?? 0) + 1;
  host.outcomeRefusals.set(ws, refused);
  if (refused > MAX_OUTCOME_REFUSALS) {
    log({
      timestamp: new Date().toISOString(),
      severity: "warn",
      service: "session-object",
      release: host.objectEnv.ONCUE_RELEASE,
      environment: host.objectEnv.ONCUE_ENV,
      operation: "session.ingest",
      result: "refused",
      errorCategory: "outcome_refused",
      sandboxGeneration: String(generation),
      sessionId: session.id,
    });
    ws.close(4001, "outcome refused");
  }
}

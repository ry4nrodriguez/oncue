// The question gate (records 04 and 12): admitting the agent's question,
// telling the bridge what the user decided, ending a question with its run,
// and resuming a stopped run with the user's answers.

import { buildQuestionFrame, type QuestionOutcome } from "@oncue/bridge";
import {
  type AskedQuestion,
  buildEvent,
  type CommittedEvent,
  type PayloadOf,
  type ProtocolEventOf,
  type RunState,
} from "@oncue/protocol";
import { log } from "../../log";
import {
  answerResumes,
  answersMessage,
  isCountedQuestionRefusal,
  judgeQuestion,
  type QuestionRefusal,
  type QuestionSweepCause,
  questionEnding,
} from "../questions";
import { MAX_QUESTION_REFUSALS } from "./constants";
import type { SessionHost } from "./host";
import { resumeRunWith } from "./resume";
import { insertEventRow } from "./store-session";
import type { SessionRow } from "./types";

/**
 * The sandbox is trusted for one fact: the agent's harness waits on the user.
 * The object mints the id the card answers by, keeps the bridge's reference,
 * and stores the question with the event in one transaction. Three keyed
 * reads; a refused question is never stored, and the bridge is told so its
 * harness's call ends.
 */
export function admitQuestion(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  event: CommittedEvent & ProtocolEventOf<"question.asked">,
): void {
  const sql = host.objectCtx.storage.sql;
  const sandboxRef = event.payload.questionId;
  const runId = session.currentRunId;
  const facts = sql
    .exec<{ state: string | null; open: number; admitted: number | null }>(
      `SELECT (SELECT state FROM run WHERE id = ?1) AS state,
              EXISTS(SELECT 1 FROM question WHERE state = 'open') AS open,
              (SELECT admitted FROM run_question_count WHERE run_id = ?1) AS admitted`,
      runId,
    )
    .one();
  const judgement = judgeQuestion({
    runMatches: runId !== null && event.runId === runId,
    runState: facts.state,
    openQuestionExists: facts.open === 1,
    admittedThisRun: facts.admitted ?? 0,
  });
  if (judgement.kind === "refuse") {
    sendQuestionFrame(host, session, sandboxRef, "refused", null);
    refuseQuestion(host, ws, session, judgement.reason);
    return;
  }
  const now = new Date().toISOString();
  const questionId = crypto.randomUUID() as typeof event.payload.questionId;
  const recorded = { ...event, payload: { ...event.payload, questionId } };
  host.objectCtx.storage.transactionSync(() => {
    insertEventRow(sql, recorded, JSON.stringify(recorded));
    sql.exec(
      `INSERT INTO question (id, run_id, state, sandbox_ref, requested_generation, questions_json, answers_json, asked_at, settled_at)
         VALUES (?, ?, 'open', ?, ?, ?, NULL, ?, NULL)`,
      questionId,
      runId,
      sandboxRef,
      session.sandboxGeneration,
      JSON.stringify(event.payload.questions),
      now,
    );
    sql.exec(
      "INSERT INTO run_question_count (run_id, admitted) VALUES (?,1) ON CONFLICT (run_id) DO UPDATE SET admitted = admitted + 1",
      runId,
    );
    host.enqueueOutboxSnapshot(session, now);
  });
  host.broadcastToClients(JSON.stringify(recorded));
  host.objectCtx.waitUntil(host.drainOutboxNow());
  // A run waiting on a question is idle, so the idle stop's deadline moves.
  host.objectCtx.waitUntil(host.rearm());
}

/** Counted per socket; an honest race with an open question is neither counted nor logged. */
function refuseQuestion(
  host: SessionHost,
  ws: WebSocket,
  session: SessionRow,
  reason: QuestionRefusal,
): void {
  if (!isCountedQuestionRefusal(reason)) {
    return;
  }
  log({
    timestamp: new Date().toISOString(),
    severity: "warn",
    service: "session-object",
    release: host.objectEnv.ONCUE_RELEASE,
    environment: host.objectEnv.ONCUE_ENV,
    operation: "session.ingest",
    result: "refused",
    errorCategory: `question_${reason}`,
    sandboxGeneration: String(session.sandboxGeneration),
    sessionId: session.id,
  });
  const refused = (host.questionRefusals.get(ws) ?? 0) + 1;
  host.questionRefusals.set(ws, refused);
  if (refused > MAX_QUESTION_REFUSALS) {
    ws.close(4001, "question refused");
  }
}

function sendQuestionFrame(
  host: SessionHost,
  session: SessionRow,
  sandboxRef: string,
  outcome: QuestionOutcome,
  answers: readonly (readonly string[])[] | null,
): void {
  const bridge = host.currentBridge(session);
  if (bridge === null) {
    return;
  }
  bridge.ws.send(
    JSON.stringify(
      buildQuestionFrame(
        { sessionId: session.id, generation: session.sandboxGeneration },
        sandboxRef,
        outcome,
        answers,
      ),
    ),
  );
}

type QuestionRow = {
  readonly id: string;
  readonly run_id: string;
  readonly state: "open" | "answered" | "dismissed";
  readonly sandbox_ref: string;
  readonly requested_generation: number;
  readonly questions_json: string;
  readonly answers_json: string | null;
  readonly run_state: RunState | null;
};

const QUESTION_COLUMNS =
  "q.id, q.run_id, q.state, q.sandbox_ref, q.requested_generation, q.questions_json, q.answers_json, (SELECT state FROM run WHERE id = q.run_id) AS run_state";

/** What the bridge is told about a settled question, or null for one still open. */
function frameFor(row: QuestionRow): {
  readonly outcome: QuestionOutcome;
  readonly answers: readonly (readonly string[])[] | null;
} | null {
  if (row.state === "open") {
    return null;
  }
  return row.state === "answered"
    ? { outcome: "answered", answers: JSON.parse(row.answers_json as string) as string[][] }
    : { outcome: "dismissed", answers: null };
}

/**
 * After the user answered or dismissed a question: a harness still waiting in
 * this generation is told; an answer to a run the idle stop paused, or one
 * whose sandbox was lost, resumes it on a new sandbox with the answers as its
 * message. One keyed read.
 */
export async function deliverQuestionDecision(
  host: SessionHost,
  questionId: string,
  commandId: string,
  now: string,
): Promise<void> {
  const session = host.readSession() as SessionRow;
  const row = host.objectCtx.storage.sql
    .exec<QuestionRow>(`SELECT ${QUESTION_COLUMNS} FROM question q WHERE q.id = ?`, questionId)
    .toArray()[0];
  const frame = row === undefined ? null : frameFor(row);
  if (row === undefined || frame === null) {
    return;
  }
  if (frame.outcome === "answered" && answerResumes(row.run_state)) {
    await resumeRunWith(host, row.run_id, {
      commandId,
      issuedAt: now,
      issuedByUserId: session.ownerUserId,
      text: answersMessage(
        JSON.parse(row.questions_json) as AskedQuestion[],
        frame.answers as readonly (readonly string[])[],
      ),
    });
    return;
  }
  // Only the current generation's bridge is told; one that never asked it drops the frame.
  sendQuestionFrame(host, session, row.sandbox_ref, frame.outcome, frame.answers);
}

/**
 * A bridge that reconnects may have missed the frame that settled its
 * question, so the newest question of its generation is told again once it is
 * settled. One indexed read per connect, never per frame; a bridge drops a
 * frame for a question it no longer waits on.
 */
export function resendQuestionDecision(host: SessionHost, session: SessionRow): void {
  const row = host.objectCtx.storage.sql
    .exec<QuestionRow>(
      `SELECT ${QUESTION_COLUMNS} FROM question q WHERE q.requested_generation = ? ORDER BY q.rowid DESC LIMIT 1`,
      session.sandboxGeneration,
    )
    .toArray()[0];
  const frame = row === undefined ? null : frameFor(row);
  if (row === undefined || frame === null) {
    return;
  }
  sendQuestionFrame(host, session, row.sandbox_ref, frame.outcome, frame.answers);
}

/**
 * A question does not outlive its run: one whose run ended, that the bridge
 * paused, or that the planned replacement restarts elsewhere is dismissed
 * (`questionEnding`). One read of the partial index. Called wherever a run can
 * end, and from the alarm, so an eviction loses nothing.
 */
export function sweepQuestions(host: SessionHost, cause: QuestionSweepCause | null = null): void {
  const session = host.readSession();
  if (session === null) {
    return;
  }
  const row = host.objectCtx.storage.sql
    .exec<QuestionRow>(`SELECT ${QUESTION_COLUMNS} FROM question q WHERE q.state = 'open' LIMIT 1`)
    .toArray()[0];
  const reason = row === undefined ? null : questionEnding(row.run_state, cause);
  if (row === undefined || reason === null) {
    return;
  }
  const now = new Date().toISOString();
  const dismissed = buildEvent("question.dismissed", {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    runId: row.run_id,
    sandboxGeneration: session.sandboxGeneration,
    runtimeSequence: null,
    occurredAt: now,
    payload: {
      questionId: row.id as PayloadOf<"question.dismissed">["questionId"],
      reason,
      decidedBy: null,
      commandId: null,
    },
  });
  host.commitControlEvents(session, [dismissed], now, () => {
    host.objectCtx.storage.sql.exec(
      "UPDATE question SET state = 'dismissed', settled_at = ? WHERE id = ? AND state = 'open'",
      now,
      row.id,
    );
  });
  sendQuestionFrame(host, session, row.sandbox_ref, "dismissed", null);
}

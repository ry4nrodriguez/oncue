import { defineFamily } from "../define";
import {
  artifactRef,
  bodyText,
  boolean,
  boundedList,
  checkpointId,
  commandId,
  counter,
  exactOptional,
  literal,
  messageId,
  modelRecord,
  nullable,
  number,
  picklist,
  runId,
  runtimeRecord,
  sha,
  shortText,
  strictObject,
  summaryText,
  timestamp,
  tokenUsage,
  userId,
  variant,
} from "../schema";
import { MODEL_FAILURE_CATEGORIES } from "../states";

export const modelFailureCategory = picklist(MODEL_FAILURE_CATEGORIES);

export const modelFailure = strictObject({
  category: modelFailureCategory,
  message: summaryText,
  retries: counter,
});

// Record 14's user-facing completion summary, one field per bullet.
export const completionSummary = strictObject({
  whatChanged: summaryText,
  why: summaryText,
  verificationPerformed: summaryText,
  limitations: boundedList(summaryText),
  nextStep: nullable(summaryText),
});

const outcomeTail = {
  evidence: boundedList(artifactRef),
  branch: nullable(shortText),
  pullRequestNumber: nullable(counter),
  usage: nullable(tokenUsage),
  durationMs: counter,
} as const;

export const LIFECYCLE_EVENTS = defineFamily("lifecycle", {
  "runtime.connected": {
    scope: "session",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      bridgeVersion: shortText,
      runtimeName: shortText,
      runtimeVersion: shortText,
      protocolVersion: counter,
      capabilities: boundedList(shortText),
    }),
  },
  "runtime.ready": {
    scope: "session",
    origin: "sandbox",
    durability: "durable",
    // The runtime names itself here rather than on `runtime.connected`: the
    // bridge connects before any runtime exists, and the version is known only
    // once the runtime answers a health check (record 04).
    payload: strictObject({
      runtimeName: shortText,
      runtimeVersion: shortText,
      healthChecks: boundedList(strictObject({ name: shortText, passed: boolean() })),
      startupMs: counter,
    }),
  },
  // Record 11: heartbeat proves the process is alive, not that work happens.
  "runtime.heartbeat": {
    scope: "session",
    origin: "sandbox",
    durability: "ephemeral",
    payload: strictObject({
      uptimeMs: counter,
      runtimeProcessAlive: boolean(),
      lastProgressAt: nullable(timestamp),
    }),
  },
  "run.queued": {
    scope: "run",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      commandId,
      instruction: strictObject({
        messageId,
        text: bodyText,
        attachments: boundedList(artifactRef),
      }),
      model: modelRecord,
      runtime: exactOptional(runtimeRecord),
      trigger: picklist([
        "initial",
        "follow_up",
        "queued_message",
        "review_feedback",
        "model_change",
        "retry",
        // Record 14: the person asked for the repository's checks against the
        // current code, with no prompt.
        "checks_requested",
      ]),
      continuesRunId: nullable(runId),
    }),
  },
  "run.started": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      baseSha: sha,
      branch: shortText,
      resumedFrom: nullable(checkpointId),
    }),
  },
  "run.paused": {
    scope: "run",
    origin: "either",
    durability: "durable",
    payload: strictObject({
      reason: picklist([
        "user_requested",
        "idle_stop",
        "no_progress",
        "model_failure",
        "approval_expired",
        "lifetime_ceiling",
      ]),
      detail: summaryText,
      modelFailure: exactOptional(modelFailure),
      checkpointId: nullable(checkpointId),
    }),
  },
  // Record 10: an unacknowledged external action is checked, never assumed failed.
  "run.interrupted": {
    scope: "run",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      reason: picklist([
        "sandbox_lost",
        "sandbox_failed",
        "sandbox_replaced",
        "bridge_timeout",
        "runtime_exited",
      ]),
      detail: summaryText,
      resumableFrom: nullable(checkpointId),
      externalActionsPending: boundedList(
        picklist(["push", "pull_request_update", "approved_action"]),
      ),
    }),
  },
  "run.verified": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({ summary: completionSummary, ...outcomeTail }),
  },
  // Also committed by the object in place of a `run.verified` it refuses for
  // want of passing required records (record 14's completion gate).
  "run.completed_with_warnings": {
    scope: "run",
    origin: "either",
    durability: "durable",
    payload: strictObject({
      summary: completionSummary,
      warnings: boundedList(strictObject({ text: summaryText, recommendedAction: summaryText })),
      ...outcomeTail,
    }),
  },
  // Record 14, "Done": the run changed no files, so no checks ran and it
  // claims nothing about verification.
  "run.completed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({ summary: completionSummary, ...outcomeTail }),
  },
  "run.blocked": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      summary: nullable(completionSummary),
      blockedOn: variant("kind", [
        strictObject({ kind: literal("question"), question: summaryText }),
        strictObject({ kind: literal("decision"), question: summaryText }),
        strictObject({ kind: literal("access"), resource: shortText }),
        strictObject({ kind: literal("dependency"), resource: shortText }),
        strictObject({ kind: literal("model_failure"), failure: modelFailure }),
      ]),
      ...outcomeTail,
    }),
  },
  "run.failed": {
    scope: "run",
    origin: "either",
    durability: "durable",
    payload: strictObject({
      stage: picklist([
        "provisioning",
        "execution",
        "implementation",
        "verification",
        "checkpoint",
        "external_action",
      ]),
      error: strictObject({ category: shortText, message: summaryText }),
      summary: nullable(completionSummary),
      ...outcomeTail,
    }),
  },
  "run.cancelled": {
    scope: "run",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      by: variant("kind", [
        strictObject({ kind: literal("user"), userId }),
        strictObject({ kind: literal("policy"), rule: shortText }),
        strictObject({ kind: literal("operator") }),
      ]),
      checkpointId: nullable(checkpointId),
      summary: nullable(completionSummary),
      ...outcomeTail,
    }),
  },
  "runtime.disconnected": {
    scope: "session",
    origin: "either",
    durability: "durable",
    payload: strictObject({
      reason: picklist([
        "runtime_exited",
        "runtime_crashed",
        "shutdown_requested",
        "connection_lost",
        "timeout",
        "generation_replaced",
        "boot_failed",
      ]),
      detail: summaryText,
      exitCode: nullable(number()),
      diagnostics: boundedList(artifactRef),
      expectReconnect: boolean(),
    }),
  },
});

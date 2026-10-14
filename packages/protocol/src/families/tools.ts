import { defineFamily } from "../define";
import {
  agentId,
  approvalId,
  artifactRef,
  boolean,
  boundedList,
  counter,
  exactOptional,
  inlineJson,
  literal,
  nullable,
  number,
  picklist,
  shortText,
  streamChunk,
  strictObject,
  summaryText,
  toolCallId,
  variant,
} from "../schema";

// Record 12, "Tool use", plus the structured policy tool from record 07.
export const toolCategory = picklist([
  "file_read",
  "file_write",
  "search",
  "shell",
  "git_local",
  "git_remote",
  "browser",
  "web",
  "verification",
  "artifact",
  "policy_propose",
  "other",
]);

// Record 04: `incomplete` is the state for large output that failed to upload,
// and it has no artifact field to claim one.
export const toolResult = variant("kind", [
  strictObject({ kind: literal("inline"), summary: summaryText, value: inlineJson }),
  strictObject({
    kind: literal("artifact"),
    summary: summaryText,
    artifact: artifactRef,
    truncated: boolean(),
  }),
  strictObject({ kind: literal("none"), summary: summaryText }),
  strictObject({ kind: literal("incomplete"), summary: summaryText, reason: summaryText }),
]);

// A subagent's call carries its `agentId` (record 12); absent is the primary
// agent's, which every older stored event is.
const byAgent = exactOptional(agentId);

export const TOOL_EVENTS = defineFamily("tools", {
  // While the runtime streams arguments `inputComplete` is false and a later
  // `tool.requested` for the same call replaces the input.
  "tool.requested": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      toolCallId,
      category: toolCategory,
      title: shortText,
      runtimeName: shortText,
      input: inlineJson,
      inputComplete: boolean(),
      approvalId: nullable(approvalId),
      agentId: byAgent,
    }),
  },
  "tool.started": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({ toolCallId, agentId: byAgent }),
  },
  "tool.output": {
    scope: "run",
    origin: "sandbox",
    durability: "ephemeral",
    payload: strictObject({
      toolCallId,
      chunkIndex: counter,
      stream: picklist(["stdout", "stderr", "terminal"]),
      text: streamChunk,
      droppedBytes: counter,
      agentId: byAgent,
    }),
  },
  "tool.completed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      toolCallId,
      durationMs: counter,
      exitCode: nullable(number()),
      result: toolResult,
      agentId: byAgent,
    }),
  },
  "tool.failed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      toolCallId,
      durationMs: counter,
      exitCode: nullable(number()),
      errorText: summaryText,
      category: picklist([
        "denied_by_policy",
        "approval_rejected",
        "approval_expired",
        "not_found",
        "timeout",
        "runtime_error",
        "network",
        "unknown",
      ]),
      evidence: boundedList(artifactRef),
      agentId: byAgent,
    }),
  },
});

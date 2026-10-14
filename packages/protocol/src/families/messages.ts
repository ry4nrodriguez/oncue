import { defineFamily } from "../define";
import {
  agentId,
  artifactRef,
  bodyText,
  boundedList,
  counter,
  exactOptional,
  literal,
  messageId,
  nullable,
  picklist,
  shortText,
  streamChunk,
  strictObject,
  summaryText,
  tokenUsage,
  toolCallId,
  untrustedText,
  variant,
} from "../schema";

export const messageRole = picklist(["assistant", "system"]);

export const codeLanguage = picklist([
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "python",
  "go",
  "rust",
  "bash",
  "shell",
  "sql",
  "yaml",
  "toml",
  "html",
  "css",
  "markdown",
  "diff",
  "text",
]);

// Record 04: raw hidden reasoning is never carried. `reasoning_summary` is the
// concise user-facing summary the runtime may provide. Tool state lives in the
// tools family, so a message only references a tool call by id.
export const messagePart = variant("type", [
  strictObject({ type: literal("text"), text: bodyText }),
  strictObject({
    type: literal("reasoning_summary"),
    text: summaryText,
    durationMs: exactOptional(counter),
  }),
  strictObject({ type: literal("tool_ref"), toolCallId }),
  strictObject({ type: literal("source_url"), url: shortText, title: untrustedText }),
  strictObject({
    type: literal("source_document"),
    path: shortText,
    title: shortText,
    excerpt: exactOptional(summaryText),
  }),
  strictObject({ type: literal("artifact_ref"), artifact: artifactRef }),
  strictObject({
    type: literal("code"),
    code: bodyText,
    language: codeLanguage,
    path: exactOptional(shortText),
  }),
  strictObject({ type: literal("step_start"), label: exactOptional(shortText) }),
]);

// Record 12, "Progress communication" boundaries.
export const progressPhase = picklist([
  "investigating",
  "root_cause_identified",
  "implementing",
  "approach_changed",
  "verifying",
  "needs_user",
  "finishing",
]);

// A subagent's message carries its `agentId` (record 12); absent is the
// primary agent's, which every older stored event is.
const byAgent = exactOptional(agentId);

export const MESSAGE_EVENTS = defineFamily("messages", {
  "message.started": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({ messageId, role: messageRole, agentId: byAgent }),
  },
  "message.delta": {
    scope: "run",
    origin: "sandbox",
    durability: "ephemeral",
    payload: strictObject({
      messageId,
      partIndex: counter,
      part: variant("type", [
        strictObject({ type: literal("text"), text: streamChunk }),
        strictObject({ type: literal("reasoning_summary"), text: streamChunk }),
      ]),
      agentId: byAgent,
    }),
  },
  // Carries the full parts array so a client that missed every delta is
  // correct after this one event.
  "message.completed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      messageId,
      role: messageRole,
      parts: boundedList(messagePart),
      stopReason: picklist(["end_turn", "tool_use", "cancelled", "error", "max_tokens"]),
      usage: nullable(tokenUsage),
      agentId: byAgent,
    }),
  },
  "status.updated": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      stepId: shortText,
      phase: progressPhase,
      label: shortText,
      description: exactOptional(summaryText),
      status: picklist(["active", "complete"]),
    }),
  },
});

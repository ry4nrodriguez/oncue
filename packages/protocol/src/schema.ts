// The only module in the repository that imports valibot. Everything else
// imports the subset below, so swapping the validator is a one-file change.
import {
  array,
  type BaseIssue,
  boolean,
  brand,
  check,
  exactOptional,
  type GenericSchema,
  getDotPath,
  type InferInput,
  type InferOutput,
  integer,
  isoTimestamp,
  literal,
  maxLength,
  minLength,
  minValue,
  nullable,
  number,
  picklist,
  pipe,
  record,
  regex,
  safeParse,
  strictObject,
  string,
  unknown,
  variant,
} from "valibot";
import { RUNTIME_IDS } from "./runtimes";

export type { GenericSchema, InferInput, InferOutput };
export {
  array,
  boolean,
  check,
  exactOptional,
  integer,
  literal,
  maxLength,
  minLength,
  minValue,
  nullable,
  number,
  picklist,
  pipe,
  record,
  safeParse,
  strictObject,
  string,
  unknown,
  variant,
};

export const LIMITS = {
  eventBytes: 256 * 1024,
  shortTextChars: 256,
  summaryTextChars: 4 * 1024,
  bodyTextChars: 32 * 1024,
  streamChunkChars: 16 * 1024,
  inlineTextChars: 64 * 1024,
  inlineJsonChars: 32 * 1024,
  listItems: 500,
  idChars: 128,
} as const;

function id<B extends string>(name: B) {
  return pipe(string(), minLength(1), maxLength(LIMITS.idChars), brand(name));
}

export const sessionId = id("SessionId");
export const runId = id("RunId");
export const eventId = id("EventId");
export const commandId = id("CommandId");
export const messageId = id("MessageId");
export const toolCallId = id("ToolCallId");
export const planId = id("PlanId");
export const approvalId = id("ApprovalId");
export const artifactId = id("ArtifactId");
export const checkId = id("CheckId");
export const reviewItemId = id("ReviewItemId");
export const checkpointId = id("CheckpointId");
export const pushId = id("PushId");
export const proposalId = id("ProposalId");
export const questionId = id("QuestionId");
export const userId = id("UserId");
export const agentId = id("AgentId");

export type SessionId = InferOutput<typeof sessionId>;
export type RunId = InferOutput<typeof runId>;
export type EventId = InferOutput<typeof eventId>;
export type CommandId = InferOutput<typeof commandId>;
export type MessageId = InferOutput<typeof messageId>;
export type ToolCallId = InferOutput<typeof toolCallId>;
export type PlanId = InferOutput<typeof planId>;
export type ApprovalId = InferOutput<typeof approvalId>;
export type ArtifactId = InferOutput<typeof artifactId>;
export type CheckId = InferOutput<typeof checkId>;
export type ReviewItemId = InferOutput<typeof reviewItemId>;
export type CheckpointId = InferOutput<typeof checkpointId>;
export type PushId = InferOutput<typeof pushId>;
export type ProposalId = InferOutput<typeof proposalId>;
export type QuestionId = InferOutput<typeof questionId>;
export type UserId = InferOutput<typeof userId>;
export type AgentId = InferOutput<typeof agentId>;

// Text authored outside OnCue (GitHub comments, external actors). Record 16:
// it never gains authority, so it cannot be passed where a plain string is.
export const untrustedText = pipe(
  string(),
  maxLength(LIMITS.bodyTextChars),
  brand("UntrustedText"),
);
export type UntrustedText = InferOutput<typeof untrustedText>;

export const timestamp = pipe(string(), isoTimestamp());
export type Timestamp = InferOutput<typeof timestamp>;

export const counter = pipe(number(), integer(), minValue(0));
export const sha = pipe(string(), regex(/^[0-9a-f]{7,64}$/));
export const sha256Hex = pipe(string(), regex(/^[0-9a-f]{64}$/));
export const shortText = pipe(string(), maxLength(LIMITS.shortTextChars));
export const summaryText = pipe(string(), maxLength(LIMITS.summaryTextChars));
export const bodyText = pipe(string(), maxLength(LIMITS.bodyTextChars));
export const streamChunk = pipe(string(), maxLength(LIMITS.streamChunkChars));
export const inlineText = pipe(string(), maxLength(LIMITS.inlineTextChars));

export function boundedList<S extends GenericSchema>(item: S) {
  return pipe(array(item), maxLength(LIMITS.listItems));
}

export const inlineJson = pipe(
  record(string(), unknown()),
  check((value) => JSON.stringify(value).length <= LIMITS.inlineJsonChars, "inline_json_too_large"),
);
export type InlineJson = InferOutput<typeof inlineJson>;

export const artifactKind = picklist([
  "log",
  "screenshot",
  "recording",
  "patch",
  "bundle",
  "report",
  "diff",
  "tool_output",
  "file",
]);

// No R2 object key. Record 03: the key organizes data and is not an
// authorization mechanism, so the browser gets an authorized URL instead.
export const artifactRef = strictObject({
  artifactId,
  kind: artifactKind,
  contentType: shortText,
  byteSize: counter,
  label: shortText,
});
export type ArtifactRef = InferOutput<typeof artifactRef>;

export const fileChange = strictObject({
  path: pipe(string(), minLength(1), maxLength(4096)),
  status: picklist(["added", "modified", "deleted", "renamed"]),
  previousPath: exactOptional(pipe(string(), minLength(1), maxLength(4096))),
  additions: counter,
  deletions: counter,
});
export type FileChange = InferOutput<typeof fileChange>;

/**
 * Tokens by kind, each counted once: `inputTokens` is the uncached input,
 * `cachedInputTokens` the input read from the provider's prompt cache,
 * `cacheWriteTokens` the input written to it, and `outputTokens` excludes
 * `reasoningTokens`.
 */
export const tokenCounts = strictObject({
  inputTokens: counter,
  outputTokens: counter,
  cachedInputTokens: counter,
  cacheWriteTokens: counter,
  reasoningTokens: counter,
});
export type TokenCounts = InferOutput<typeof tokenCounts>;

/**
 * What the last call's prompt held besides the conversation, counted exactly
 * by the provider's own token counter (`docs/decisions.md`): the system
 * prompt, the harness's own tools, and OnCue's tools. The conversation is the
 * rest of `usedTokens`.
 */
export const promptTokens = strictObject({
  systemTokens: counter,
  toolsTokens: counter,
  oncueToolsTokens: counter,
});
export type PromptTokens = InferOutput<typeof promptTokens>;

// `usedTokens` is the conversation's size after this message: the last model
// call's whole input (uncached, cache read, cache write) plus what it wrote
// (`docs/decisions.md`). The optional fields split it the way `tokenCounts`
// does; `spent` sums every call the message accounts for, and is absent when
// that is exactly the last call. An event from before the split carries
// `usedTokens` as input plus output and no cache fields.
export const tokenUsage = strictObject({
  usedTokens: counter,
  maxTokens: counter,
  inputTokens: exactOptional(counter),
  outputTokens: exactOptional(counter),
  cachedInputTokens: exactOptional(counter),
  cacheWriteTokens: exactOptional(counter),
  reasoningTokens: exactOptional(counter),
  spent: exactOptional(tokenCounts),
  // Absent until the broker has counted the prompt, and for a provider it cannot count.
  prompt: exactOptional(promptTokens),
  // Why `prompt` is absent for a call the broker counts: still counting, or not countable for now.
  promptStatus: exactOptional(picklist(["pending", "unavailable"])),
  // The size at which the harness compacts on its own, where its rule is known.
  compactsAtTokens: exactOptional(counter),
});
export type TokenUsage = InferOutput<typeof tokenUsage>;

/**
 * Every effort level any provider documents, in ascending order of spend
 * (Anthropic's `output_config.effort`, OpenAI's `reasoning.effort`). A model
 * offers a subset; the Worker's catalog says which.
 */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const effortLevel = picklist(EFFORT_LEVELS);

// Record 15: recorded at run start, never the credential. `effort` is `null`
// for a model with no effort parameter, and absent on older stored
// `run.queued` events, which readers treat as `null`.
export const modelRecord = strictObject({
  provider: shortText,
  modelId: shortText,
  modelConnectionId: shortText,
  authenticationType: picklist(["api_key", "subscription"]),
  contextWindow: nullable(counter),
  effort: exactOptional(nullable(effortLevel)),
});
export type ModelRecord = InferOutput<typeof modelRecord>;

// Record 15: which harness ran the run and the version the image pinned when
// it was queued. Absent on older stored `run.queued` events, which read as
// OpenCode.
export const runtimeRecord = strictObject({
  id: picklist(RUNTIME_IDS),
  version: shortText,
});
export type RuntimeRecord = InferOutput<typeof runtimeRecord>;

export type ParseFailureReason =
  | "malformed_json"
  | "too_large"
  | "envelope"
  | "unsupported_version"
  | "unknown_type"
  | "wrong_origin"
  | "missing_run_id"
  | "unexpected_run_id"
  | "missing_runtime_sequence"
  | "unexpected_runtime_sequence"
  | "ephemeral"
  | "payload";

export type ParseFailure = {
  readonly ok: false;
  readonly reason: ParseFailureReason;
  readonly detail: string;
};

export type ParseResult<T> = { readonly ok: true; readonly value: T } | ParseFailure;

// Detail carries the field path and the schema's expectation, never the
// received value, so a rejection log cannot leak a payload.
export function toFailure(
  reason: ParseFailureReason,
  issues: readonly BaseIssue<unknown>[] | string,
  prefix = "",
): ParseFailure {
  if (typeof issues === "string") {
    return { ok: false, reason, detail: issues };
  }
  const detail = issues
    .map((issue) => {
      const path = getDotPath(issue) ?? "";
      const where = prefix && path ? `${prefix}.${path}` : prefix || path || "$";
      return `${where}: expected ${issue.expected ?? issue.type}`;
    })
    .join("; ");
  return { ok: false, reason, detail };
}

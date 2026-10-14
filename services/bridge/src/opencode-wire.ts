/**
 * OpenCode 1.18.30's SSE JSON to `RuntimeEvent`; the only file that knows the
 * wire. It follows the recording (`fixtures/opencode-session-recorded.jsonl`)
 * where it differs from the OpenAPI document:
 *
 * - Text streams as `message.part.delta`; `message.part.updated` arrives once
 *   with empty text when a text part opens and once with the whole text when
 *   it closes. Reasoning deltas share the kind and differ only by `partID`.
 * - `message.updated` fires for the user's own message too, before its parts.
 * - A tool part goes pending, running (repeated), completed; no `error` status
 *   appeared, and an aborted bash call ends `completed` with `exit: null`
 *   after `session.error`.
 *
 * Total: an unrecognised kind, or a known kind that fails validation, is
 * `unknown`; a kind in `HOMELESS_KINDS` is `homeless`; nothing throws.
 */

import { LIMITS } from "@oncue/protocol";
import type { CallUsage, RuntimeEvent, TodoItem, ToolPart, ToolStatus } from "./normalize";
import { boundQuestions } from "./questions";

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Rec;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Known and deliberately not mapped, so the debug channel carries only kinds
 * nobody has seen. Entries ending in `.` are prefixes; part types are listed
 * as `message.part.updated/<type>`.
 */
export const HOMELESS_KINDS: readonly string[] = [
  "session.status",
  "session.updated",
  "session.deleted",
  "session.compacted",
  "session.next.",
  "message.removed",
  "message.part.removed",
  "message.part.updated/step-start",
  "message.part.updated/file",
  "message.part.updated/patch",
  "message.part.updated/snapshot",
  "message.part.updated/agent",
  "message.part.updated/subtask",
  "message.part.updated/retry",
  "message.part.updated/compaction",
  "command.executed",
  // A `permission.asked`, `permission.replied`, or `question.asked` without the id it names is dropped.
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  // A `question.asked` with no readable question is dropped.
  "question.asked",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  "models-dev.refreshed",
  "installation.",
  "plugin.added",
  "catalog.updated",
  "reference.updated",
  "integration.",
  "project.",
  "global.disposed",
  "server.heartbeat",
  "server.instance.disposed",
  "vcs.",
  "lsp.",
  "file.watcher.",
  "pty.",
  "tui.",
  "workspace.",
  "worktree.",
];

export function isHomeless(wireKind: string): boolean {
  return HOMELESS_KINDS.some((entry) =>
    entry.endsWith(".") ? wireKind.startsWith(entry) : wireKind === entry,
  );
}

/** Bytes of an unknown event's JSON kept for the debug line. The rest is counted as `droppedBytes`. */
export const UNKNOWN_RAW_CAP_BYTES = 2048;

function unknown(wireKind: string, raw: unknown): RuntimeEvent {
  let text: string;
  try {
    text = JSON.stringify(raw) ?? "";
  } catch {
    text = "";
  }
  return { kind: "unknown", wireKind, raw: text.slice(0, UNKNOWN_RAW_CAP_BYTES) };
}

function homeless(wireKind: string): RuntimeEvent {
  return { kind: "homeless", wireKind };
}

const TOOL_STATUSES: readonly ToolStatus[] = ["pending", "running", "completed", "error"];

function isToolStatus(value: unknown): value is ToolStatus {
  return typeof value === "string" && (TOOL_STATUSES as readonly string[]).includes(value);
}

/**
 * `state.input` kept as a JSON object (the protocol's `inlineJson` is a
 * record, not a string) and replaced by a preview when it would not fit.
 */
function boundedInput(input: unknown): Readonly<Record<string, unknown>> {
  const record = asRecord(input) ?? {};
  let text: string;
  try {
    text = JSON.stringify(record) ?? "{}";
  } catch {
    return { truncated: true, preview: "" };
  }
  if (text.length <= LIMITS.inlineJsonChars) {
    return record;
  }
  return { truncated: true, preview: text.slice(0, Math.floor(LIMITS.inlineJsonChars / 2)) };
}

/**
 * `state.status` -> `ToolPart.status`; `state.input` bounded; `state.output` /
 * `state.error` as text; `state.metadata.exit` -> `exitCode` when it is a
 * number; `time.start` / `time.end` -> the `*AtMs` fields.
 */
export function parseToolPart(part: unknown): ToolPart | null {
  const record = asRecord(part);
  if (record === null) {
    return null;
  }
  const callId = str(record.callID);
  const tool = str(record.tool);
  const state = asRecord(record.state);
  if (callId === null || tool === null || state === null || !isToolStatus(state.status)) {
    return null;
  }
  const time = asRecord(state.time);
  const metadata = asRecord(state.metadata);
  // A `task` call names the subagent it started once it has one.
  const child = str(metadata?.sessionId);
  return {
    callId,
    tool,
    status: state.status,
    title: str(state.title),
    input: boundedInput(state.input),
    output: str(state.output),
    error: str(state.error),
    exitCode: num(metadata?.exit),
    startedAtMs: num(time?.start),
    endedAtMs: num(time?.end),
    ...(child === null ? {} : { childSessionId: child }),
  };
}

/**
 * `message.part.updated` to the event for its part type: tool, whole text,
 * reasoning (with ids, so its deltas can be dropped), or step-finish; any other
 * part type is `homeless`.
 */
export function parsePart(part: unknown): RuntimeEvent {
  const record = asRecord(part);
  const type = str(record?.type);
  if (record === null || type === null) {
    return unknown("message.part.updated", part);
  }
  const wireKind = `message.part.updated/${type}`;
  const messageId = str(record.messageID);
  const partId = str(record.id);
  if (messageId === null || partId === null) {
    return unknown(wireKind, part);
  }
  switch (type) {
    case "text": {
      const text = str(record.text);
      if (text === null) {
        return unknown(wireKind, part);
      }
      return { kind: "text_part", messageId, partId, text };
    }
    case "reasoning":
      return { kind: "reasoning", messageId, partId };
    case "tool": {
      const parsed = parseToolPart(record);
      return parsed === null
        ? unknown(wireKind, part)
        : { kind: "tool_part", messageId, part: parsed };
    }
    case "step-finish":
      return {
        kind: "step_finished",
        messageId,
        reason: str(record.reason) ?? "unknown",
        usage: usageOf(record.tokens),
      };
    default:
      return isHomeless(wireKind) ? homeless(wireKind) : unknown(wireKind, part);
  }
}

/**
 * `message.part.delta` to `text_delta`. Only `field: "text"` has been seen, for
 * text and reasoning alike; any other field is `unknown` so a future OpenCode
 * that streams something else fails the replay test.
 */
function parsePartDelta(properties: Rec, raw: unknown): RuntimeEvent {
  const messageId = str(properties.messageID);
  const partId = str(properties.partID);
  const field = str(properties.field);
  const delta = str(properties.delta);
  if (messageId === null || partId === null || field === null || delta === null) {
    return unknown("message.part.delta", raw);
  }
  if (field !== "text") {
    return unknown(`message.part.delta/${field}`, raw);
  }
  return { kind: "text_delta", messageId, partId, text: delta };
}

/**
 * OpenCode's `tokens` for one model call, on a step-finish part and on an
 * assistant message (one call each in 1.18.30). It already counts each kind
 * once for every provider: `input` excludes `cache.read` and `cache.write`,
 * and `total` is the five summed, which is how the recorded session reads.
 */
function usageOf(raw: unknown): CallUsage | null {
  const tokens = asRecord(raw);
  const input = num(tokens?.input);
  const output = num(tokens?.output);
  if (input === null || output === null) {
    return null;
  }
  const cache = asRecord(tokens?.cache);
  return {
    input,
    output,
    reasoning: num(tokens?.reasoning) ?? 0,
    cacheRead: num(cache?.read) ?? 0,
    cacheWrite: num(cache?.write) ?? 0,
  };
}

function parseMessageUpdated(properties: Rec, raw: unknown): RuntimeEvent {
  const info = asRecord(properties.info);
  const messageId = str(info?.id);
  const role = str(info?.role);
  if (info === null || messageId === null || (role !== "assistant" && role !== "user")) {
    return unknown("message.updated", raw);
  }
  if (role === "user") {
    return { kind: "message_started", messageId, role: "user" };
  }
  const time = asRecord(info.time);
  if (num(time?.completed) === null) {
    return { kind: "message_started", messageId, role: "assistant" };
  }
  const error = asRecord(info.error);
  const errorName = str(error?.name);
  const errorData = asRecord(error?.data);
  return {
    kind: "message_completed",
    messageId,
    finish: str(info.finish),
    usage: usageOf(info.tokens),
    error:
      errorName === null
        ? null
        : { name: errorName, message: str(errorData?.message) ?? errorName },
  };
}

const TODO_STATUSES: readonly TodoItem["status"][] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

function parseTodos(properties: Rec, raw: unknown): RuntimeEvent {
  const todos = properties.todos;
  if (!Array.isArray(todos)) {
    return unknown("todo.updated", raw);
  }
  const items: TodoItem[] = [];
  for (const [index, entry] of todos.entries()) {
    const record = asRecord(entry);
    const content = str(record?.content);
    if (content === null) {
      return unknown("todo.updated", raw);
    }
    const status = str(record?.status);
    items.push({
      // OpenCode's todos carry no id; their position is their identity.
      id: `todo_${index + 1}`,
      content,
      status:
        status !== null && (TODO_STATUSES as readonly string[]).includes(status)
          ? (status as TodoItem["status"])
          : "pending",
    });
  }
  return { kind: "todos", items };
}

function parseSessionError(properties: Rec): RuntimeEvent {
  const error = asRecord(properties.error);
  const data = asRecord(error?.data);
  const name = str(error?.name) ?? "UnknownError";
  return {
    kind: "session_error",
    name,
    message: str(data?.message) ?? name,
    status: num(data?.statusCode),
  };
}

function parseSessionDiff(properties: Rec, raw: unknown): RuntimeEvent {
  const diff = properties.diff;
  if (!Array.isArray(diff)) {
    return unknown("session.diff", raw);
  }
  const files: {
    path: string;
    status: "added" | "modified" | "deleted";
    additions: number;
    deletions: number;
    patch: string;
  }[] = [];
  for (const entry of diff) {
    const record = asRecord(entry);
    const path = str(record?.file);
    if (record === null || path === null) {
      continue;
    }
    const status = str(record.status);
    files.push({
      path,
      status: status === "added" || status === "deleted" ? status : "modified",
      additions: Math.max(0, Math.floor(num(record.additions) ?? 0)),
      deletions: Math.max(0, Math.floor(num(record.deletions) ?? 0)),
      patch: str(record.patch) ?? "",
    });
  }
  return { kind: "session_diff", files };
}

/**
 * `session.created`. A subagent's conversation names its parent; its title is
 * "<description> (@<agent> subagent)" and `agent` is the subagent's name.
 */
function parseSessionCreated(properties: Rec, raw: unknown): RuntimeEvent {
  const info = asRecord(properties.info);
  const sessionId = str(info?.id) ?? str(properties.sessionID);
  if (info === null || sessionId === null) {
    return unknown("session.created", raw);
  }
  return {
    kind: "session_created",
    sessionId,
    parentId: str(info.parentID),
    title: str(info.title) ?? "",
    agent: str(info.agent),
  };
}

/**
 * OpenCode's question tool waiting on an answer: `{id, sessionID, questions:
 * [{question, header, options: [{label, description}], multiple?, custom?}],
 * tool?: {messageID, callID}}`. `custom` defaults to true (a typed answer).
 * Its questions carry no ids, so their position names them.
 */
function parseQuestionAsked(properties: Rec): RuntimeEvent {
  const requestId = str(properties.id);
  const raw = properties.questions;
  if (requestId === null || !Array.isArray(raw)) {
    return homeless("question.asked");
  }
  const questions = boundQuestions(
    raw.map((entry, index) => {
      const record = asRecord(entry) ?? {};
      return {
        id: `q${index + 1}`,
        header: record.header,
        text: record.question,
        options: record.options,
        multiple: record.multiple,
        allowOther: record.custom,
      };
    }),
  );
  if (questions === null) {
    return homeless("question.asked");
  }
  return {
    kind: "question_asked",
    requestId,
    callId: str(asRecord(properties.tool)?.callID),
    questions,
    askedCount: raw.length,
  };
}

/**
 * `GET /question`: every question OpenCode is waiting on, each in the shape
 * `question.asked` carries. An unreadable entry is left out. Never throws.
 */
export function parsePendingQuestions(raw: unknown): RuntimeEvent[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    const properties = asRecord(entry) ?? {};
    const event = parseQuestionAsked(properties);
    if (event.kind !== "question_asked") {
      return [];
    }
    // Tagged as the event stream tags it, so a subagent's question is told apart.
    const sessionId = str(properties.sessionID);
    return [sessionId === null ? event : { ...event, sessionId }];
  });
}

/**
 * One `data:` JSON object in, one domain event out, tagged with the
 * conversation it belongs to when the wire names one: every OpenCode event
 * about a conversation carries `properties.sessionID`, a subagent's included.
 * Never throws.
 */
export function parseServerEvent(raw: unknown): RuntimeEvent {
  const event = parseUntagged(raw);
  const sessionId = str(asRecord(asRecord(raw)?.properties)?.sessionID);
  return sessionId === null || event.kind === "session_created" ? event : { ...event, sessionId };
}

function parseUntagged(raw: unknown): RuntimeEvent {
  const record = asRecord(raw);
  const type = str(record?.type);
  if (record === null || type === null) {
    return unknown("", raw);
  }
  const properties = asRecord(record.properties) ?? {};
  switch (type) {
    case "server.connected":
      return { kind: "server_connected" };
    case "message.updated":
      return parseMessageUpdated(properties, raw);
    case "message.part.updated":
      return parsePart(properties.part);
    case "message.part.delta":
      return parsePartDelta(properties, raw);
    case "todo.updated":
      return parseTodos(properties, raw);
    case "session.idle":
      return { kind: "session_idle" };
    case "session.created":
      return parseSessionCreated(properties, raw);
    case "permission.asked": {
      // The permission's `metadata` is empty for a tool-server tool, so that
      // call's input comes from its tool part. An ask tied to no call (some
      // `external_directory` asks) still needs an answer, so it is kept.
      const requestId = str(properties.id);
      const permission = str(properties.permission);
      if (requestId === null || permission === null) {
        return homeless(type);
      }
      return {
        kind: "permission_asked",
        requestId,
        permission,
        callId: str(asRecord(properties.tool)?.callID),
        patterns: Array.isArray(properties.patterns)
          ? properties.patterns.filter((entry): entry is string => typeof entry === "string")
          : [],
        metadata: asRecord(properties.metadata) ?? {},
      };
    }
    case "permission.replied": {
      const requestId = str(properties.requestID);
      return requestId === null ? homeless(type) : { kind: "permission_replied", requestId };
    }
    case "question.asked":
      return parseQuestionAsked(properties);
    case "question.replied":
    case "question.rejected": {
      const requestId = str(properties.requestID);
      return requestId === null ? homeless(type) : { kind: "question_settled", requestId };
    }
    case "session.error":
      return parseSessionError(properties);
    case "session.diff":
      return parseSessionDiff(properties, raw);
    case "file.edited": {
      const path = str(properties.file);
      return path === null ? unknown(type, raw) : { kind: "file_edited", path };
    }
    default:
      return isHomeless(type) ? homeless(type) : unknown(type, raw);
  }
}

/**
 * Maps Claude Code's stream-json output to `RuntimeEvent`s; the only file that
 * knows its message shapes. The control protocol belongs to `claude-client.ts`.
 *
 * Provisional: built from the Agent SDK 0.3.283 type declarations and not yet
 * checked against a recorded session. It relies on these shapes:
 *
 * - With `--include-partial-messages`, text streams as `stream_event` lines
 *   carrying the Messages API's events.
 * - The `assistant` line carries the finished content; its `tool_use` blocks
 *   become running tool rows, and a later `user` line's `tool_result` settles them.
 * - `result` ends a turn; an abort (`terminal_reason` `aborted_*`) reads as
 *   OpenCode's abort does.
 * - A line with a `parent_tool_use_id` belongs to a subagent. The flags start
 *   none; one that appears anyway is shown as a tool row so a breach of record
 *   12's one-agent rule is visible.
 *
 * Total: an unknown or malformed line becomes `unknown`, a listed one
 * `homeless`; nothing throws.
 */

import { LIMITS } from "@oncue/protocol";
import type { RuntimeEvent, TodoItem, ToolPart } from "./normalize";

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const RAW_CHARS = 2_000;

/** One line of Claude Code's stdout, classified. */
export type ClaudeLine =
  | { readonly kind: "control_request"; readonly requestId: string; readonly request: Rec }
  | {
      readonly kind: "control_response";
      readonly requestId: string;
      readonly ok: boolean;
      readonly response: Rec;
      readonly error: string | null;
    }
  | { readonly kind: "control_cancel"; readonly requestId: string }
  | { readonly kind: "message"; readonly type: string; readonly record: Rec }
  | { readonly kind: "garbled"; readonly raw: string };

export function parseClaudeLine(line: string): ClaudeLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "garbled", raw: line.slice(0, RAW_CHARS) };
  }
  const record = asRecord(parsed);
  const type = str(record?.type);
  if (record === null || type === null) {
    return { kind: "garbled", raw: line.slice(0, RAW_CHARS) };
  }
  const garbled = (): ClaudeLine => ({ kind: "garbled", raw: line.slice(0, RAW_CHARS) });
  switch (type) {
    case "control_request": {
      const requestId = str(record.request_id);
      const request = asRecord(record.request);
      return requestId === null || request === null
        ? garbled()
        : { kind: "control_request", requestId, request };
    }
    case "control_response": {
      const response = asRecord(record.response);
      const requestId = str(response?.request_id);
      if (response === null || requestId === null) {
        return garbled();
      }
      const ok = response.subtype === "success";
      return {
        kind: "control_response",
        requestId,
        ok,
        response: asRecord(response.response) ?? {},
        error: ok ? null : (str(response.error) ?? "error"),
      };
    }
    case "control_cancel_request": {
      const requestId = str(record.request_id);
      return requestId === null ? garbled() : { kind: "control_cancel", requestId };
    }
    default:
      return { kind: "message", type, record };
  }
}

/**
 * Known and deliberately not mapped. `system/<subtype>` for system lines.
 * Listed so a test proves each is `homeless`, not `unknown`.
 */
export const CLAUDE_HOMELESS: readonly string[] = [
  "system/init",
  "system/status",
  "system/compact_boundary",
  "system/api_retry",
  "system/control_request_progress",
  "system/task_notification",
  "system/task_started",
  "system/task_updated",
  "system/task_progress",
  "system/permission_denied",
  "system/informational",
  "system/session_state_changed",
  "system/thinking_tokens",
  "system/notification",
  "system/commands_changed",
  "system/files_persisted",
  "system/memory_recall",
  "system/local_command_output",
  "system/hook_started",
  "system/hook_progress",
  "system/hook_response",
  "system/background_tasks_changed",
  "system/worker_shutting_down",
  "system/elicitation_complete",
  "system/model_refusal_fallback",
  "system/model_refusal_no_fallback",
  "system/mirror_error",
  "system/plugin_install",
  "tool_progress",
  "tool_use_summary",
  "auth_status",
  "rate_limit_event",
  "prompt_suggestion",
  "conversation_reset",
];

/** A `ToolPart` input, bounded the way `opencode-wire.ts` bounds one: keys kept, oversize values cut. */
function boundedInput(input: Rec): Readonly<Rec> {
  const text = JSON.stringify(input);
  if (text.length <= LIMITS.inlineJsonChars) {
    return input;
  }
  return { truncated: true, preview: text.slice(0, LIMITS.summaryTextChars) };
}

/** A `tool_result`'s content as text: a string as it is, text blocks joined, anything else left out. */
function resultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      const item = asRecord(block);
      return item?.type === "text" ? [str(item.text) ?? ""] : [];
    })
    .join("\n");
}

/** A row title a person can read: the command, the path, or the pattern, else the tool's name. */
function toolTitle(tool: string, input: Rec): string {
  return (
    str(input.command) ??
    str(input.file_path) ??
    str(input.path) ??
    str(input.pattern) ??
    str(input.url) ??
    tool
  );
}

const TODO_STATUS: Readonly<Record<string, TodoItem["status"]>> = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "completed",
};

/** `TodoWrite`'s list as the plan, the way OpenCode's todo list becomes one. */
function todosOf(input: Rec): readonly RuntimeEvent[] {
  if (!Array.isArray(input.todos)) {
    return [];
  }
  const items: TodoItem[] = [];
  input.todos.forEach((raw, index) => {
    const todo = asRecord(raw);
    const content = str(todo?.content);
    const status = TODO_STATUS[str(todo?.status) ?? ""];
    if (content !== null && status !== undefined) {
      items.push({ id: `todo-${index}`, content, status });
    }
  });
  return [{ kind: "todos", items }];
}

interface OpenTool {
  readonly tool: string;
  readonly title: string;
  readonly input: Readonly<Rec>;
  readonly messageId: string;
  readonly startedAtMs: number;
}

interface Streaming {
  readonly id: string;
  readonly inputTokens: number | null;
  /** Anthropic counts these apart from `input_tokens`. */
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  stopReason: string | null;
  outputTokens: number | null;
}

/** The mapping. Stateful: a stream's stop reason and token counts arrive on lines apart from its id. One per connection. */
export interface ClaudeEventMapper {
  events(type: string, record: Rec): readonly RuntimeEvent[];
}

export function createClaudeEventMapper(now: () => number = Date.now): ClaudeEventMapper {
  let streaming: Streaming | null = null;
  const streamed = new Set<string>();
  const started = new Set<string>();
  const tools = new Map<string, OpenTool>();

  function unknown(type: string, record: Rec): readonly RuntimeEvent[] {
    return [{ kind: "unknown", wireKind: type, raw: JSON.stringify(record).slice(0, RAW_CHARS) }];
  }

  function streamEvent(event: Rec): readonly RuntimeEvent[] | null {
    const type = str(event.type);
    switch (type) {
      case "message_start": {
        const message = asRecord(event.message);
        const id = str(message?.id);
        if (id === null) {
          return null;
        }
        const usage = asRecord(message?.usage);
        streaming = {
          id,
          inputTokens: num(usage?.input_tokens),
          cacheReadTokens: num(usage?.cache_read_input_tokens) ?? 0,
          cacheWriteTokens: num(usage?.cache_creation_input_tokens) ?? 0,
          stopReason: null,
          outputTokens: null,
        };
        started.add(id);
        return [{ kind: "message_started", messageId: id, role: "assistant" }];
      }
      case "content_block_start":
      case "content_block_delta": {
        const index = num(event.index);
        if (streaming === null || index === null) {
          return null;
        }
        const partId = `${streaming.id}-${index}`;
        const block = asRecord(event.content_block) ?? asRecord(event.delta);
        const blockType = str(block?.type);
        if (blockType === "text_delta") {
          const text = str(block?.text);
          if (text === null) {
            return null;
          }
          streamed.add(streaming.id);
          return [{ kind: "text_delta", messageId: streaming.id, partId, text }];
        }
        if (
          blockType === "thinking" ||
          blockType === "redacted_thinking" ||
          blockType === "thinking_delta" ||
          blockType === "signature_delta"
        ) {
          return [{ kind: "reasoning", messageId: streaming.id, partId }];
        }
        // A text block's start, a tool call's start, and its input as it
        // streams: the text arrives by delta, the call whole on `assistant`.
        return [{ kind: "homeless", wireKind: `stream_event/${type}/${blockType ?? "none"}` }];
      }
      case "message_delta": {
        if (streaming === null) {
          return null;
        }
        streaming.stopReason = str(asRecord(event.delta)?.stop_reason) ?? streaming.stopReason;
        streaming.outputTokens =
          num(asRecord(event.usage)?.output_tokens) ?? streaming.outputTokens;
        return [{ kind: "homeless", wireKind: "stream_event/message_delta" }];
      }
      case "message_stop": {
        const ended = streaming;
        if (ended === null) {
          return null;
        }
        streaming = null;
        return [
          {
            kind: "message_completed",
            messageId: ended.id,
            finish: ended.stopReason,
            usage:
              ended.inputTokens === null || ended.outputTokens === null
                ? null
                : {
                    input: ended.inputTokens,
                    output: ended.outputTokens,
                    reasoning: 0,
                    cacheRead: ended.cacheReadTokens,
                    cacheWrite: ended.cacheWriteTokens,
                  },
            error: null,
          },
        ];
      }
      case "content_block_stop":
      case "ping":
        return [{ kind: "homeless", wireKind: `stream_event/${type}` }];
      default:
        return null;
    }
  }

  function subagentRow(record: Rec, parent: string): readonly RuntimeEvent[] {
    return [
      {
        kind: "tool_part",
        messageId: parent,
        part: {
          callId: parent,
          tool: "Task",
          status: "running",
          title: "A subagent, which OnCue's configuration turns off",
          input: {},
          output: null,
          error: null,
          exitCode: null,
          startedAtMs: null,
          endedAtMs: null,
        },
      },
      { kind: "homeless", wireKind: `subagent/${str(record.type) ?? "line"}` },
    ];
  }

  function assistant(record: Rec): readonly RuntimeEvent[] | null {
    const message = asRecord(record.message);
    const id = str(message?.id);
    if (message === null || id === null || !Array.isArray(message.content)) {
      return null;
    }
    const events: RuntimeEvent[] = [];
    if (!started.has(id)) {
      started.add(id);
      events.push({ kind: "message_started", messageId: id, role: "assistant" });
    }
    message.content.forEach((raw, index) => {
      const block = asRecord(raw);
      switch (block?.type) {
        case "text":
          // Streamed already by delta; otherwise the block is the text, whole.
          if (!streamed.has(id)) {
            events.push({
              kind: "text_part",
              messageId: id,
              partId: `${id}-a${index}`,
              text: str(block.text) ?? "",
            });
          }
          return;
        case "tool_use": {
          const callId = str(block.id);
          const tool = str(block.name);
          if (callId === null || tool === null) {
            return;
          }
          const input = asRecord(block.input) ?? {};
          const open: OpenTool = {
            tool,
            title: toolTitle(tool, input),
            input: boundedInput(input),
            messageId: id,
            startedAtMs: now(),
          };
          tools.set(callId, open);
          events.push({ kind: "tool_part", messageId: id, part: partOf(callId, open, null) });
          if (tool === "TodoWrite") {
            events.push(...todosOf(input));
          }
          return;
        }
        case "thinking":
        case "redacted_thinking":
          events.push({ kind: "reasoning", messageId: id, partId: `${id}-a${index}` });
          return;
        default:
          return;
      }
    });
    return events.length === 0 ? [{ kind: "homeless", wireKind: "assistant/empty" }] : events;
  }

  function user(record: Rec): readonly RuntimeEvent[] | null {
    const message = asRecord(record.message);
    if (message === null) {
      return null;
    }
    if (!Array.isArray(message.content)) {
      // The person's own words echoed back: already on the timeline.
      return [{ kind: "homeless", wireKind: "user/text" }];
    }
    const events: RuntimeEvent[] = [];
    for (const raw of message.content) {
      const block = asRecord(raw);
      if (block?.type !== "tool_result") {
        continue;
      }
      const callId = str(block.tool_use_id);
      const open = callId === null ? undefined : tools.get(callId);
      if (callId === null || open === undefined) {
        continue;
      }
      tools.delete(callId);
      const text = resultText(block.content);
      const settled =
        block.is_error === true ? { error: text || "the tool failed" } : { output: text };
      events.push({
        kind: "tool_part",
        messageId: open.messageId,
        part: partOf(callId, open, settled),
      });
    }
    return events.length === 0 ? [{ kind: "homeless", wireKind: "user/other" }] : events;
  }

  function partOf(
    callId: string,
    open: OpenTool,
    settled: { readonly output: string } | { readonly error: string } | null,
  ): ToolPart {
    const base = {
      callId,
      tool: open.tool,
      title: open.title,
      input: open.input,
      exitCode: null,
      startedAtMs: open.startedAtMs,
    };
    if (settled === null) {
      return { ...base, status: "running", output: null, error: null, endedAtMs: null };
    }
    if ("error" in settled) {
      return { ...base, status: "error", output: null, error: settled.error, endedAtMs: now() };
    }
    return { ...base, status: "completed", output: settled.output, error: null, endedAtMs: now() };
  }

  function result(record: Rec): readonly RuntimeEvent[] {
    streaming = null;
    const subtype = str(record.subtype);
    const terminal = str(record.terminal_reason) ?? "";
    if (subtype === "success" && record.is_error !== true) {
      return [{ kind: "session_idle" }];
    }
    if (terminal.startsWith("aborted")) {
      // OpenCode's abort looks the same to the reducer: the error first, then idle.
      return [
        {
          kind: "session_error",
          name: "MessageAbortedError",
          message: "the turn was interrupted",
          status: null,
        },
        { kind: "session_idle" },
      ];
    }
    const errors = Array.isArray(record.errors)
      ? record.errors.filter((entry): entry is string => typeof entry === "string")
      : [];
    const message =
      errors.join("; ") || str(record.result) || `the turn ended ${subtype ?? "without a result"}`;
    return [
      {
        kind: "session_error",
        name: "ClaudeTurnFailed",
        message: message.slice(0, LIMITS.summaryTextChars),
        status: num(record.api_error_status),
      },
      { kind: "session_idle" },
    ];
  }

  return {
    events(type, record) {
      const parent = str(record.parent_tool_use_id);
      if (parent !== null && (type === "assistant" || type === "user" || type === "stream_event")) {
        return subagentRow(record, parent);
      }
      let mapped: readonly RuntimeEvent[] | null;
      switch (type) {
        case "stream_event": {
          const event = asRecord(record.event);
          mapped = event === null ? null : streamEvent(event);
          break;
        }
        case "assistant":
          mapped = assistant(record);
          break;
        case "user":
          mapped = user(record);
          break;
        case "result":
          mapped = result(record);
          break;
        case "system": {
          const key = `system/${str(record.subtype) ?? ""}`;
          mapped = CLAUDE_HOMELESS.includes(key) ? [{ kind: "homeless", wireKind: key }] : null;
          return mapped ?? unknown(key, record);
        }
        default:
          mapped = CLAUDE_HOMELESS.includes(type) ? [{ kind: "homeless", wireKind: type }] : null;
      }
      return mapped ?? unknown(type, record);
    },
  };
}

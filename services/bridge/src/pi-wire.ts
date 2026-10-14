/**
 * Pi's RPC stdout to `RuntimeEvent`; the only file that knows Pi's record
 * shapes. Built from Pi 0.87.1's documentation and tested against records
 * transcribed from it (`fixtures/pi-rpc-docs-derived.jsonl`); not yet checked
 * against a live Pi.
 *
 * Pi's messages carry no id, so the mapper numbers assistant messages and names
 * blocks by `contentIndex`. `text_end`'s text replaces what the deltas built.
 * Tool rows come from `tool_execution_*`, not the model's `toolcall_*` blocks.
 * Only `agent_settled` means Pi will not continue on its own (`agent_end` can
 * be followed by a retry), so a failed message is reported as the session's
 * error only if Pi settles without recovering.
 *
 * Total: an unrecognised or invalid type is `unknown`, one in `PI_HOMELESS` is
 * `homeless`, and nothing throws.
 */

import { LIMITS } from "@oncue/protocol";
import type { CallUsage, RuntimeEvent, ToolPart } from "./normalize";

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

/** One line of Pi's stdout, classified. */
export type PiMessage =
  | {
      readonly kind: "response";
      /** Absent on a parse failure, which answers no request. */
      readonly id: string | null;
      readonly command: string;
      readonly success: boolean;
      readonly data: unknown;
      readonly error: string | null;
    }
  | {
      readonly kind: "ui_request";
      readonly id: string;
      readonly method: string;
      readonly record: Rec;
    }
  | { readonly kind: "event"; readonly type: string; readonly record: Rec }
  | { readonly kind: "garbled"; readonly raw: string };

export function parsePiLine(line: string): PiMessage {
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
  if (type === "response") {
    return {
      kind: "response",
      id: str(record.id),
      command: str(record.command) ?? "",
      success: record.success === true,
      data: record.data,
      error: str(record.error),
    };
  }
  if (type === "extension_ui_request") {
    const id = str(record.id);
    const method = str(record.method);
    return id === null || method === null
      ? { kind: "garbled", raw: line.slice(0, RAW_CHARS) }
      : { kind: "ui_request", id, method, record };
  }
  return { kind: "event", type, record };
}

// Known and deliberately not mapped, so the debug channel carries only types
// nobody has seen.
export const PI_HOMELESS: readonly string[] = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "tool_execution_update",
  "queue_update",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
];

/** A `ToolPart` input, bounded the way `opencode-wire.ts` bounds one: keys kept, oversize values cut. */
function boundedInput(input: Rec): Readonly<Rec> {
  const text = JSON.stringify(input);
  if (text.length <= LIMITS.inlineJsonChars) {
    return input;
  }
  return { truncated: true, preview: text.slice(0, LIMITS.summaryTextChars) };
}

/** A tool result's text blocks, joined. Images are not text and are left out. */
function resultText(result: unknown): string {
  const content = asRecord(result)?.content;
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

/** A row title a person can read: the command for `bash`, the path for a file tool, else the tool's name. */
function toolTitle(tool: string, args: Rec): string {
  return str(args.command) ?? str(args.path) ?? str(args.pattern) ?? tool;
}

interface OpenTool {
  readonly tool: string;
  readonly title: string;
  readonly input: Readonly<Rec>;
  readonly messageId: string;
  readonly startedAtMs: number;
}

interface Failure {
  readonly name: string;
  readonly message: string;
}

/** The session-level mapping. Stateful, because Pi's records carry no message ids. One per connection. */
export interface PiEventMapper {
  events(type: string, record: Rec): readonly RuntimeEvent[];
}

export function createPiEventMapper(now: () => number = Date.now): PiEventMapper {
  let counter = 0;
  let current: string | null = null;
  let lastAssistant: string | null = null;
  let failure: Failure | null = null;
  const tools = new Map<string, OpenTool>();

  function unknown(type: string, record: Rec): readonly RuntimeEvent[] {
    return [{ kind: "unknown", wireKind: type, raw: JSON.stringify(record).slice(0, RAW_CHARS) }];
  }

  function startAssistant(): string {
    counter += 1;
    const id = `pi-m${counter}`;
    current = id;
    lastAssistant = id;
    return id;
  }

  function messageStart(record: Rec): readonly RuntimeEvent[] | null {
    const role = str(asRecord(record.message)?.role);
    if (role === null) {
      return null;
    }
    if (role !== "assistant") {
      return [{ kind: "homeless", wireKind: `message_start/${role}` }];
    }
    // A new assistant message is Pi trying again or going on: whatever failed
    // before it is no longer where the run ends.
    failure = null;
    return [{ kind: "message_started", messageId: startAssistant(), role: "assistant" }];
  }

  function messageUpdate(record: Rec): readonly RuntimeEvent[] | null {
    const update = asRecord(record.assistantMessageEvent);
    const type = str(update?.type);
    if (update === null || type === null || current === null) {
      return null;
    }
    const index = num(update.contentIndex);
    const partId = index === null ? null : `${current}-${index}`;
    switch (type) {
      case "text_delta": {
        const delta = str(update.delta);
        return partId === null || delta === null
          ? null
          : [{ kind: "text_delta", messageId: current, partId, text: delta }];
      }
      case "text_end": {
        const content = str(update.content);
        return partId === null || content === null
          ? null
          : [{ kind: "text_part", messageId: current, partId, text: content }];
      }
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
        return partId === null ? null : [{ kind: "reasoning", messageId: current, partId }];
      default:
        // `start`, `text_start`, `toolcall_*`, `done`, `error`: the block's
        // text arrives by delta and `text_end`, a tool's row by its
        // execution, and the message's end by `message_end`.
        return [{ kind: "homeless", wireKind: `message_update/${type}` }];
    }
  }

  function messageEnd(record: Rec): readonly RuntimeEvent[] | null {
    const message = asRecord(record.message);
    const role = str(message?.role);
    if (message === null || role === null) {
      return null;
    }
    if (role !== "assistant") {
      return [{ kind: "homeless", wireKind: `message_end/${role}` }];
    }
    const messageId = current ?? startAssistant();
    current = null;
    const stopReason = str(message.stopReason);
    const usage = asRecord(message.usage);
    const input = num(usage?.input);
    const output = num(usage?.output);
    // pi-ai's Usage counts cache reads and writes apart from `input`.
    const tokens: CallUsage | null =
      input === null || output === null
        ? null
        : {
            input,
            output,
            reasoning: 0,
            cacheRead: num(usage?.cacheRead) ?? 0,
            cacheWrite: num(usage?.cacheWrite) ?? 0,
          };
    let error: Failure | null = null;
    if (stopReason === "aborted") {
      error = { name: "MessageAbortedError", message: "the turn was interrupted" };
    } else if (stopReason === "error") {
      error = {
        name: "PiTurnFailed",
        message: str(message.errorMessage) ?? "the model request failed",
      };
    }
    failure = error;
    return [
      {
        kind: "message_completed",
        messageId,
        finish: stopReason,
        usage: tokens,
        error,
      },
    ];
  }

  function toolStart(record: Rec): readonly RuntimeEvent[] | null {
    const callId = str(record.toolCallId);
    const tool = str(record.toolName);
    if (callId === null || tool === null) {
      return null;
    }
    const args = asRecord(record.args) ?? {};
    const open: OpenTool = {
      tool,
      title: toolTitle(tool, args),
      input: boundedInput(args),
      messageId: lastAssistant ?? callId,
      startedAtMs: now(),
    };
    tools.set(callId, open);
    return [{ kind: "tool_part", messageId: open.messageId, part: partOf(callId, open, null) }];
  }

  function toolEnd(record: Rec): readonly RuntimeEvent[] | null {
    const callId = str(record.toolCallId);
    const tool = str(record.toolName);
    if (callId === null || tool === null) {
      return null;
    }
    const args = asRecord(record.args) ?? {};
    const open = tools.get(callId) ?? {
      tool,
      title: toolTitle(tool, args),
      input: boundedInput(args),
      messageId: lastAssistant ?? callId,
      startedAtMs: now(),
    };
    tools.delete(callId);
    const text = resultText(record.result);
    const settled =
      record.isError === true ? { error: text || "the tool failed" } : { output: text };
    return [{ kind: "tool_part", messageId: open.messageId, part: partOf(callId, open, settled) }];
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

  function settled(): readonly RuntimeEvent[] {
    const ended = failure;
    failure = null;
    current = null;
    // OpenCode's failure looks the same to the reducer: the error first, then idle.
    return ended === null
      ? [{ kind: "session_idle" }]
      : [
          { kind: "session_error", name: ended.name, message: ended.message, status: null },
          { kind: "session_idle" },
        ];
  }

  return {
    events(type, record) {
      let mapped: readonly RuntimeEvent[] | null;
      switch (type) {
        case "message_start":
          mapped = messageStart(record);
          break;
        case "message_update":
          mapped = messageUpdate(record);
          break;
        case "message_end":
          mapped = messageEnd(record);
          break;
        case "tool_execution_start":
          mapped = toolStart(record);
          break;
        case "tool_execution_end":
          mapped = toolEnd(record);
          break;
        case "agent_settled":
          mapped = settled();
          break;
        default:
          mapped = PI_HOMELESS.includes(type) ? [{ kind: "homeless", wireKind: type }] : null;
      }
      return mapped ?? unknown(type, record);
    },
  };
}

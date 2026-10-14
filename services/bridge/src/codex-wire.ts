/**
 * Maps Codex app-server notifications to `RuntimeEvent`s; the only file that
 * knows their shapes. Built from the app-server's generated bindings and a
 * recording of the pinned Codex 0.157.1 against a scripted model
 * (`fixtures/codex-session-recorded.jsonl`); not yet checked against a real
 * model or the Linux build. The recording shows:
 *
 * - An agent message is one `agentMessage` item whose id is both message and
 *   part: `item/started` with empty text, a delta per chunk, `item/completed`
 *   with the whole text.
 * - A dynamic tool call's item starts before the `item/tool/call` request the
 *   bridge answers, with that request's `callId` as its id.
 * - A turn ends with `turn/completed`, whose `turn.status` says how.
 *
 * Total: an unknown or malformed method becomes `unknown`, a listed one
 * `homeless`; nothing throws.
 */

import { LIMITS } from "@oncue/protocol";
import type { CallUsage, RuntimeEvent, TodoItem, ToolPart, ToolStatus } from "./normalize";

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

/** A JSON-RPC request id: Codex's server requests start at 0, so 0 is an id like any other. */
export type RpcId = string | number;

/** One line from the app-server, classified. */
export type CodexMessage =
  | { readonly kind: "response"; readonly id: RpcId; readonly result: unknown }
  | { readonly kind: "error_response"; readonly id: RpcId; readonly message: string }
  | { readonly kind: "notification"; readonly method: string; readonly params: Rec }
  | {
      readonly kind: "server_request";
      readonly id: RpcId;
      readonly method: string;
      readonly params: Rec;
    }
  | { readonly kind: "garbled"; readonly raw: string };

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

const RAW_CHARS = 2_000;

export function parseCodexLine(line: string): CodexMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "garbled", raw: line.slice(0, RAW_CHARS) };
  }
  const message = asRecord(parsed);
  if (message === null) {
    return { kind: "garbled", raw: line.slice(0, RAW_CHARS) };
  }
  const method = str(message.method);
  const params = asRecord(message.params) ?? {};
  if (method !== null) {
    return isRpcId(message.id)
      ? { kind: "server_request", id: message.id, method, params }
      : { kind: "notification", method, params };
  }
  if (!isRpcId(message.id)) {
    return { kind: "garbled", raw: line.slice(0, RAW_CHARS) };
  }
  if ("error" in message) {
    return {
      kind: "error_response",
      id: message.id,
      message: str(asRecord(message.error)?.message) ?? "error",
    };
  }
  return { kind: "response", id: message.id, result: message.result };
}

/**
 * Known and deliberately not mapped. Listed so a test proves each is
 * `homeless`, not `unknown`, and so the debug channel carries only methods
 * nobody has seen. Entries ending in `/` are prefixes.
 */
export const CODEX_HOMELESS: readonly string[] = [
  "thread/started",
  "thread/status/changed",
  "thread/settings/updated",
  "thread/name/updated",
  "thread/compacted",
  "thread/closed",
  "thread/archived",
  "thread/unarchived",
  "thread/goal/",
  "thread/queue/changed",
  "turn/started",
  "account/",
  "remoteControl/",
  "mcpServer/",
  "skills/changed",
  "warning",
  "configWarning",
  "deprecationNotice",
  "guardianWarning",
  "model/",
  "hook/",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/",
  "item/autoApprovalReview/",
  "serverRequest/resolved",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "process/",
  "command/exec/outputDelta",
  "fs/changed",
  "error",
];

function isHomeless(method: string): boolean {
  return CODEX_HOMELESS.some((entry) =>
    entry.endsWith("/") ? method.startsWith(entry) : method === entry,
  );
}

/** A `ToolPart` input, bounded the way `opencode-wire.ts` bounds one: keys kept, oversize values cut. */
function boundedInput(input: Rec): Readonly<Rec> {
  const text = JSON.stringify(input);
  if (text.length <= LIMITS.inlineJsonChars) {
    return input;
  }
  return { truncated: true, preview: text.slice(0, LIMITS.summaryTextChars) };
}

const ITEM_STATUS: Readonly<Record<string, ToolStatus>> = {
  inProgress: "running",
  completed: "completed",
  failed: "error",
  declined: "error",
};

function toolPartOf(
  item: Rec,
  startedAtMs: number | null,
  endedAtMs: number | null,
): ToolPart | null {
  const id = str(item.id);
  const type = str(item.type);
  const status = ITEM_STATUS[str(item.status) ?? ""];
  if (id === null || type === null || status === undefined) {
    return null;
  }
  const settled = status !== "running";
  const base = {
    callId: id,
    status,
    startedAtMs,
    endedAtMs: settled ? endedAtMs : null,
  };
  switch (type) {
    case "commandExecution": {
      const command = str(item.command) ?? "";
      const output = str(item.aggregatedOutput);
      return {
        ...base,
        tool: "exec_command",
        title: command,
        input: boundedInput({ command, cwd: str(item.cwd) ?? "" }),
        output: settled ? (output ?? "") : null,
        error: status === "error" ? `command ${str(item.status)}` : null,
        exitCode: num(item.exitCode),
      };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.map(asRecord) : [];
      const paths = changes.flatMap((change) => {
        const path = str(change?.path);
        return path === null ? [] : [path];
      });
      return {
        ...base,
        tool: "apply_patch",
        title: paths.join(", "),
        input: boundedInput({ paths }),
        output: settled ? "" : null,
        error: status === "error" ? `patch ${str(item.status)}` : null,
        exitCode: null,
      };
    }
    case "mcpToolCall": {
      const server = str(item.server) ?? "mcp";
      const tool = str(item.tool) ?? "tool";
      const error = str(asRecord(item.error)?.message);
      return {
        ...base,
        tool: `mcp__${server}__${tool}`,
        title: tool,
        input: boundedInput(asRecord(item.arguments) ?? {}),
        output: settled ? JSON.stringify(item.result ?? null) : null,
        error: status === "error" ? (error ?? "the tool failed") : null,
        exitCode: null,
      };
    }
    case "dynamicToolCall": {
      const tool = str(item.tool) ?? "tool";
      const contents = Array.isArray(item.contentItems) ? item.contentItems.map(asRecord) : [];
      const text = contents
        .flatMap((content) => (content?.type === "inputText" ? [str(content.text) ?? ""] : []))
        .join("\n");
      const failed = status === "error" || item.success === false;
      return {
        ...base,
        status: settled && failed ? "error" : status,
        tool,
        title: tool,
        input: boundedInput(asRecord(item.arguments) ?? {}),
        output: settled ? text : null,
        error: settled && failed ? text || "the tool failed" : null,
        exitCode: null,
      };
    }
    case "webSearch":
      return {
        ...base,
        tool: "web_search",
        title: str(item.query) ?? "web search",
        input: boundedInput({ query: str(item.query) ?? "" }),
        output: settled ? "" : null,
        error: null,
        exitCode: null,
      };
    case "imageView":
      return {
        ...base,
        tool: "view_image",
        title: str(item.path) ?? "image",
        input: boundedInput({ path: str(item.path) ?? "" }),
        output: settled ? "" : null,
        error: null,
        exitCode: null,
      };
    default:
      return null;
  }
}

/** Item types with a timeline row of their own, beside messages and tools. */
const ITEMS_WITHOUT_ROWS = new Set([
  "userMessage",
  "hookPrompt",
  "plan",
  "contextCompaction",
  "enteredReviewMode",
  "exitedReviewMode",
  "functionCallOutput",
  "sleep",
]);

/**
 * Subagent items. The configuration turns subagents off (`multi_agent`); one
 * that appears anyway is shown as a tool row, never dropped, so a breach of
 * record 12's one-agent rule is visible.
 */
const SUBAGENT_ITEMS = new Set(["collabAgentToolCall", "subAgentActivity"]);

function itemEvents(params: Rec, phase: "started" | "completed"): readonly RuntimeEvent[] | null {
  const item = asRecord(params.item);
  const type = str(item?.type);
  const id = str(item?.id);
  if (item === null || type === null || id === null) {
    return null;
  }
  const startedAtMs = num(params.startedAtMs);
  const endedAtMs = num(params.completedAtMs);
  if (type === "agentMessage") {
    if (phase === "started") {
      return [{ kind: "message_started", messageId: id, role: "assistant" }];
    }
    return [
      { kind: "text_part", messageId: id, partId: id, text: str(item.text) ?? "" },
      // The call's tokens arrive next, on `thread/tokenUsage/updated`.
      {
        kind: "message_completed",
        messageId: id,
        finish: "stop",
        usage: null,
        error: null,
        usageFollows: true,
      },
    ];
  }
  if (type === "reasoning") {
    return [{ kind: "reasoning", messageId: id, partId: id }];
  }
  if (ITEMS_WITHOUT_ROWS.has(type)) {
    return [{ kind: "homeless", wireKind: `item/${phase}/${type}` }];
  }
  if (SUBAGENT_ITEMS.has(type)) {
    return [
      {
        kind: "tool_part",
        messageId: id,
        part: {
          callId: id,
          tool: type,
          status: phase === "started" ? "running" : "completed",
          title: "A subagent, which OnCue's configuration turns off",
          input: {},
          output: phase === "started" ? null : "",
          error: null,
          exitCode: null,
          startedAtMs,
          endedAtMs,
        },
      },
    ];
  }
  const part = toolPartOf(item, startedAtMs, endedAtMs);
  if (part === null) {
    return null;
  }
  return [{ kind: "tool_part", messageId: str(params.turnId) ?? id, part }];
}

const PLAN_STATUS: Readonly<Record<string, TodoItem["status"]>> = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed",
};

function planEvents(params: Rec): readonly RuntimeEvent[] | null {
  if (!Array.isArray(params.plan)) {
    return null;
  }
  const items: TodoItem[] = [];
  params.plan.forEach((raw, index) => {
    const step = asRecord(raw);
    const content = str(step?.step);
    const status = PLAN_STATUS[str(step?.status) ?? ""];
    if (content !== null && status !== undefined) {
      items.push({ id: `step-${index}`, content, status });
    }
  });
  return [{ kind: "todos", items }];
}

/**
 * `thread/tokenUsage/updated`'s `last`: the model call that just finished.
 * Codex counts the OpenAI way, with cached and cache-write tokens inside
 * `inputTokens` and reasoning inside `outputTokens`, so they are taken out to
 * count each kind once. `total` is the thread's running sum, which the
 * protocol rebuilds from the calls.
 */
function tokenUsageEvents(params: Rec): readonly RuntimeEvent[] | null {
  const last = asRecord(asRecord(params.tokenUsage)?.last);
  const input = num(last?.inputTokens);
  const output = num(last?.outputTokens);
  if (input === null || output === null) {
    return null;
  }
  const cacheRead = num(last?.cachedInputTokens) ?? 0;
  const cacheWrite = num(last?.cacheWriteInputTokens) ?? 0;
  const reasoning = num(last?.reasoningOutputTokens) ?? 0;
  const usage: CallUsage = {
    input: Math.max(0, input - cacheRead - cacheWrite),
    output: Math.max(0, output - reasoning),
    reasoning,
    cacheRead,
    cacheWrite,
  };
  return [{ kind: "usage_reported", usage }];
}

function turnCompletedEvents(params: Rec): readonly RuntimeEvent[] | null {
  const turn = asRecord(params.turn);
  const status = str(turn?.status);
  if (turn === null || status === null) {
    return null;
  }
  if (status === "completed") {
    return [{ kind: "session_idle" }];
  }
  if (status === "interrupted") {
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
  const error = asRecord(turn.error);
  return [
    {
      kind: "session_error",
      name: "CodexTurnFailed",
      message: str(error?.message) ?? `the turn ended ${status}`,
      status: null,
    },
    { kind: "session_idle" },
  ];
}

/**
 * One notification -> the events it means, in order. Server requests are the
 * client's (`codex-client.ts`); they carry no event of their own here.
 */
export function codexNotificationEvents(method: string, params: Rec): readonly RuntimeEvent[] {
  const unknown = (): readonly RuntimeEvent[] => [
    { kind: "unknown", wireKind: method, raw: JSON.stringify(params).slice(0, RAW_CHARS) },
  ];
  switch (method) {
    case "item/started":
      return itemEvents(params, "started") ?? unknown();
    case "item/completed":
      return itemEvents(params, "completed") ?? unknown();
    case "item/agentMessage/delta": {
      const itemId = str(params.itemId);
      const delta = str(params.delta);
      return itemId === null || delta === null
        ? unknown()
        : [{ kind: "text_delta", messageId: itemId, partId: itemId, text: delta }];
    }
    case "turn/plan/updated":
      return planEvents(params) ?? unknown();
    case "turn/diff/updated":
      // The diff itself is the bridge's own Git's, never the harness's report.
      return [{ kind: "session_diff", files: [] }];
    case "turn/completed":
      return turnCompletedEvents(params) ?? unknown();
    case "thread/tokenUsage/updated":
      // A report without `last` sizes nothing; it is known, so it is not debug output.
      return tokenUsageEvents(params) ?? [{ kind: "homeless", wireKind: method }];
    default:
      return isHomeless(method) ? [{ kind: "homeless", wireKind: method }] : unknown();
  }
}

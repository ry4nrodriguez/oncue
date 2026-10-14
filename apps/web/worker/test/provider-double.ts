// A double for the Anthropic and OpenAI HTTP APIs, used by unit tests and by
// local sessions so a test can force a 429 without spending money. Only the
// adapter's origin is swapped (`ONCUE_PROVIDER_DOUBLE_ORIGIN`, local only), so
// requests go through the same shaping code as production. A double replaces
// the provider and never covers for OnCue's own code.
//
// Failures use each provider's own error body and status, so `classify` sees
// realistic input; `"ok"` streams provider-shaped SSE ending in that
// provider's terminal event. Requests are recorded but never logged or
// printed, since headers carry credentials.

import { PROVIDER_ADAPTERS, type ProviderId } from "../broker/providers/adapter";
import { DEMO_EDIT_COMMAND, DEMO_PROSE } from "./demo-fixture";
import { subagentReply } from "./subagent-script";

export type DoubleMode =
  | "ok"
  /** Anthropic only: writes `EDIT_FILE_PATH` through `bash`, then answers in text, leaving a real edit. */
  | "edit_file"
  /**
   * Anthropic only: calls OnCue's `policy_propose` tool, under whatever name
   * the runtime offered it, for push and draft pull requests, then answers in
   * text. It calls only a tool the runtime really offered.
   */
  | "propose_push"
  /**
   * Anthropic only: calls OnCue's `secret_request` tool for
   * `REQUESTED_SECRET_NAME`, then answers in text. The runtime's own permission
   * gate holds the call; nothing here knows an approval exists.
   */
  | "request_secret"
  /**
   * Anthropic only: prints the supplied secret's file with `bash`, so a test
   * can see the bridge redact it. Tries the sandbox path, then the local one.
   */
  | "print_secret"
  /**
   * Anthropic only: reads a file outside the work tree that is not the secret,
   * so a test can see OpenCode's gate refuse it.
   */
  | "read_outside"
  /**
   * Anthropic only, for recordings and UI passes: edits the seeded repository
   * through `bash` and answers in real markdown. See `demo-fixture.ts`.
   */
  | "demo"
  /**
   * Anthropic only: a task naming "[agents:...]" makes the model start that many
   * subagents through OpenCode's `task` tool, side by side, and each subagent
   * does what its prompt says (`subagent-script.ts`).
   */
  | "subagents"
  /**
   * Anthropic only: calls the runtime's own `question` tool once per
   * conversation, with the set a marker in the task names
   * (`QUESTION_SETS`), then answers in text that repeats what the user said.
   * A run resumed with the answers as its message is answered the same way.
   */
  | "ask_question"
  | "rate_limited"
  | "usage_limit"
  | "auth_failed"
  /**
   * The key is good but the model request is refused as unauthorized, as for a
   * restricted key or an account without access to the model: the models list
   * still answers.
   */
  | "request_forbidden"
  | "model_unavailable"
  | "rejected"
  | "overloaded";

export interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** The effort the body named, so a test can prove the broker wrote it. */
  readonly effort: string | null;
  /** The tokens the answer reports, so a test can hold OnCue's figures to the provider's. */
  readonly usage: DoubleUsage;
  /** For a token count, what the body held and what the double answered. */
  readonly counted?: DoubleCount;
}

/** One `count_tokens` call: the shape of what was counted, never its text, and the answer. */
export interface DoubleCount {
  readonly hasSystem: boolean;
  /** Tool names, so a test can tell the harness's tools from OnCue's. */
  readonly toolNames: readonly string[];
  readonly messages: number;
  readonly inputTokens: number;
}

/** Anthropic's token counter's path. */
export const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";

/**
 * Anthropic's `count_tokens`, by a fixed rule: four characters a token over
 * the body's system, tools, and messages, plus three for the request's frame.
 * Deterministic so a test can recompute it; it is the provider's count, not
 * OnCue's, so nothing here knows what the broker does with it.
 */
export function doubleCountOf(body: Readonly<Record<string, unknown>>): number {
  return (
    3 +
    promptTokensOf(JSON.stringify(body.system ?? "")) +
    promptTokensOf(JSON.stringify(body.tools ?? [])) +
    promptTokensOf(JSON.stringify(body.messages ?? []))
  );
}

function countResponse(body: BodyInit | null | undefined): {
  readonly response: Response;
  readonly counted: DoubleCount | null;
} {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText(body) ?? "") as Record<string, unknown>;
  } catch {
    return {
      response: Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "bad body" } },
        { status: 400 },
      ),
      counted: null,
    };
  }
  const inputTokens = doubleCountOf(parsed);
  const tools = Array.isArray(parsed.tools) ? (parsed.tools as { name?: unknown }[]) : [];
  return {
    response: Response.json({ input_tokens: inputTokens }),
    counted: {
      hasSystem: parsed.system !== undefined,
      toolNames: tools.map((tool) => (typeof tool.name === "string" ? tool.name : "")),
      messages: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
      inputTokens,
    },
  };
}

/**
 * The tokens one answer reports, each kind counted once. Each provider's frames
 * write them its own way: Anthropic counts the cache apart from
 * `input_tokens`, OpenAI inside it.
 */
export interface DoubleUsage {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

/** Text a model is asked to read, at the rough rate of four characters a token. */
export function promptTokensOf(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * What a conversation's requests share: the system prompt and the first
 * message. A title request has its own system prompt, so it is its own conversation.
 */
function conversationKey(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const first = Array.isArray(parsed.messages)
      ? parsed.messages[0]
      : Array.isArray(parsed.input)
        ? parsed.input[0]
        : null;
    // A client moves its cache breakpoints as the conversation grows, so they are not part of it.
    return JSON.stringify(
      [parsed.system ?? parsed.instructions ?? null, first ?? null],
      (name, value) => (name === "cache_control" ? undefined : value),
    );
  } catch {
    return text.slice(0, 2_000);
  }
}

/**
 * The provider's prompt cache, roughly: a conversation's next request reads
 * back what the last one cached and writes the rest, except for the newest
 * couple of tokens, which is the shape the recorded OpenCode session shows.
 * OpenAI caches without writes being reported here.
 */
export function cachedUsage(
  cache: Map<string, number>,
  provider: ProviderId,
  body: BodyInit | null | undefined,
  output: number,
): DoubleUsage {
  const text = bodyText(body) ?? "";
  const prompt = promptTokensOf(text);
  const key = conversationKey(text);
  const before = cache.get(key) ?? 0;
  const cacheRead = before <= prompt - 2 ? before : 0;
  const uncachedTail = Math.min(2, prompt);
  if (provider === "openai") {
    cache.set(key, prompt - uncachedTail);
    return { input: prompt - cacheRead, cacheRead, cacheWrite: 0, output };
  }
  const cacheWrite = Math.max(0, prompt - uncachedTail - cacheRead);
  cache.set(key, cacheRead + cacheWrite);
  return { input: prompt - cacheRead - cacheWrite, cacheRead, cacheWrite, output };
}

/** Anthropic's `usage` on `message_start`: input apart from the cache. */
function anthropicStartUsage(usage: DoubleUsage): Record<string, number> {
  return {
    input_tokens: usage.input,
    cache_creation_input_tokens: usage.cacheWrite,
    cache_read_input_tokens: usage.cacheRead,
    output_tokens: 1,
  };
}

/** OpenAI's `usage` on `response.completed`: input including the cache. */
function openaiUsage(usage: DoubleUsage): Record<string, unknown> {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheRead },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + usage.output,
  };
}

export interface ProviderDouble {
  readonly fetchImpl: typeof fetch;
  setMode(mode: DoubleMode): void;
  /** What arrived, for header assertions. */
  readonly calls: readonly RecordedCall[];
  /** Lets a test lengthen the stream, for example to outlive a token. */
  setStreamPacing(chunkCount: number, gapMs: number): void;
}

export interface ProviderDoubleOptions {
  readonly chunkCount?: number;
  readonly gapMs?: number;
}

const DEFAULT_CHUNK_COUNT = 3;
const DEFAULT_GAP_MS = 5;

function bodyText(body: BodyInit | null | undefined): string | null {
  if (typeof body !== "string" && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
    return null;
  }
  return typeof body === "string"
    ? body
    : new TextDecoder().decode(body as ArrayBuffer | ArrayBufferView);
}

/**
 * A task holding this text is answered slowly. Keyed on the request, so one
 * session can be slow while another answers at once; a slow model is ordinary
 * provider behaviour.
 */
export const SLOW_REPLY_MARKER = "(take your time)";
export const SLOW_REPLY_CHUNKS = 100;
export const SLOW_REPLY_GAP_MS = 500;

/**
 * The effort a body names (`output_config.effort` on Anthropic,
 * `reasoning.effort` on OpenAI), or `null`. A level name, never secret.
 */
export function effortIn(body: BodyInit | null | undefined): string | null {
  const text = bodyText(body);
  if (text === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const container of ["output_config", "reasoning"]) {
      const value = parsed[container];
      if (typeof value === "object" && value !== null) {
        const effort = (value as Record<string, unknown>).effort;
        if (typeof effort === "string") {
          return effort;
        }
      }
    }
  } catch {
    // Not JSON: names nothing.
  }
  return null;
}

/**
 * How many image blocks a request carried (Anthropic's `image`, OpenAI's
 * `input_image`). A count, never the bytes.
 */
export function imageBlocksIn(body: BodyInit | null | undefined): number {
  if (typeof body !== "string" && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
    return 0;
  }
  const text =
    typeof body === "string"
      ? body
      : new TextDecoder().decode(body as ArrayBuffer | ArrayBufferView);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 0;
  }
  let count = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const type = (value as Record<string, unknown>).type;
    if (type === "image" || type === "input_image") {
      count += 1;
    }
    Object.values(value).forEach(visit);
  };
  visit(parsed);
  return count;
}

export function createProviderDouble(
  provider: ProviderId,
  mode: DoubleMode = "ok",
  options?: ProviderDoubleOptions,
): ProviderDouble {
  const calls: RecordedCall[] = [];
  let currentMode = mode;
  // Counts replies that carry tool calls, so two answered in one millisecond never share an id.
  let toolReplies = 0;
  let chunkCount = options?.chunkCount ?? DEFAULT_CHUNK_COUNT;
  let gapMs = options?.gapMs ?? DEFAULT_GAP_MS;

  const promptCache = new Map<string, number>();

  const fetchImpl: typeof fetch = async (input, init) => {
    if (provider === "anthropic" && resolveUrl(input).endsWith(COUNT_TOKENS_PATH)) {
      const answer = countResponse(init?.body);
      calls.push({
        url: resolveUrl(input),
        headers: headersToRecord(init?.headers),
        effort: null,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        ...(answer.counted === null ? {} : { counted: answer.counted }),
      });
      return answer.response;
    }
    const slow = bodyText(init?.body)?.includes(SLOW_REPLY_MARKER) === true;
    const owedOutput = slow ? SLOW_REPLY_CHUNKS : chunkCount;
    const usage = cachedUsage(promptCache, provider, init?.body, owedOutput);
    calls.push({
      url: resolveUrl(input),
      headers: headersToRecord(init?.headers),
      effort: effortIn(init?.body),
      usage,
    });
    // Codex calls the Responses API with its own tool names (`exec_command`,
    // `oncue_*`); each mode means the same as on Anthropic, judged on the
    // newest input item alone.
    const owed = openaiToolMode(currentMode);
    if (owed !== null) {
      const tool = offeredResponsesTool(provider, resolveUrl(input), init?.body, owed.suffix);
      if (tool !== null) {
        return new Response(streamBody(openaiToolCallFrames(tool, owed.args, usage), gapMs), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
    }
    // A task carrying a script marker gets that script's tool calls in turn,
    // whatever the mode, so lanes running side by side do not share a switch.
    const scripted = scriptedToolCalls(provider, resolveUrl(input), init?.body);
    if (scripted !== null) {
      return new Response(streamBody(anthropicToolUseTurnFrames(scripted), gapMs), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (currentMode === "propose_push") {
      const tool = offeredTool(provider, resolveUrl(input), init?.body, "policy_propose");
      if (tool !== null) {
        return new Response(
          streamBody(
            anthropicToolUseFrames(usage, "toolu_double_policy", tool, {
              push: "auto",
              pullRequest: "auto_after_verification",
              rationale: "The user asked to push this and open a draft pull request.",
            }),
            gapMs,
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
    }
    if (currentMode === "request_secret") {
      const tool = offeredTool(provider, resolveUrl(input), init?.body, "secret_request");
      if (tool !== null) {
        return new Response(
          streamBody(
            anthropicToolUseFrames(usage, "toolu_double_secret", tool, {
              name: REQUESTED_SECRET_NAME,
            }),
            gapMs,
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
    }
    if (
      currentMode === "read_outside" &&
      offeredTool(provider, resolveUrl(input), init?.body, "bash") !== null
    ) {
      return new Response(
        streamBody(
          anthropicToolUseFrames(usage, "toolu_double_outside", "bash", {
            command: "cat /etc/hostname",
            description: "Read a file outside the project",
          }),
          gapMs,
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (
      currentMode === "subagents" &&
      provider === "anthropic" &&
      resolveUrl(input).includes(PROVIDER_ADAPTERS.anthropic.requestPath)
    ) {
      const reply = subagentReply(bodyText(init?.body) ?? "");
      if (reply.kind === "fail") {
        return failureResponse(provider, "rejected");
      }
      if (reply.kind === "calls") {
        // Ids unique to this reply: no conversation repeats one, and two
        // subagents answered at the same instant must not share one either.
        toolReplies += 1;
        const stamp = `${Date.now()}_${toolReplies}`;
        const calls = reply.calls.map((call, index) => ({
          ...call,
          id: `toolu_double_${call.name}_${index}_${stamp}`,
        }));
        return new Response(streamBody(anthropicToolUseTurnFrames(calls), gapMs), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (reply.kind === "text_with") {
        return new Response(streamBody(anthropicProseFrames(reply.text, usage), gapMs), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
    }
    if (currentMode === "demo" && wantsToolCall(provider, resolveUrl(input), init?.body)) {
      return new Response(
        streamBody(
          anthropicToolUseFrames(usage, "toolu_double_demo", "bash", {
            command: DEMO_EDIT_COMMAND,
            description: "Add the retry budget and cover it with tests",
          }),
          gapMs,
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (currentMode === "edit_file" && wantsToolCall(provider, resolveUrl(input), init?.body)) {
      return new Response(streamBody(anthropicToolUseFrames(usage), gapMs), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    // Judged on the newest message alone, since a follow-up's history holds
    // earlier results. The path is the one the secret tool's answer named;
    // OpenCode asks before a read outside the project, and the bridge allows
    // only the secrets directory.
    if (
      currentMode === "print_secret" &&
      offeredTool(provider, resolveUrl(input), init?.body, "bash") !== null
    ) {
      return new Response(
        streamBody(
          anthropicToolUseFrames(usage, "toolu_double_print", "bash", {
            command: `cat ${secretPathIn(provider, resolveUrl(input), init?.body)}`,
            description: "Print the supplied secret",
          }),
          gapMs,
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (currentMode === "ask_question") {
      const turn = questionTurn(provider, resolveUrl(input), init?.body);
      if (turn !== null) {
        return new Response(
          streamBody(
            turn.kind === "ask"
              ? anthropicToolUseFrames(usage, "toolu_double_question", turn.tool, {
                  questions: turn.questions,
                })
              : anthropicProseFrames(turn.text, usage),
            gapMs,
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
    }
    if (currentMode === "demo") {
      return demoResponse(provider, resolveUrl(input), gapMs, usage);
    }
    if (
      currentMode === "ok" ||
      currentMode === "edit_file" ||
      currentMode === "propose_push" ||
      currentMode === "request_secret" ||
      currentMode === "print_secret" ||
      currentMode === "read_outside" ||
      currentMode === "subagents" ||
      currentMode === "ask_question"
    ) {
      if (slow) {
        return okResponse(provider, resolveUrl(input), SLOW_REPLY_CHUNKS, SLOW_REPLY_GAP_MS, usage);
      }
      return okResponse(provider, resolveUrl(input), chunkCount, gapMs, usage);
    }
    if (currentMode === "request_forbidden") {
      return resolveUrl(input).includes(PROVIDER_ADAPTERS[provider].requestPath)
        ? requestForbiddenResponse(provider)
        : Response.json({ data: [] }, { status: 200 });
    }
    return failureResponse(provider, currentMode);
  };

  return {
    fetchImpl,
    setMode(nextMode) {
      currentMode = nextMode;
    },
    calls,
    setStreamPacing(nextChunkCount, nextGapMs) {
      chunkCount = nextChunkCount;
      gapMs = nextGapMs;
    },
  };
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === undefined) {
    return record;
  }
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function okResponse(
  provider: ProviderId,
  url: string,
  chunkCount: number,
  gapMs: number,
  usage: DoubleUsage,
): Response {
  if (url.includes(PROVIDER_ADAPTERS[provider].requestPath)) {
    return streamingMessagesResponse(provider, chunkCount, gapMs, usage);
  }
  return Response.json({ data: [] }, { status: 200 });
}

function streamingMessagesResponse(
  provider: ProviderId,
  chunkCount: number,
  gapMs: number,
  usage: DoubleUsage,
): Response {
  const frames =
    provider === "anthropic"
      ? anthropicStreamFrames(chunkCount, usage)
      : openaiStreamFrames(chunkCount, usage);
  return new Response(streamBody(frames, gapMs), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Each tool-calling mode's Responses API call; a function so it reads constants defined below. */
function openaiToolMode(
  mode: DoubleMode,
): { readonly suffix: string; readonly args: Readonly<Record<string, unknown>> } | null {
  switch (mode) {
    case "edit_file":
      return {
        suffix: "exec_command",
        args: { cmd: `printf '${EDIT_FILE_CONTENT}\\n' > ${EDIT_FILE_PATH}` },
      };
    case "propose_push":
      return {
        suffix: "policy_propose",
        args: {
          push: "auto",
          pullRequest: "auto_after_verification",
          rationale: "The user asked to push this and open a draft pull request.",
        },
      };
    case "request_secret":
      return { suffix: "secret_request", args: { name: REQUESTED_SECRET_NAME } };
    default:
      return null;
  }
}

interface ResponsesTool {
  readonly name?: string;
  readonly description?: string;
  readonly tools?: readonly ResponsesTool[];
}

interface ResponsesRequest {
  readonly tools?: readonly ResponsesTool[];
  readonly input?: Array<{ type?: string; tools?: readonly ResponsesTool[] }>;
}

/**
 * Every tool name a Responses request offers: in `tools`, in an
 * `additional_tools` input item's namespaces, or named in the `exec` tool's
 * description ("code mode"), which Codex still runs if called directly.
 */
export function responsesToolNames(request: ResponsesRequest): readonly string[] {
  const names: string[] = [];
  const walk = (tools: readonly ResponsesTool[] | undefined): void => {
    for (const tool of tools ?? []) {
      if (tool.tools !== undefined) {
        walk(tool.tools);
        continue;
      }
      if (tool.name !== undefined) {
        names.push(tool.name);
      }
      for (const match of (tool.description ?? "").matchAll(/\b[a-z][a-z0-9_]*[a-z0-9]\b/g)) {
        if (match[0].includes("_")) {
          names.push(match[0]);
        }
      }
    }
  };
  walk(request.tools);
  for (const item of request.input ?? []) {
    walk(item.tools);
  }
  return names;
}

/** The offered name of a tool this turn owes a call to: offered, and the newest item is not a tool result. */
function offeredResponsesTool(
  provider: ProviderId,
  url: string,
  body: unknown,
  suffix: string,
): string | null {
  if (provider !== "openai" || !url.includes(PROVIDER_ADAPTERS.openai.requestPath)) {
    return null;
  }
  const text =
    typeof body === "string"
      ? body
      : body instanceof Uint8Array
        ? new TextDecoder().decode(body)
        : "";
  let parsed: ResponsesRequest;
  try {
    parsed = JSON.parse(text) as ResponsesRequest;
  } catch {
    return null;
  }
  const tool = responsesToolNames(parsed).find((name) => name.endsWith(suffix));
  const newest = (parsed.input ?? []).at(-1);
  if (tool === undefined || newest?.type === "function_call_output") {
    return null;
  }
  return tool;
}

/** A Responses stream whose one output item is a call to `name`. */
function openaiToolCallFrames(
  name: string,
  args: Readonly<Record<string, unknown>>,
  usage: DoubleUsage,
): readonly string[] {
  let sequence = 0;
  const frame = (type: string, body: Record<string, unknown>): string =>
    sseFrame(type, { type, sequence_number: sequence++, ...body });
  const argumentsText = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: "fc_double",
    call_id: `call_double_${name}`,
    name,
    arguments: argumentsText,
    status: "completed",
  };
  const response = {
    id: "resp_double_call",
    object: "response",
    created_at: 1_790_000_000,
    model: "gpt-6-sol",
    usage: null,
  };
  return [
    frame("response.created", { response: { ...response, status: "in_progress", output: [] } }),
    frame("response.output_item.added", {
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    }),
    frame("response.function_call_arguments.delta", {
      item_id: item.id,
      output_index: 0,
      delta: argumentsText,
    }),
    frame("response.function_call_arguments.done", {
      item_id: item.id,
      output_index: 0,
      arguments: argumentsText,
    }),
    frame("response.output_item.done", { output_index: 0, item }),
    frame("response.completed", {
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: openaiUsage(usage),
      },
    }),
  ];
}

/** The file `edit_file` has the agent write, and what it writes. */
export const EDIT_FILE_PATH = "health.txt";
export const EDIT_FILE_CONTENT = "ok";
/** The optional secret the `request_secret` mode asks for: the one the seeded project file declares. */
export const REQUESTED_SECRET_NAME = "STRIPE_TEST_KEY";

interface MessagesRequest {
  readonly tools?: Array<{ name?: string }>;
  readonly messages?: Array<{ content?: unknown }>;
}

function messagesRequest(provider: ProviderId, url: string, body: unknown): MessagesRequest | null {
  if (provider !== "anthropic" || !url.includes(PROVIDER_ADAPTERS[provider].requestPath)) {
    return null;
  }
  const text =
    typeof body === "string"
      ? body
      : body instanceof Uint8Array
        ? new TextDecoder().decode(body)
        : "";
  try {
    return JSON.parse(text) as MessagesRequest;
  } catch {
    return {};
  }
}

/**
 * The offered name of an OnCue tool this turn owes a call to. Unlike
 * `wantsToolCall` it reads only the newest message, since a follow-up's
 * history holds earlier results.
 */
function offeredTool(
  provider: ProviderId,
  url: string,
  body: unknown,
  suffix: "policy_propose" | "secret_request" | "bash",
): string | null {
  const parsed = messagesRequest(provider, url, body);
  if (parsed === null) {
    return null;
  }
  const tool = (parsed.tools ?? []).find((entry) => entry.name?.endsWith(suffix));
  const newest = (parsed.messages ?? []).at(-1);
  if (tool?.name === undefined || JSON.stringify(newest ?? null).includes('"tool_result"')) {
    return null;
  }
  return tool.name;
}

/**
 * The questions `ask_question` asks, by the marker in the task that names
 * them; a task with none gets `single`. Each is the shape OpenCode's own
 * question tool takes, header at most 30 characters.
 */
export const QUESTION_SETS = {
  single: [
    {
      question: "Which database should the service use?",
      header: "Database",
      options: [
        { label: "Postgres", description: "Relational, already in the stack" },
        { label: "SQLite", description: "One file, no server to run" },
        { label: "DuckDB", description: "Columnar, good for analytics" },
      ],
      multiple: false,
    },
  ],
  multi: [
    {
      question: "Which platforms should it ship on?",
      header: "Platforms",
      options: [
        { label: "Web", description: "Any modern browser" },
        { label: "iOS", description: "iPhone and iPad" },
        { label: "Android", description: "Phones and tablets" },
      ],
      multiple: true,
    },
  ],
  four: [
    {
      question: "What kind of app is it?",
      header: "App type",
      options: [
        { label: "Productivity / utility", description: "Tasks, notes, habits, trackers, tools" },
        { label: "Social / community", description: "Feeds, messaging, groups, sharing" },
        { label: "AI-powered assistant", description: "Chat, generation, an agent, voice" },
        { label: "Marketplace / service", description: "Booking, buying, selling, on-demand" },
      ],
      multiple: false,
    },
    {
      question: "Which platforms do you want to ship on?",
      header: "Platforms",
      options: [
        { label: "iOS", description: "iPhone and iPad" },
        { label: "Android", description: "Phones and tablets" },
        { label: "Web", description: "A browser version too" },
      ],
      multiple: true,
    },
    {
      question: "Who is it for?",
      header: "Audience",
      options: [
        { label: "Consumers", description: "Anyone with a phone" },
        { label: "Teams at work", description: "Shared accounts and roles" },
      ],
      multiple: false,
    },
    {
      question: "What does the app need behind the scenes?",
      header: "Backend",
      options: [
        { label: "Accounts and sync", description: "Sign-in and data across devices" },
        { label: "Nothing yet", description: "Local only for the first version" },
      ],
      multiple: false,
    },
  ],
} as const;

/** The marker a task carries to pick a set, such as `[ask:multi]`. */
export function questionMarker(set: keyof typeof QUESTION_SETS): string {
  return `[ask:${set}]`;
}

/** What `ask_question` replies after an answer, before the text it repeats. */
export const QUESTION_ECHO_PREFIX = "Thanks. What you told me:";

/** Every piece of text in a message's content, in order. */
function textsIn(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(textsIn);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  return [...textsIn(record.text), ...textsIn(record.content)];
}

/**
 * The `ask_question` turn: ask when the runtime offers its question tool and
 * no question was asked in this conversation yet; repeat the user's answer
 * once a question's result or a resumed run's answers arrive. Null for any
 * other request, such as the title call, which gets the plain text stream.
 */
function questionTurn(
  provider: ProviderId,
  url: string,
  body: unknown,
):
  | { readonly kind: "ask"; readonly tool: string; readonly questions: unknown }
  | { readonly kind: "echo"; readonly text: string }
  | null {
  const parsed = messagesRequest(provider, url, body);
  if (parsed === null) {
    return null;
  }
  const tool = (parsed.tools ?? []).find((entry) => entry.name === "question")?.name;
  const history = JSON.stringify(parsed.messages ?? []);
  const newest = (parsed.messages ?? []).at(-1);
  const newestText = textsIn(newest?.content).join(" ");
  const asked = history.includes('"toolu_double_question"');
  if (
    (asked && history.includes('"tool_result"')) ||
    newestText.includes("Answers to your questions")
  ) {
    return {
      kind: "echo",
      // A resumed run's message follows the session context; only the answers are repeated.
      text: `${QUESTION_ECHO_PREFIX} ${newestText
        .slice(Math.max(0, newestText.indexOf("Answers to your questions")))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600)}`,
    };
  }
  if (tool === undefined || asked) {
    return null;
  }
  const set = (Object.keys(QUESTION_SETS) as (keyof typeof QUESTION_SETS)[]).find((name) =>
    history.includes(questionMarker(name)),
  );
  return { kind: "ask", tool, questions: QUESTION_SETS[set ?? "single"] };
}

/** The file the secret tool's answer named, or the default secrets path when there is none. */
function secretPathIn(provider: ProviderId, url: string, body: unknown): string {
  const text = JSON.stringify(messagesRequest(provider, url, body)?.messages ?? []);
  const named = /Read it from the file ([^\s,"]+)/.exec(text);
  return named?.[1] ?? `/var/lib/oncue/secrets/${REQUESTED_SECRET_NAME}`;
}

/** A file outside every work tree that exists on Linux and macOS alike. */
export const OUTSIDE_FILE_PATH = "/etc/hosts";
/** A second one, so a lane can see the next read answered by a saved choice. */
export const SECOND_OUTSIDE_FILE_PATH = "/etc/shells";

interface ScriptedCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

const ECHO_AGAIN: ScriptedCall = {
  name: "bash",
  input: { command: "echo again", description: "Say again" },
};

/**
 * Tasks that script the harness's own permission asks (record 09). Each
 * marker names the "model's" turns, each a list of tool calls made together;
 * after the last turn it answers in text. The runtime's own gate decides
 * whether a call asks; nothing here knows an approval exists.
 */
export const ASK_SCRIPTS: Readonly<Record<string, readonly (readonly ScriptedCall[])[]>> = {
  "[double: read outside]": [[{ name: "read", input: { filePath: OUTSIDE_FILE_PATH } }]],
  "[double: read outside twice]": [
    [{ name: "read", input: { filePath: OUTSIDE_FILE_PATH } }],
    [{ name: "read", input: { filePath: SECOND_OUTSIDE_FILE_PATH } }],
  ],
  "[double: cat outside]": [
    [{ name: "bash", input: { command: `cat ${OUTSIDE_FILE_PATH}`, description: "Read hosts" } }],
  ],
  "[double: read env]": [[{ name: "read", input: { filePath: ".env" } }]],
  // OpenCode asks when the newest three parts of one reply are the same call
  // with the same input, so the three come in one turn.
  "[double: repeat]": [[ECHO_AGAIN, ECHO_AGAIN, ECHO_AGAIN]],
};

interface ScriptMessage {
  readonly role?: string;
  readonly content?: unknown;
}

function blocksOf(message: ScriptMessage): readonly Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? (message.content as Record<string, unknown>[])
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
}

/**
 * The calls a scripted task owes this turn: the newest user message with text
 * names the script, and the replies with tool calls since it count the turns.
 */
export function scriptedToolCalls(
  provider: ProviderId,
  url: string,
  body: unknown,
): readonly (ScriptedCall & { readonly id: string })[] | null {
  const parsed = messagesRequest(provider, url, body);
  const messages = (parsed?.messages ?? []) as ScriptMessage[];
  if (parsed === null || (parsed.tools ?? []).length === 0) {
    return null;
  }
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as ScriptMessage;
    if (message.role === "user" && blocksOf(message).some((block) => block.type === "text")) {
      start = index;
      break;
    }
  }
  if (start === -1) {
    return null;
  }
  const prompt = JSON.stringify(messages[start]);
  // Longest first, so "read outside twice" is not taken for "read outside".
  const marker = Object.keys(ASK_SCRIPTS)
    .sort((a, b) => b.length - a.length)
    .find((candidate) => prompt.includes(candidate));
  if (marker === undefined) {
    return null;
  }
  const taken = messages
    .slice(start + 1)
    .filter(
      (message) =>
        message.role === "assistant" &&
        blocksOf(message).some((block) => block.type === "tool_use"),
    ).length;
  const turn = (ASK_SCRIPTS[marker] as readonly (readonly ScriptedCall[])[])[taken];
  const offered = (call: ScriptedCall) =>
    (parsed.tools ?? []).some((tool) => tool.name === call.name);
  if (turn === undefined || !turn.every(offered)) {
    return null;
  }
  // Unique ids: the harness names its calls by them, and a session holds many runs.
  const prefix = `toolu_double_script_${crypto.randomUUID().slice(0, 8)}`;
  return turn.map((call, index) => ({ ...call, id: `${prefix}_${index}` }));
}

// A `bash` call is owed on the first turn of a run: tools offered and no tool
// result yet. Other requests, such as the title call, get the text stream.
function wantsToolCall(provider: ProviderId, url: string, body: unknown): boolean {
  const parsed = messagesRequest(provider, url, body);
  if (parsed === null) {
    return false;
  }
  const offersBash = (parsed.tools ?? []).some((tool) => tool.name === "bash");
  const carriesResult = JSON.stringify(parsed.messages ?? []).includes('"tool_result"');
  return offersBash && !carriesResult;
}

function anthropicToolUseFrames(
  usage: DoubleUsage,
  toolUseId = "toolu_double_edit",
  name = "bash",
  input: Readonly<Record<string, unknown>> = {
    command: `printf '${EDIT_FILE_CONTENT}\\n' > ${EDIT_FILE_PATH}`,
    description: "Write the health file",
  },
): readonly string[] {
  return [
    sseFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_double_tool",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [],
        usage: anthropicStartUsage(usage),
      },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: toolUseId, name, input: {} },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(input),
      },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: usage.output },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ];
}

/** One reply carrying several tool calls, in order. */
function anthropicToolUseTurnFrames(
  calls: readonly { readonly id: string; readonly name: string; readonly input: unknown }[],
): readonly string[] {
  const frames: string[] = [
    sseFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_double_script",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
  ];
  calls.forEach((call, index) => {
    frames.push(
      sseFrame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
      }),
      sseFrame("content_block_stop", { type: "content_block_stop", index }),
    );
  });
  frames.push(
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 1 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  );
  return frames;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// `shift()` rather than indexing avoids an unreachable `undefined` arm under
// `noUncheckedIndexedAccess`.
function streamBody(frames: readonly string[], gapMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue = [...frames];
  let started = false;
  return new ReadableStream({
    async pull(controller) {
      const frame = queue.shift();
      if (frame === undefined) {
        controller.close();
        return;
      }
      if (started) {
        await sleep(gapMs);
      }
      started = true;
      controller.enqueue(encoder.encode(frame));
    },
  });
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Anthropic's streaming shape: `message_start`, a content block with N deltas,
 * then `content_block_stop`, `message_delta`, and the terminal `message_stop`.
 */
function anthropicStreamFrames(chunkCount: number, usage: DoubleUsage): readonly string[] {
  const frames: string[] = [
    sseFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_double",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [],
        usage: anthropicStartUsage(usage),
      },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  ];
  for (let index = 0; index < chunkCount; index += 1) {
    frames.push(
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `chunk-${index} ` },
      }),
    );
  }
  frames.push(sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }));
  frames.push(
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: usage.output },
    }),
  );
  frames.push(sseFrame("message_stop", { type: "message_stop" }));
  return frames;
}

/** The same wire shape with one delta per word of real markdown. */
function anthropicProseFrames(text: string, usage: DoubleUsage): readonly string[] {
  const frames: string[] = [
    sseFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_double_demo",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [],
        usage: anthropicStartUsage(usage),
      },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  ];
  // Whitespace stays with the word before it, so the deltas rejoin exactly,
  // newlines included.
  const pieces = text.match(/\S+\s*/g) ?? [];
  for (const piece of pieces) {
    frames.push(
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: piece },
      }),
    );
  }
  frames.push(sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }));
  frames.push(
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: usage.output },
    }),
  );
  frames.push(sseFrame("message_stop", { type: "message_stop" }));
  return frames;
}

/** OpenAI has no demo fixture; it falls back to the ordinary streamed answer. */
function demoResponse(
  provider: ProviderId,
  url: string,
  gapMs: number,
  usage: DoubleUsage,
): Response {
  if (!url.includes(PROVIDER_ADAPTERS[provider].requestPath)) {
    return Response.json({ data: [] }, { status: 200 });
  }
  if (provider !== "anthropic") {
    return streamingMessagesResponse(provider, DEFAULT_CHUNK_COUNT, gapMs, usage);
  }
  return new Response(streamBody(anthropicProseFrames(DEMO_PROSE, usage), gapMs), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * OpenAI's Responses API streaming shape: `response.created`, one message item
 * with N `response.output_text.delta` frames, the done events, then
 * `response.completed` with usage. Each frame is an `event:` line and a `data:`
 * line; there is no terminal sentinel. The fields are what `@ai-sdk/openai`
 * 3.0.88 (bundled by OpenCode 1.18.30) reads.
 */
function openaiStreamFrames(chunkCount: number, usage: DoubleUsage): readonly string[] {
  const responseId = "resp_double";
  const itemId = "msg_double";
  const model = "gpt-6-sol";
  const text = Array.from({ length: chunkCount }, (_, index) => `chunk-${index} `).join("");
  let sequence = 0;
  const frame = (type: string, body: Record<string, unknown>): string =>
    sseFrame(type, { type, sequence_number: sequence++, ...body });
  const inProgress = {
    id: responseId,
    object: "response",
    created_at: 1_790_000_000,
    status: "in_progress",
    model,
    output: [],
    usage: null,
  };
  const frames: string[] = [
    frame("response.created", { response: inProgress }),
    frame("response.in_progress", { response: inProgress }),
    frame("response.output_item.added", {
      output_index: 0,
      item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
    }),
    frame("response.content_part.added", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
  ];
  for (let index = 0; index < chunkCount; index += 1) {
    frames.push(
      frame("response.output_text.delta", {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: `chunk-${index} `,
        logprobs: [],
      }),
    );
  }
  const item = {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  };
  frames.push(
    frame("response.output_text.done", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    }),
    frame("response.content_part.done", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [], logprobs: [] },
    }),
    frame("response.output_item.done", { output_index: 0, item }),
    frame("response.completed", {
      response: {
        ...inProgress,
        status: "completed",
        output: [item],
        usage: openaiUsage(usage),
      },
    }),
  );
  return frames;
}

interface ProviderFailureShape {
  readonly status: number;
  readonly body: unknown;
}

function anthropicError(type: string, message: string): unknown {
  return { type: "error", error: { type, message } };
}

function openaiError(type: string, message: string, code: string | null): unknown {
  return { error: { message, type, param: null, code } };
}

type FailureMode = Exclude<
  DoubleMode,
  | "ok"
  | "edit_file"
  | "propose_push"
  | "request_secret"
  | "print_secret"
  | "read_outside"
  | "demo"
  | "subagents"
  | "ask_question"
  | "request_forbidden"
>;

/**
 * `usage_limit` uses the same unverified 400 `invalid_request_error` guess as
 * `providers/anthropic.ts`, so the double does not invent a cleaner signal
 * than the real provider may send.
 */
const ANTHROPIC_FAILURES: Readonly<Record<FailureMode, ProviderFailureShape>> = {
  rate_limited: {
    status: 429,
    body: anthropicError(
      "rate_limit_error",
      "Number of request tokens has exceeded your rate limit.",
    ),
  },
  usage_limit: {
    status: 400,
    body: anthropicError(
      "invalid_request_error",
      "Your credit balance is too low to access the Claude API.",
    ),
  },
  auth_failed: {
    status: 401,
    body: anthropicError("authentication_error", "invalid x-api-key"),
  },
  model_unavailable: {
    status: 404,
    body: anthropicError("not_found_error", "model: not-a-real-model"),
  },
  rejected: {
    status: 400,
    body: anthropicError("invalid_request_error", "messages: at least one message is required"),
  },
  overloaded: {
    status: 529,
    body: anthropicError("overloaded_error", "Overloaded"),
  },
};

const OPENAI_FAILURES: Readonly<Record<FailureMode, ProviderFailureShape>> = {
  rate_limited: {
    status: 429,
    body: openaiError("rate_limit_error", "Rate limit reached for requests", null),
  },
  usage_limit: {
    status: 429,
    body: openaiError(
      "insufficient_quota",
      "You exceeded your current quota.",
      "insufficient_quota",
    ),
  },
  auth_failed: {
    status: 401,
    body: openaiError("invalid_api_key", "Incorrect API key provided.", "invalid_api_key"),
  },
  model_unavailable: {
    status: 404,
    body: openaiError("model_not_found", "The model does not exist.", "model_not_found"),
  },
  rejected: {
    status: 400,
    body: openaiError("invalid_request_error", "Invalid request.", null),
  },
  overloaded: {
    status: 503,
    body: openaiError(
      "server_error",
      "The server had an error while processing your request.",
      null,
    ),
  },
};

/** Each provider's own refusal of one request by a key it otherwise accepts. */
function requestForbiddenResponse(provider: ProviderId): Response {
  return provider === "anthropic"
    ? Response.json(
        anthropicError(
          "permission_error",
          "Your API key does not have permission to use the specified resource.",
        ),
        { status: 403 },
      )
    : Response.json(
        openaiError(
          "invalid_request_error",
          "You have insufficient permissions for this operation. Missing scopes: api.responses.write.",
          null,
        ),
        { status: 401 },
      );
}

function failureResponse(provider: ProviderId, mode: FailureMode): Response {
  const shape = provider === "anthropic" ? ANTHROPIC_FAILURES[mode] : OPENAI_FAILURES[mode];
  return Response.json(shape.body, { status: shape.status });
}

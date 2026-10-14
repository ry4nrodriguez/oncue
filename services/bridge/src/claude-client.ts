/**
 * The Claude Code adapter's I/O half: Claude Code in stream-json mode, driven
 * over JSON lines on the runtime host's loopback port with the Agent SDK's
 * control protocol. A `can_use_tool` request becomes a permission for the
 * reducer, which holds `secret_request` for the user and refuses anything
 * else, except `AskUserQuestion`, which becomes a question for the user's
 * card; every other control request from Claude Code is refused.
 *
 * Provisional: not yet checked against a recorded Claude Code session.
 */

import type { HealthOutcome } from "./agent";
import { CLAUDE_QUESTION_TOOL, CLAUDE_VERSION } from "./claude";
import { type ClaudeEventMapper, createClaudeEventMapper, parseClaudeLine } from "./claude-wire";
import type { LineChannel } from "./codex-client";
import type { RuntimeEvent } from "./normalize";
import { boundQuestions, dismissedText } from "./questions";
import type { PromptTurn, RuntimeClient } from "./runtime";

export interface ClaudeClientDeps {
  /** A channel to the runtime host on `port`, or null when nothing answers yet. */
  readonly connect: (port: number) => Promise<LineChannel | null>;
  /** An attachment's bytes, for a prompt's images. The bridge placed the file, so it can read it. */
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

export const CLAUDE_REQUEST_TIMEOUT_MS = 30_000;

/** Claude Code names its session only once a turn starts; until then the bridge's conversation is this. */
export const CLAUDE_PENDING_SESSION = "claude-session";

interface Pending {
  readonly resolve: (response: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface HeldAsk {
  readonly input: Record<string, unknown>;
  /** An `AskUserQuestion` call, answered through `replyQuestion` rather than `replyHeld`. */
  readonly question: boolean;
}

/**
 * `AskUserQuestion`'s answer as Claude Code reads it: the original questions,
 * and each question's text mapped to the chosen labels or typed text, several
 * joined with ", ".
 */
export function claudeQuestionAnswer(
  input: Record<string, unknown>,
  answers: readonly (readonly string[])[],
): Record<string, unknown> {
  const asked = Array.isArray(input.questions) ? input.questions : [];
  const byQuestion: Record<string, string> = {};
  for (const [index, entry] of asked.entries()) {
    const text = asRecord(entry)?.question;
    if (typeof text !== "string") {
      continue;
    }
    const given = answers[index] ?? [];
    byQuestion[text] = given.length === 0 ? "(skipped)" : given.join(", ");
  }
  return { questions: asked, answers: byQuestion };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The user's turn as Claude Code's content: the text, then each attached image read and base64-encoded. */
export async function claudeContent(
  turn: PromptTurn,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<readonly Record<string, unknown>[]> {
  const content: Record<string, unknown>[] = [{ type: "text", text: turn.text }];
  for (const file of turn.files ?? []) {
    if (!file.url.startsWith("file://") || !file.mime.startsWith("image/")) {
      continue;
    }
    try {
      const bytes = await readFile(decodeURIComponent(file.url.slice("file://".length)));
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: file.mime,
          data: Buffer.from(bytes).toString("base64"),
        },
      });
    } catch {
      // The note in the prompt's text still names the file, so the agent can read it itself.
    }
  }
  return content;
}

export function createClaudeClient(deps: ClaudeClientDeps): RuntimeClient {
  const timeoutMs = deps.requestTimeoutMs ?? CLAUDE_REQUEST_TIMEOUT_MS;
  let channel: LineChannel | null = null;
  let initialized = false;
  let version: string = CLAUDE_VERSION;
  let sessionId: string | null = null;
  let modelId: string | null = null;
  let mapper: ClaudeEventMapper = createClaudeEventMapper(deps.now);
  let nextId = 1;
  const pending = new Map<string, Pending>();
  const held = new Map<string, HeldAsk>();
  let sink: ((event: RuntimeEvent) => void) | null = null;
  const early: RuntimeEvent[] = [];
  const closeWaiters: Array<() => void> = [];

  function emit(event: RuntimeEvent): void {
    if (sink === null) {
      early.push(event);
    } else {
      sink(event);
    }
  }

  function send(message: Record<string, unknown>): void {
    channel?.send(JSON.stringify(message));
  }

  function control(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `oncue-${nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${String(request.subtype)} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ type: "control_request", request_id: id, request });
    });
  }

  function answer(requestId: string, response: Record<string, unknown>): void {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  }

  function refuse(requestId: string, error: string): void {
    send({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error },
    });
  }

  function onControlRequest(requestId: string, request: Record<string, unknown>): void {
    if (request.subtype !== "can_use_tool") {
      refuse(requestId, `OnCue does not serve ${String(request.subtype)}`);
      emit({ kind: "homeless", wireKind: `control_request/${String(request.subtype)}` });
      return;
    }
    const tool = typeof request.tool_name === "string" ? request.tool_name : "";
    const callId = typeof request.tool_use_id === "string" ? request.tool_use_id : requestId;
    const input = asRecord(request.input) ?? {};
    if (tool === CLAUDE_QUESTION_TOOL) {
      onQuestion(requestId, callId, input);
      return;
    }
    held.set(requestId, { input, question: false });
    emit({ kind: "permission_asked", requestId, permission: tool, callId, input });
    emit(runningPart(callId, tool, input));
  }

  // `{questions: [{question, header, options: [{label, description}],
  // multiSelect}]}`. Claude Code always offers a typed answer of its own.
  function onQuestion(requestId: string, callId: string, input: Record<string, unknown>): void {
    const raw = Array.isArray(input.questions) ? input.questions : [];
    const questions = boundQuestions(
      raw.map((entry) => {
        const record = asRecord(entry) ?? {};
        return {
          header: record.header,
          text: record.question,
          options: record.options,
          multiple: record.multiSelect,
          allowOther: true,
        };
      }),
    );
    if (questions === null) {
      answer(requestId, { behavior: "deny", message: "OnCue could not read the question." });
      emit({ kind: "homeless", wireKind: "can_use_tool/AskUserQuestion" });
      return;
    }
    held.set(requestId, { input, question: true });
    emit(runningPart(callId, CLAUDE_QUESTION_TOOL, input));
    emit({ kind: "question_asked", requestId, callId, questions, askedCount: raw.length });
  }

  // The held call's input, which the permission carries no copy of.
  function runningPart(callId: string, tool: string, input: Record<string, unknown>): RuntimeEvent {
    return {
      kind: "tool_part",
      messageId: callId,
      part: {
        callId,
        tool,
        status: "running",
        title: tool,
        input,
        output: null,
        error: null,
        exitCode: null,
        startedAtMs: null,
        endedAtMs: null,
      },
    };
  }

  function onLine(line: string): void {
    const parsed = parseClaudeLine(line);
    switch (parsed.kind) {
      case "control_response": {
        const waiting = pending.get(parsed.requestId);
        if (waiting === undefined) {
          return;
        }
        pending.delete(parsed.requestId);
        clearTimeout(waiting.timer);
        if (parsed.ok) {
          waiting.resolve(parsed.response);
        } else {
          waiting.reject(new Error(parsed.error ?? "error"));
        }
        return;
      }
      case "control_request":
        onControlRequest(parsed.requestId, parsed.request);
        return;
      case "control_cancel": {
        // Claude Code withdrew the ask (an interrupt): the call ends as an
        // error result, which clears the reducer's hold, and a question is
        // forgotten so no answer is sent for it.
        const ask = held.get(parsed.requestId);
        held.delete(parsed.requestId);
        emit(
          ask?.question === true
            ? { kind: "question_settled", requestId: parsed.requestId }
            : { kind: "homeless", wireKind: "control_cancel_request" },
        );
        return;
      }
      case "message": {
        if (parsed.type === "system" && parsed.record.subtype === "init") {
          if (typeof parsed.record.session_id === "string") {
            sessionId = parsed.record.session_id;
          }
          if (typeof parsed.record.claude_code_version === "string") {
            version = parsed.record.claude_code_version;
          }
        }
        for (const event of mapper.events(parsed.type, parsed.record)) {
          emit(event);
        }
        return;
      }
      case "garbled":
        emit({ kind: "unknown", wireKind: "garbled", raw: parsed.raw });
        return;
    }
  }

  function dropChannel(): void {
    channel = null;
    initialized = false;
    sessionId = null;
    modelId = null;
    mapper = createClaudeEventMapper(deps.now);
    held.clear();
    for (const [id, waiting] of pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("the runtime host closed the connection"));
      pending.delete(id);
    }
    for (const waiter of closeWaiters.splice(0)) {
      waiter();
    }
  }

  async function ready(port: number): Promise<HealthOutcome> {
    if (channel !== null && initialized) {
      return { kind: "healthy", version };
    }
    if (channel === null) {
      const opened = await deps.connect(port);
      if (opened === null) {
        return { kind: "not_yet", detail: "the runtime host is not listening yet" };
      }
      channel = opened;
      opened.onLine(onLine);
      opened.onClose(() => {
        if (channel === opened) {
          dropChannel();
        }
      });
    }
    try {
      await control({ subtype: "initialize" });
      try {
        const binary = await control({ subtype: "get_binary_version" });
        if (typeof binary.version === "string") {
          version = binary.version;
        }
      } catch {
        // An older Claude Code does not serve it; the image's pin stands, and
        // `system/init` corrects it on the first turn.
      }
      initialized = true;
      return { kind: "healthy", version };
    } catch (error) {
      return {
        kind: "not_yet",
        detail: error instanceof Error ? error.message : "initialize failed",
      };
    }
  }

  return {
    health: ready,

    async prompt(port, turn) {
      const health = await ready(port);
      if (health.kind !== "healthy") {
        return { kind: "refused", detail: `claude is not ready: ${health.detail}` };
      }
      try {
        if (modelId !== null && turn.model.modelId !== modelId) {
          await control({ subtype: "set_model", model: turn.model.modelId });
        }
        modelId = turn.model.modelId;
        // Effort is not sent: Claude Code runs with `CLAUDE_CODE_EFFORT_LEVEL=unset`
        // and the Model Broker writes the run's into every request.
        send({
          type: "user",
          message: { role: "user", content: await claudeContent(turn, deps.readFile) },
          parent_tool_use_id: null,
          session_id: sessionId ?? "",
        });
        return {
          kind: "held",
          conversation: sessionId ?? turn.conversation ?? CLAUDE_PENDING_SESSION,
        };
      } catch (error) {
        return {
          kind: "refused",
          detail: `claude refused the prompt: ${error instanceof Error ? error.message : "unknown"}`,
        };
      }
    },

    async abort() {
      if (channel === null) {
        return false;
      }
      try {
        await control({ subtype: "interrupt" });
        return true;
      } catch {
        return false;
      }
    },

    async replyHeld(_port, requestId, reply, message) {
      const ask = held.get(requestId);
      if (ask === undefined || ask.question) {
        return false;
      }
      held.delete(requestId);
      answer(
        requestId,
        reply === "once"
          ? { behavior: "allow", updatedInput: ask.input }
          : { behavior: "deny", message: message ?? "The user did not allow this." },
      );
      return true;
    },

    async replyQuestion(_port, requestId, reply) {
      const ask = held.get(requestId);
      if (ask === undefined || !ask.question) {
        return false;
      }
      held.delete(requestId);
      answer(
        requestId,
        reply.kind === "answer"
          ? { behavior: "allow", updatedInput: claudeQuestionAnswer(ask.input, reply.answers) }
          : { behavior: "deny", message: dismissedText(reply) },
      );
      return true;
    },

    subscribe(_port, onEvent, signal) {
      if (channel === null) {
        return Promise.resolve();
      }
      sink = onEvent;
      onEvent({ kind: "server_connected" });
      for (const event of early.splice(0)) {
        onEvent(event);
      }
      return new Promise<void>((resolve) => {
        const done = (): void => {
          if (sink === onEvent) {
            sink = null;
          }
          resolve();
        };
        closeWaiters.push(done);
        signal.addEventListener("abort", done, { once: true });
      });
    },
  };
}

/**
 * The Pi runtime adapter's I/O half: Pi's RPC mode over JSON lines on the
 * runtime host's loopback port. One connection carries the commands, the
 * session events (`pi-wire.ts`), and extension UI requests: OnCue's hold on a
 * `secret_request` (`PI_HOLD_TITLE`) is surfaced as a permission, as
 * OpenCode's gate is; OnCue's question tool (`PI_QUESTION_TITLE`) becomes a
 * question for the user's card; any other dialog is cancelled, since nobody in
 * the sandbox can answer one (record 12); notifications are ignored.
 *
 * Pi reports no version over RPC, so `health` reports the pinned version and
 * counts Pi healthy only when its model is on OnCue's provider, which proves
 * the extension loaded. Not yet run against a live Pi.
 */

import type { HealthOutcome } from "./agent";
import type { LineChannel } from "./codex-client";
import type { RuntimeEvent } from "./normalize";
import {
  PI_HOLD_TITLE,
  PI_PROVIDER_ID,
  PI_QUESTION_TITLE,
  PI_TOOL_PREFIX,
  PI_VERSION,
  piThinkingLevel,
} from "./pi";
import { createPiEventMapper, type PiEventMapper, parsePiLine } from "./pi-wire";
import {
  ASK_USER_TOOL_NAME,
  answerText,
  askUserQuestions,
  boundQuestions,
  dismissedText,
  type RuntimeQuestion,
} from "./questions";
import type { PromptTurn, RuntimeClient } from "./runtime";
import { SECRET_TOOL_NAME } from "./secrets";

export interface PiClientDeps {
  /** A channel to the runtime host on `port`, or null when nothing answers yet. */
  readonly connect: (port: number) => Promise<LineChannel | null>;
  /** An attachment's bytes, for a prompt's images. The bridge placed the file, so it can read it. */
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

export const PI_REQUEST_TIMEOUT_MS = 30_000;

/** Dialogs block Pi until answered; everything else is fire-and-forget (`docs/rpc-extension-ui.md`). */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** What the bridge answers a held call with; `pi-extension.ts` reads it. */
export interface PiHoldAnswer {
  readonly reply: "once" | "reject";
  readonly message: string | null;
}

/** What the bridge answers the question dialog with: the text the model reads. */
export interface PiQuestionAnswer {
  readonly answered: boolean;
  readonly text: string;
}

interface Pending {
  readonly resolve: (data: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A held call's own description, which the extension writes as the dialog's placeholder. */
function heldCallOf(record: Record<string, unknown>): {
  readonly tool: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof record.placeholder === "string" ? record.placeholder : "");
  } catch {
    return null;
  }
  const held = asRecord(parsed);
  const tool = held?.tool;
  const toolCallId = held?.toolCallId;
  if (typeof tool !== "string" || typeof toolCallId !== "string") {
    return null;
  }
  return { tool, toolCallId, input: asRecord(held?.input) ?? {} };
}

/** The user's attachments as Pi's image content: each `file://` image, read and base64-encoded. */
export async function piImages(
  turn: PromptTurn,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<readonly Record<string, unknown>[]> {
  const images: Record<string, unknown>[] = [];
  for (const file of turn.files ?? []) {
    if (!file.url.startsWith("file://") || !file.mime.startsWith("image/")) {
      continue;
    }
    try {
      const bytes = await readFile(decodeURIComponent(file.url.slice("file://".length)));
      images.push({
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: file.mime,
      });
    } catch {
      // The note in the prompt's text still names the file, so the agent can read it itself.
    }
  }
  return images;
}

export function createPiClient(deps: PiClientDeps): RuntimeClient {
  const timeoutMs = deps.requestTimeoutMs ?? PI_REQUEST_TIMEOUT_MS;
  let channel: LineChannel | null = null;
  let sessionId: string | null = null;
  let modelId: string | null = null;
  let busy = false;
  let mapper: PiEventMapper = createPiEventMapper(deps.now);
  let nextId = 1;
  const pending = new Map<string, Pending>();
  const held = new Set<string>();
  const questions = new Map<string, readonly RuntimeQuestion[]>();
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

  function command(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    const id = `oncue-${nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${type} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ id, type, ...fields });
    });
  }

  function onUiRequest(id: string, method: string, record: Record<string, unknown>): void {
    if (!DIALOG_METHODS.has(method)) {
      emit({ kind: "homeless", wireKind: `extension_ui_request/${method}` });
      return;
    }
    if (method === "input" && record.title === PI_QUESTION_TITLE && onQuestion(id, record)) {
      return;
    }
    const call = method === "input" && record.title === PI_HOLD_TITLE ? heldCallOf(record) : null;
    if (call === null) {
      // Nobody in the sandbox can answer a question (record 12).
      send({ type: "extension_ui_response", id, cancelled: true });
      emit({ kind: "homeless", wireKind: `extension_ui_request/${method}` });
      return;
    }
    held.add(id);
    emit({
      kind: "permission_asked",
      requestId: id,
      permission: call.tool,
      callId: call.toolCallId,
    });
    // The held call's input, which the permission carries no copy of.
    emit({
      kind: "tool_part",
      messageId: call.toolCallId,
      part: {
        callId: call.toolCallId,
        tool: call.tool,
        status: "running",
        title: call.tool,
        input: call.input,
        output: null,
        error: null,
        exitCode: null,
        startedAtMs: null,
        endedAtMs: null,
      },
    });
  }

  // The question tool's dialog: its placeholder is `{toolCallId, input}`.
  function onQuestion(id: string, record: Record<string, unknown>): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof record.placeholder === "string" ? record.placeholder : "");
    } catch {
      return false;
    }
    const call = asRecord(parsed);
    const raw = askUserQuestions(call?.input);
    const bound = boundQuestions(raw);
    if (bound === null) {
      return false;
    }
    const callId = typeof call?.toolCallId === "string" ? call.toolCallId : null;
    questions.set(id, bound);
    if (callId !== null) {
      emit({
        kind: "tool_part",
        messageId: callId,
        part: {
          callId,
          tool: `${PI_TOOL_PREFIX}${ASK_USER_TOOL_NAME}`,
          status: "running",
          title: ASK_USER_TOOL_NAME,
          input: asRecord(call?.input) ?? {},
          output: null,
          error: null,
          exitCode: null,
          startedAtMs: null,
          endedAtMs: null,
        },
      });
    }
    emit({
      kind: "question_asked",
      requestId: id,
      callId,
      questions: bound,
      askedCount: raw.length,
    });
    return true;
  }

  function onLine(line: string): void {
    const message = parsePiLine(line);
    switch (message.kind) {
      case "response": {
        const waiting = message.id === null ? undefined : pending.get(message.id);
        if (message.id === null || waiting === undefined) {
          return;
        }
        pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.success) {
          waiting.resolve(message.data);
        } else {
          waiting.reject(new Error(message.error ?? `${message.command} failed`));
        }
        return;
      }
      case "ui_request":
        onUiRequest(message.id, message.method, message.record);
        return;
      case "event":
        if (message.type === "agent_start") {
          busy = true;
        }
        if (message.type === "agent_settled") {
          busy = false;
        }
        for (const event of mapper.events(message.type, message.record)) {
          emit(event);
        }
        return;
      case "garbled":
        emit({ kind: "unknown", wireKind: "garbled", raw: message.raw });
        return;
    }
  }

  function dropChannel(): void {
    channel = null;
    sessionId = null;
    modelId = null;
    busy = false;
    mapper = createPiEventMapper(deps.now);
    held.clear();
    questions.clear();
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
    if (channel !== null && sessionId !== null) {
      return { kind: "healthy", version: PI_VERSION };
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
      const state = asRecord(await command("get_state"));
      const model = asRecord(state?.model);
      if (model?.provider !== PI_PROVIDER_ID || typeof model.id !== "string") {
        return {
          kind: "not_yet",
          detail: "pi's model is not on OnCue's provider: its extension did not load",
        };
      }
      if (typeof state?.sessionId !== "string") {
        return { kind: "not_yet", detail: "pi named no session" };
      }
      sessionId = state.sessionId;
      modelId = model.id;
      busy = state.isStreaming === true;
      return { kind: "healthy", version: PI_VERSION };
    } catch (error) {
      return {
        kind: "not_yet",
        detail: error instanceof Error ? error.message : "get_state failed",
      };
    }
  }

  return {
    health: ready,

    async prompt(port, turn) {
      const health = await ready(port);
      if (health.kind !== "healthy" || sessionId === null) {
        return {
          kind: "refused",
          detail: `pi is not ready: ${health.kind === "healthy" ? "no session" : health.detail}`,
        };
      }
      const conversation = sessionId;
      try {
        if (turn.model.modelId !== modelId) {
          // Only the model Pi started on is registered; another one is refused here, loudly.
          await command("set_model", { provider: PI_PROVIDER_ID, modelId: turn.model.modelId });
          modelId = turn.model.modelId;
        }
        if (turn.effort !== null) {
          await command("set_thinking_level", { level: piThinkingLevel(turn.effort) });
        }
        const images = await piImages(turn, deps.readFile);
        await command("prompt", {
          message: turn.text,
          ...(images.length === 0 ? {} : { images }),
          // A prompt into a busy session must say how to queue; steering joins the running turn.
          ...(busy ? { streamingBehavior: "steer" } : {}),
        });
        busy = true;
        return { kind: "held", conversation };
      } catch (error) {
        return {
          kind: "refused",
          detail: `pi refused the prompt: ${error instanceof Error ? error.message : "unknown"}`,
        };
      }
    },

    async abort() {
      if (channel === null) {
        return false;
      }
      try {
        await command("abort");
        return true;
      } catch {
        return false;
      }
    },

    async replyHeld(_port, requestId, reply, message) {
      if (!held.has(requestId)) {
        return false;
      }
      held.delete(requestId);
      const answer: PiHoldAnswer = { reply, message };
      send({ type: "extension_ui_response", id: requestId, value: JSON.stringify(answer) });
      return true;
    },

    async replyQuestion(_port, requestId, reply) {
      const asked = questions.get(requestId);
      if (asked === undefined) {
        return false;
      }
      questions.delete(requestId);
      const answer: PiQuestionAnswer =
        reply.kind === "answer"
          ? { answered: true, text: answerText(asked, reply.answers) }
          : { answered: false, text: dismissedText(reply) };
      send({ type: "extension_ui_response", id: requestId, value: JSON.stringify(answer) });
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

/** The name the model sees OnCue's secret tool under in Pi; the key its permission is asked under. */
export const PI_SECRET_TOOL = `${PI_TOOL_PREFIX}${SECRET_TOOL_NAME}`;

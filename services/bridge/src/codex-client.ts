/**
 * The Codex adapter's I/O half: Codex's app-server driven over line-delimited
 * JSON-RPC on the runtime host's loopback port. The server's own requests are
 * answered here:
 *
 * - `item/tool/call` runs one of OnCue's tools; `secret_request` is held as a
 *   permission until `replyHeld` answers it, and `ask_user` is held as a
 *   question until `replyQuestion` answers it.
 * - `item/tool/requestUserInput` gets no answers: Codex refuses its own
 *   question tool outside plan mode, so OnCue's `ask_user` stands in for it.
 * - an approval request is declined; the configuration asks for none.
 * - anything else is refused.
 *
 * Provisional: not yet checked against a real model.
 */

import { connect as netConnect } from "node:net";
import type { HealthOutcome } from "./agent";
import { CODEX_TOOL_PREFIX } from "./codex";
import { codexNotificationEvents, parseCodexLine, type RpcId } from "./codex-wire";
import type { RuntimeEvent } from "./normalize";
import {
  ASK_USER_TOOL_DEFINITION,
  ASK_USER_TOOL_NAME,
  answerText,
  askUserQuestions,
  boundQuestions,
  dismissedText,
  type RuntimeQuestion,
} from "./questions";
import type { PromptTurn, RuntimeClient } from "./runtime";
import { SECRET_TOOL_NAME } from "./secrets";
import { ONCUE_TOOL_DEFINITIONS, type ToolText } from "./tool-server";

/** A line-framed duplex channel: what the runtime host's port is to this client. */
export interface LineChannel {
  send(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface CodexClientDeps {
  /** A channel to the runtime host on `port`, or null when nothing answers yet. */
  readonly connect: (port: number) => Promise<LineChannel | null>;
  /** One of OnCue's tools, by OnCue's own name, answered in-process. */
  readonly callTool: (name: string, args: unknown) => Promise<ToolText>;
  /** The working directory a new thread starts in: the sandbox's `/workspace`. */
  readonly cwd: string;
  readonly requestTimeoutMs?: number;
}

export const CODEX_REQUEST_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: "oncue_bridge", title: "OnCue", version: "1" } as const;

/** Codex's `userAgent` is `<client>/<codex version> (...)`; the version is the part the bridge reports. */
export function codexVersionOf(userAgent: unknown): string {
  const match = typeof userAgent === "string" ? /^[^/\s]+\/(\S+)/.exec(userAgent) : null;
  return match?.[1] ?? "unknown";
}

/** OnCue's four tools and its question tool as Codex's dynamic tools, under the names the model sees. */
export function codexDynamicTools(): readonly Record<string, unknown>[] {
  return [...ONCUE_TOOL_DEFINITIONS, ASK_USER_TOOL_DEFINITION].map((definition) => ({
    type: "function",
    name: `${CODEX_TOOL_PREFIX}${definition.name}`,
    description: definition.description,
    inputSchema: definition.inputSchema,
  }));
}

/** The user's turn as Codex input: the text, then each attached image as a local file. */
export function codexInput(turn: PromptTurn): readonly Record<string, unknown>[] {
  const images = (turn.files ?? []).flatMap((file) =>
    file.url.startsWith("file://")
      ? [{ type: "localImage", path: decodeURIComponent(file.url.slice("file://".length)) }]
      : [],
  );
  return [{ type: "text", text: turn.text, text_elements: [] }, ...images];
}

interface Pending {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface HeldCall {
  readonly id: RpcId;
  readonly args: unknown;
  /** Set for an `ask_user` call, which `replyQuestion` answers. */
  readonly questions: readonly RuntimeQuestion[] | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolReply(text: string, success: boolean): Record<string, unknown> {
  return { contentItems: [{ type: "inputText", text }], success };
}

export function createCodexClient(deps: CodexClientDeps): RuntimeClient {
  const timeoutMs = deps.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS;
  let channel: LineChannel | null = null;
  let version: string | null = null;
  let nextId = 1;
  const pending = new Map<RpcId, Pending>();
  const activeTurns = new Map<string, string>();
  const held = new Map<string, HeldCall>();
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

  function request(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }

  function answerServer(id: RpcId, result: unknown): void {
    send({ id, result });
  }

  function onServerRequest(id: RpcId, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "item/tool/call": {
        const tool = typeof params.tool === "string" ? params.tool : "";
        const callId = typeof params.callId === "string" ? params.callId : String(id);
        const name = tool.startsWith(CODEX_TOOL_PREFIX) ? tool.slice(CODEX_TOOL_PREFIX.length) : "";
        // The held call's input, which the permission or question carries no copy of.
        const running: RuntimeEvent = {
          kind: "tool_part",
          messageId: typeof params.turnId === "string" ? params.turnId : callId,
          part: {
            callId,
            tool,
            status: "running",
            title: tool,
            input: asRecord(params.arguments) ?? {},
            output: null,
            error: null,
            exitCode: null,
            startedAtMs: null,
            endedAtMs: null,
          },
        };
        if (name === SECRET_TOOL_NAME) {
          held.set(String(id), { id, args: params.arguments, questions: null });
          emit({ kind: "permission_asked", requestId: String(id), permission: tool, callId });
          emit(running);
          return;
        }
        if (name === ASK_USER_TOOL_NAME) {
          const raw = askUserQuestions(params.arguments);
          const questions = boundQuestions(raw);
          if (questions === null) {
            answerServer(id, toolReply("OnCue could not read the question.", false));
            return;
          }
          held.set(String(id), { id, args: params.arguments, questions });
          emit(running);
          emit({
            kind: "question_asked",
            requestId: String(id),
            callId,
            questions,
            askedCount: raw.length,
          });
          return;
        }
        void deps.callTool(name, params.arguments).then(
          (answer) => answerServer(id, toolReply(answer.text, !answer.isError)),
          () => answerServer(id, toolReply("The tool failed.", false)),
        );
        return;
      }
      case "item/tool/requestUserInput":
        answerServer(id, { answers: {} });
        return;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        answerServer(id, { decision: "decline" });
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        answerServer(id, { decision: "denied" });
        return;
      default:
        send({ id, error: { code: -32601, message: `OnCue does not serve ${method}` } });
    }
  }

  function onLine(line: string): void {
    const message = parseCodexLine(line);
    switch (message.kind) {
      case "response":
      case "error_response": {
        const waiting = pending.get(message.id);
        if (waiting === undefined) {
          return;
        }
        pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.kind === "response") {
          waiting.resolve(message.result);
        } else {
          waiting.reject(new Error(message.message));
        }
        return;
      }
      case "server_request":
        onServerRequest(message.id, message.method, message.params);
        return;
      case "notification": {
        const threadId =
          typeof message.params.threadId === "string" ? message.params.threadId : null;
        const turnId = asRecord(message.params.turn)?.id;
        if (message.method === "turn/started" && threadId !== null && typeof turnId === "string") {
          activeTurns.set(threadId, turnId);
        }
        if (message.method === "turn/completed" && threadId !== null) {
          activeTurns.delete(threadId);
        }
        for (const event of codexNotificationEvents(message.method, message.params)) {
          emit(event);
        }
        return;
      }
      case "garbled":
        emit({ kind: "unknown", wireKind: "garbled", raw: message.raw });
        return;
    }
  }

  function dropChannel(): void {
    channel = null;
    version = null;
    activeTurns.clear();
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
    if (channel !== null && version !== null) {
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
      const result = asRecord(
        await request("initialize", {
          clientInfo: CLIENT_INFO,
          // Dynamic tools are an experimental field of `thread/start`.
          capabilities: { experimentalApi: true, requestAttestation: false },
        }),
      );
      send({ method: "initialized" });
      version = codexVersionOf(result?.userAgent);
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
        return { kind: "refused", detail: `codex is not ready: ${health.detail}` };
      }
      try {
        let threadId = turn.conversation;
        if (threadId === null) {
          const started = asRecord(
            await request("thread/start", {
              model: turn.model.modelId,
              cwd: deps.cwd,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
              dynamicTools: codexDynamicTools(),
            }),
          );
          const id = asRecord(started?.thread)?.id;
          if (typeof id !== "string") {
            return { kind: "refused", detail: "codex did not start a thread" };
          }
          threadId = id;
        }
        const input = codexInput(turn);
        const active = activeTurns.get(threadId);
        if (active !== undefined) {
          await request("turn/steer", { threadId, input, expectedTurnId: active });
        } else {
          const started = asRecord(
            await request("turn/start", {
              threadId,
              input,
              // OnCue's effort words are OpenAI's own for every level Codex
              // can send (the catalog's `effortLevels`).
              ...(turn.effort === null ? {} : { effort: turn.effort }),
            }),
          );
          const id = asRecord(started?.turn)?.id;
          if (typeof id === "string" && !activeTurns.has(threadId)) {
            activeTurns.set(threadId, id);
          }
        }
        return { kind: "held", conversation: threadId };
      } catch (error) {
        return {
          kind: "refused",
          detail: `codex refused the prompt: ${error instanceof Error ? error.message : "unknown"}`,
        };
      }
    },

    async abort(_port, conversation) {
      const turnId = activeTurns.get(conversation);
      if (turnId === undefined || channel === null) {
        return false;
      }
      try {
        await request("turn/interrupt", { threadId: conversation, turnId });
        return true;
      } catch {
        return false;
      }
    },

    async replyHeld(_port, requestId, reply, message) {
      const call = held.get(requestId);
      if (call === undefined || call.questions !== null) {
        return false;
      }
      held.delete(requestId);
      if (reply === "reject") {
        answerServer(call.id, toolReply(message ?? "The user did not allow this.", false));
        return true;
      }
      const answer = await deps.callTool(SECRET_TOOL_NAME, call.args);
      answerServer(call.id, toolReply(answer.text, !answer.isError));
      return true;
    },

    async replyQuestion(_port, requestId, reply) {
      const call = held.get(requestId);
      if (call === undefined || call.questions === null) {
        return false;
      }
      held.delete(requestId);
      answerServer(
        call.id,
        reply.kind === "answer"
          ? toolReply(answerText(call.questions, reply.answers), true)
          : toolReply(dismissedText(reply), false),
      );
      return true;
    },

    subscribe(_port, onEvent, signal) {
      if (channel === null) {
        return Promise.resolve();
      }
      sink = onEvent;
      // The connection is live already, so the stream "opens" now; what
      // arrived between the handshake and here follows it, in order.
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

/** A `LineChannel` over a loopback TCP connection, or null when nothing is listening. */
export function nodeLineChannel(port: number): Promise<LineChannel | null> {
  return new Promise((resolve) => {
    const socket = netConnect(port, "127.0.0.1");
    let settled = false;
    socket.once("connect", () => {
      settled = true;
      let rest = "";
      const lineHandlers: Array<(line: string) => void> = [];
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        rest += chunk;
        for (;;) {
          const newline = rest.indexOf("\n");
          if (newline === -1) {
            break;
          }
          const line = rest.slice(0, newline);
          rest = rest.slice(newline + 1);
          if (line.trim() !== "") {
            for (const handler of lineHandlers) {
              handler(line);
            }
          }
        }
      });
      resolve({
        send: (line) => {
          socket.write(`${line}\n`);
        },
        onLine: (handler) => {
          lineHandlers.push(handler);
        },
        onClose: (handler) => {
          socket.once("close", handler);
        },
        close: () => {
          socket.destroy();
        },
      });
    });
    socket.once("error", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
  });
}

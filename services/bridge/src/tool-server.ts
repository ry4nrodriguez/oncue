/**
 * OnCue's agent tools (records 07 and 09), served to the harness as an MCP
 * server on the bridge's loopback port: `policy_propose`,
 * `pull_request_describe`, `git_commit`, and `secret_request`.
 *
 * Not a boundary: anything the agent runs can call it on loopback. That is safe
 * because a call never grants authority; the session object judges every
 * proposal against its own rows and holds any widening for the user's click,
 * so the tool's answer never says a change was accepted.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  isBranchName,
  PULL_REQUEST_BODY_MAX_CHARS,
  PULL_REQUEST_TITLE_MAX_CHARS,
} from "@oncue/protocol";
import type { CommitToolCall, DescribeToolCall, PolicyToolCall } from "./agent";
import { cleanCommitMessage } from "./commit-message";
import { RELAY_HOST } from "./relay";
import { SECRET_TOOL_NAME } from "./secrets";

export const TOOL_SERVER_PATH = "/mcp";
/** The name OpenCode's config gives the server; the model sees the tool as `<name>_<tool>`. */
export const TOOL_SERVER_NAME = "oncue";
export const POLICY_TOOL_NAME = "policy_propose";
/** One JSON-RPC message is small; anything larger is not one of ours. */
export const MAX_TOOL_REQUEST_BYTES = 64 * 1024;

const COMMIT_VALUES = ["auto", "manual"] as const;
const PUSH_VALUES = ["auto", "manual", "never"] as const;
const PULL_REQUEST_VALUES = ["auto_after_verification", "manual", "never"] as const;
const MAX_RATIONALE_CHARS = 500;

export const POLICY_TOOL_DEFINITION = {
  name: POLICY_TOOL_NAME,
  description:
    "Propose a change to this session's Git policy when the user's message asks for one, for example 'push this and open a draft PR', 'stop pushing', or 'do not commit until I say'. Set only the fields the user asked to change. A change that removes authority takes effect at once. A change that adds authority does nothing until the user confirms it in OnCue, so never assume it was accepted and never try to push or open a pull request yourself. If the user's instruction is ambiguous, ask them instead of calling this.",
  inputSchema: {
    type: "object",
    properties: {
      commit: {
        type: "string",
        enum: COMMIT_VALUES,
        description: "auto: commit coherent checkpoints. manual: commit only when told.",
      },
      push: {
        type: "string",
        enum: PUSH_VALUES,
        description:
          "auto: push the session branch after a run. manual: do not push unless the user turns it on. never: push nothing, checkpoints included.",
      },
      pullRequest: {
        type: "string",
        enum: PULL_REQUEST_VALUES,
        description:
          "auto_after_verification: open or update a draft pull request after a pushed, verified run. manual or never: do not.",
      },
      rationale: {
        type: "string",
        description: "One sentence quoting or paraphrasing what the user asked for.",
      },
    },
    required: ["rationale"],
    additionalProperties: false,
  },
} as const;

export const POLICY_TOOL_ANSWER =
  "The proposal was sent to OnCue. If it only removes authority it is now in force. If it adds any, it is waiting for the user to confirm it in the OnCue session, and nothing will be pushed and no pull request opened until they do. Do not push or open a pull request yourself. Tell the user what you proposed.";

export type ToolAnswer =
  | { readonly status: 200; readonly body: Readonly<Record<string, unknown>> }
  /** A notification: accepted, nothing to say. */
  | { readonly status: 202; readonly body: null }
  | { readonly status: 400; readonly body: null };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return values.includes(value as T) ? (value as T) : null;
}

/** Null when the arguments are not ones the tool accepts. A call that changes no field is not a proposal. */
export function parsePolicyToolCall(args: unknown): PolicyToolCall | null {
  const record = asRecord(args);
  if (record === null) {
    return null;
  }
  const commit = oneOf(COMMIT_VALUES, record.commit);
  const push = oneOf(PUSH_VALUES, record.push);
  const pullRequest = oneOf(PULL_REQUEST_VALUES, record.pullRequest);
  const rationale = record.rationale;
  if (
    commit === null ||
    push === null ||
    pullRequest === null ||
    typeof rationale !== "string" ||
    rationale.trim() === "" ||
    (commit === undefined && push === undefined && pullRequest === undefined)
  ) {
    return null;
  }
  return { commit, push, pullRequest, rationale: rationale.trim().slice(0, MAX_RATIONALE_CHARS) };
}

function result(id: unknown, value: Readonly<Record<string, unknown>>): ToolAnswer {
  return { status: 200, body: { jsonrpc: "2.0", id, result: value } };
}

function failure(id: unknown, code: number, message: string): ToolAnswer {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function toolText(text: string, isError: boolean): Readonly<Record<string, unknown>> {
  return { content: [{ type: "text", text }], isError };
}

/**
 * The tool an agent calls for a development secret (record 08). OpenCode holds
 * the call until the bridge answers for the user (`secrets.ts`), and the answer
 * comes from what the supervisor actually wrote, never from how the call was
 * reached.
 */
export const SECRET_TOOL_DEFINITION = {
  name: SECRET_TOOL_NAME,
  description:
    "Ask for a development secret this project declares in .oncue/project.yaml, by its exact name (for example STRIPE_TEST_KEY). Use it when a command or test needs a credential you do not have. Calling it pauses the run while the user decides in OnCue; if they approve, the answer says which file holds the value. If they deny it or do not answer, continue without it and say what could not be done. Never ask the user to paste a credential into the chat, never print a secret's value, and never write one into the repository.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The secret's name exactly as the project declares it, such as DATABASE_URL.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

export const DESCRIBE_TOOL_NAME = "pull_request_describe";

export const DESCRIBE_TOOL_DEFINITION = {
  name: DESCRIBE_TOOL_NAME,
  description:
    "Name this session's task branch and write its draft pull request's title and description yourself. Call it once the change is coherent, before you finish, and again if later work changes what the pull request should say. Every field is optional; a field left out keeps what you said before. This pushes nothing and opens nothing: OnCue uses what you wrote when the session's Git policy lets it push or open the draft pull request.",
  inputSchema: {
    type: "object",
    properties: {
      branchName: {
        type: "string",
        description:
          "The task branch's name, for example oncue/fix-login-redirect: oncue/ then lowercase words joined by hyphens, a valid Git ref name. Used at the first push unless the user typed a name; it cannot change once the branch is pushed.",
      },
      title: {
        type: "string",
        description: `The pull request's title: one line, at most ${PULL_REQUEST_TITLE_MAX_CHARS} characters, saying what the change does.`,
      },
      body: {
        type: "string",
        description: `The pull request's description in Markdown, at most ${PULL_REQUEST_BODY_MAX_CHARS} characters: what changed, why, and how you tested it. OnCue appends its own verification section built from the checks it ran, so do not write one, and do not mention people with @.`,
      },
    },
    additionalProperties: false,
  },
} as const;

export const DESCRIBE_TOOL_ANSWER =
  "Saved. OnCue will use it for the branch's first push and for the draft pull request when the session's Git policy allows them. Do not push or open a pull request yourself.";

type Parsed<T> =
  | { readonly ok: true; readonly call: T }
  | { readonly ok: false; readonly why: string };

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value.trim() : null;
}

/** The describe tool's arguments, or the one sentence the model is told when they are not usable. */
export function parseDescribeToolCall(args: unknown): Parsed<DescribeToolCall> {
  const record = asRecord(args);
  if (record === null) {
    return { ok: false, why: "Not saved: the arguments must be an object." };
  }
  const branchName = optionalText(record.branchName);
  const title = optionalText(record.title);
  const body = optionalText(record.body);
  if (branchName === null || title === null || body === null) {
    return { ok: false, why: "Not saved: branchName, title, and body are strings." };
  }
  if (branchName === undefined && title === undefined && body === undefined) {
    return { ok: false, why: "Not saved: give at least one of branchName, title, or body." };
  }
  if (branchName !== undefined && !isBranchName(branchName)) {
    return {
      ok: false,
      why: "Not saved: branchName must start with oncue/ and be a valid Git ref name, such as oncue/fix-login-redirect.",
    };
  }
  if (
    title !== undefined &&
    (title === "" || /[\r\n]/.test(title) || title.length > PULL_REQUEST_TITLE_MAX_CHARS)
  ) {
    return {
      ok: false,
      why: `Not saved: title must be one line of 1 to ${PULL_REQUEST_TITLE_MAX_CHARS} characters.`,
    };
  }
  if (body !== undefined && (body === "" || body.length > PULL_REQUEST_BODY_MAX_CHARS)) {
    return {
      ok: false,
      why: `Not saved: body must be 1 to ${PULL_REQUEST_BODY_MAX_CHARS} characters.`,
    };
  }
  return {
    ok: true,
    call: { branchName: branchName ?? null, title: title ?? null, body: body ?? null },
  };
}

export const COMMIT_TOOL_NAME = "git_commit";

/** Git's own convention for a subject; the whole message is bounded so a commit cannot carry a document. */
export const COMMIT_SUBJECT_MAX_CHARS = 120;
export const COMMIT_MESSAGE_MAX_CHARS = 4 * 1024;

export const COMMIT_TOOL_DEFINITION = {
  name: COMMIT_TOOL_NAME,
  description:
    "Commit the current state of the repository with your own message. Call it when a coherent piece of work is done, the way you would commit as you go, and again for each further piece; OnCue makes the commit with its own Git, so do not run git commit yourself. This pushes nothing: the commits are pushed together when the session's Git policy allows a push, and they keep the messages you wrote. When the user has asked not to commit until they say so, the call is refused and nothing is committed.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: `The commit message: a subject line of at most ${COMMIT_SUBJECT_MAX_CHARS} characters saying what the commit does, then optionally a blank line and a body saying why. At most ${COMMIT_MESSAGE_MAX_CHARS} characters in all.`,
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
} as const;

/** The commit tool's arguments, or the one sentence the model is told when they are not usable. */
export function parseCommitToolCall(args: unknown): Parsed<CommitToolCall> {
  const record = asRecord(args);
  const raw = record?.message;
  if (typeof raw !== "string") {
    return { ok: false, why: "Not committed: give a message, a string." };
  }
  // Cleaned before it is measured, so the bounds hold for what Git gets and
  // the `git.committed` the object stores says exactly what was committed.
  const message = cleanCommitMessage(raw);
  if (message === "") {
    return { ok: false, why: "Not committed: the message is blank." };
  }
  if (message.length > COMMIT_MESSAGE_MAX_CHARS) {
    return {
      ok: false,
      why: `Not committed: the message must be at most ${COMMIT_MESSAGE_MAX_CHARS} characters.`,
    };
  }
  const subject = message.split("\n", 1)[0] as string;
  if (subject.trim() === "" || subject.length > COMMIT_SUBJECT_MAX_CHARS) {
    return {
      ok: false,
      why: `Not committed: the first line is the subject, 1 to ${COMMIT_SUBJECT_MAX_CHARS} characters.`,
    };
  }
  return { ok: true, call: { message } };
}

/** One sentence for the model, and whether it is an error in the tool's own terms. */
export interface ToolText {
  readonly text: string;
  readonly isError: boolean;
}

export interface ToolHandlers {
  readonly onPropose: (call: PolicyToolCall) => void;
  readonly onDescribe: (call: DescribeToolCall) => void;
  /** Answered once the bridge's Git has made the commit, or refused to: the model waits for the result. */
  readonly onCommit: (call: CommitToolCall) => Promise<ToolText>;
  /** What to tell the model about one name. Built from what was written, never from who let the call through. */
  readonly secretAnswer: (name: string) => ToolText;
}

/**
 * One JSON-RPC message in, one answer out. Only a well-formed call reaches its
 * handler; `onCommit` is the one answer that waits for work to finish.
 */
export function handleToolRequest(
  message: unknown,
  handlers: ToolHandlers,
): ToolAnswer | Promise<ToolAnswer> {
  const request = asRecord(message);
  if (request === null || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { status: 400, body: null };
  }
  if (request.id === undefined) {
    return { status: 202, body: null };
  }
  const params = asRecord(request.params);
  switch (request.method) {
    case "initialize":
      return result(request.id, {
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: TOOL_SERVER_NAME, version: "1" },
      });
    case "ping":
      return result(request.id, {});
    case "tools/list":
      return result(request.id, {
        tools: [
          POLICY_TOOL_DEFINITION,
          DESCRIBE_TOOL_DEFINITION,
          COMMIT_TOOL_DEFINITION,
          SECRET_TOOL_DEFINITION,
        ],
      });
    case "tools/call": {
      if (params?.name === SECRET_TOOL_NAME) {
        const name = asRecord(params.arguments)?.name;
        if (typeof name !== "string") {
          return result(request.id, toolText("Not asked: name the secret you need.", true));
        }
        const answer = handlers.secretAnswer(name);
        return result(request.id, toolText(answer.text, answer.isError));
      }
      if (params?.name === DESCRIBE_TOOL_NAME) {
        const parsed = parseDescribeToolCall(params.arguments);
        if (!parsed.ok) {
          return result(request.id, toolText(parsed.why, true));
        }
        handlers.onDescribe(parsed.call);
        return result(request.id, toolText(DESCRIBE_TOOL_ANSWER, false));
      }
      if (params?.name === COMMIT_TOOL_NAME) {
        const parsed = parseCommitToolCall(params.arguments);
        if (!parsed.ok) {
          return result(request.id, toolText(parsed.why, true));
        }
        const id = request.id;
        return handlers
          .onCommit(parsed.call)
          .then((answer) => result(id, toolText(answer.text, answer.isError)));
      }
      if (params?.name !== POLICY_TOOL_NAME) {
        return failure(request.id, -32602, "unknown tool");
      }
      const call = parsePolicyToolCall(params.arguments);
      if (call === null) {
        return result(
          request.id,
          toolText(
            "Not sent: set at least one of commit, push, or pullRequest to one of its listed values, with a rationale.",
            true,
          ),
        );
      }
      handlers.onPropose(call);
      return result(request.id, toolText(POLICY_TOOL_ANSWER, false));
    }
    default:
      return failure(request.id, -32601, "method not found");
  }
}

/** OnCue's four tools, in the order `tools/list` gives them: one list for every way a harness is handed them. */
export const ONCUE_TOOL_DEFINITIONS = [
  POLICY_TOOL_DEFINITION,
  DESCRIBE_TOOL_DEFINITION,
  COMMIT_TOOL_DEFINITION,
  SECRET_TOOL_DEFINITION,
] as const;

/**
 * One of OnCue's tools called in-process, for a harness that hands tool calls
 * to the bridge over its own channel (Codex's dynamic tools). The same
 * `handleToolRequest` answers, so there is one implementation of the tools.
 */
export async function callOnCueTool(
  name: string,
  args: unknown,
  handlers: ToolHandlers,
): Promise<ToolText> {
  const answer = await handleToolRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    handlers,
  );
  const body = answer.body ?? {};
  const called = asRecord(body.result);
  if (called === null) {
    return { text: `OnCue has no tool named ${name}.`, isError: true };
  }
  const content = Array.isArray(called.content) ? called.content : [];
  const text = content
    .map((item) => {
      const record = asRecord(item);
      return typeof record?.text === "string" ? record.text : "";
    })
    .join("\n");
  return { text, isError: called.isError === true };
}

export interface ToolServer {
  readonly port: number;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_TOOL_REQUEST_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

function parseJson(text: string | null): unknown {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: ToolHandlers,
): Promise<void> {
  if (request.url !== TOOL_SERVER_PATH) {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== "POST") {
    // No server-initiated stream: the tool only ever answers a call.
    response.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const answer = await handleToolRequest(parseJson(await readBody(request)), handlers);
  if (answer.body === null) {
    response.writeHead(answer.status).end();
    return;
  }
  response.writeHead(answer.status, { "content-type": "application/json" });
  response.end(JSON.stringify(answer.body));
}

/** Binds loopback on a port the kernel picks, as the relay does. */
export function startToolServer(
  options: ToolHandlers & { readonly port?: number },
): Promise<ToolServer> {
  const server = createServer((request, response) => {
    void serve(request, response, options);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, RELAY_HOST, () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Records OpenCode's subagent wire into
 * `fixtures/opencode-subagents-recorded.jsonl`: every server-sent event in
 * order, with marker lines naming each phase. The subagent tagging in
 * `opencode-wire.ts` and `subagents.ts` is built against this recording.
 *
 * It drives the pinned OpenCode against a scripted model on loopback: no key,
 * no model credit, no network beyond loopback. OpenCode runs with the
 * permission rules the bridge writes for subagents (`task` asked for `general`
 * and `explore`, denied for every other name; `subagent_depth: 1`) in a
 * temporary home and work tree, with project configuration off. The script
 * answers each `task` permission ask itself, as the bridge does.
 *
 * Phases: two subagents started by one assistant message (run side by side);
 * a subagent whose model call fails; and a subagent stopped through
 * `POST /session/{child}/abort` while it runs a shell command.
 *
 *   pnpm --filter @oncue/bridge exec tsx scripts/record-opencode-subagents.ts
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? join(userInfo().homedir, ".opencode/bin/opencode");
const OUT_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));
const OPENCODE_PORT = 4794;
const MODEL_ID = "claude-sonnet-4-5-20250929";
const GENERIC_PATH = "/usr/local/bin:/usr/bin:/bin";

interface Recorded {
  readonly at: string;
  readonly event?: unknown;
  readonly marker?: { readonly phase: string; readonly note: string };
}

const now = (): string => new Date().toISOString();
const recorded: Recorded[] = [];
const mark = (phase: string, note: string): void => {
  recorded.push({ at: now(), marker: { phase, note } });
  process.stdout.write(`[${phase}] ${note}\n`);
};

// ---------------------------------------------------------------- scripted model

type Rec = Record<string, unknown>;

function sse(type: string, body: Rec): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
}

let served = 0;

function messageStart(): string {
  served += 1;
  return sse("message_start", {
    message: {
      id: `msg_stub_${served}`,
      type: "message",
      role: "assistant",
      model: MODEL_ID,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  });
}

function end(stopReason: string): string {
  return (
    sse("message_delta", {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 7 },
    }) + sse("message_stop", {})
  );
}

function textStream(text: string): string {
  let out = messageStart();
  out += sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (const word of text.split(/(?<= )/)) {
    out += sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: word } });
  }
  out += sse("content_block_stop", { index: 0 });
  return out + end("end_turn");
}

function callsStream(calls: readonly { name: string; input: Rec }[]): string {
  let out = messageStart();
  calls.forEach((call, index) => {
    out += sse("content_block_start", {
      index,
      content_block: {
        type: "tool_use",
        id: `toolu_stub_${served}_${index}`,
        name: call.name,
        input: {},
      },
    });
    out += sse("content_block_delta", {
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
    });
    out += sse("content_block_stop", { index });
  });
  return out + end("tool_use");
}

/** The first user text of the conversation: the task, or a subagent's prompt. */
function firstUserText(body: Rec): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Rec[]) : [];
  const first = messages.find((message) => message.role === "user");
  return JSON.stringify(first?.content ?? "");
}

function newestCarriesResult(body: Rec): boolean {
  const messages = Array.isArray(body.messages) ? (body.messages as Rec[]) : [];
  return JSON.stringify(messages.at(-1) ?? null).includes('"tool_result"');
}

/** What the scripted model answers, judged on the conversation's own words. */
function answer(body: Rec): { status: number; body: string; stream: boolean } {
  const offersTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (!offersTools) {
    return { status: 200, body: textStream("Subagent recording"), stream: true };
  }
  const first = firstUserText(body);
  const done = newestCarriesResult(body);
  if (first.includes("SUB-FAIL")) {
    return {
      status: 400,
      body: JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "scripted failure for the recording" },
      }),
      stream: false,
    };
  }
  if (first.includes("SUB-SLOW")) {
    return done
      ? { status: 200, body: textStream("The slow subagent finished."), stream: true }
      : {
          status: 200,
          body: callsStream([
            { name: "bash", input: { command: "sleep 30", description: "Wait a while" } },
          ]),
          stream: true,
        };
  }
  if (first.includes("SUB-A")) {
    return done
      ? { status: 200, body: textStream("Subagent A found it in src/a.ts."), stream: true }
      : {
          status: 200,
          body: callsStream([
            { name: "bash", input: { command: "ls", description: "List files" } },
          ]),
          stream: true,
        };
  }
  if (first.includes("SUB-B")) {
    return done
      ? { status: 200, body: textStream("Subagent B read the README."), stream: true }
      : {
          status: 200,
          body: callsStream([{ name: "glob", input: { pattern: "*.md" } }]),
          stream: true,
        };
  }
  if (done) {
    return { status: 200, body: textStream("Both subagents reported back."), stream: true };
  }
  if (first.includes("PHASE-PARALLEL")) {
    return {
      status: 200,
      body: callsStream([
        {
          name: "task",
          input: {
            description: "Find the A file",
            prompt: "SUB-A Find where A is defined and report back.",
            subagent_type: "general",
          },
        },
        {
          name: "task",
          input: {
            description: "Read the README",
            prompt: "SUB-B Read the README and summarise it.",
            subagent_type: "explore",
          },
        },
      ]),
      stream: true,
    };
  }
  if (first.includes("PHASE-FAIL")) {
    return {
      status: 200,
      body: callsStream([
        {
          name: "task",
          input: {
            description: "A subagent that fails",
            prompt: "SUB-FAIL This one fails.",
            subagent_type: "general",
          },
        },
      ]),
      stream: true,
    };
  }
  if (first.includes("PHASE-STOP")) {
    return {
      status: 200,
      body: callsStream([
        {
          name: "task",
          input: {
            description: "A slow subagent",
            prompt: "SUB-SLOW Take your time.",
            subagent_type: "general",
          },
        },
      ]),
      stream: true,
    };
  }
  return { status: 200, body: textStream("Done."), stream: true };
}

const stub = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    if (request.method !== "POST" || !(request.url ?? "").startsWith("/v1/messages")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    let body: Rec = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Rec;
    } catch {
      body = {};
    }
    const reply = answer(body);
    response.writeHead(reply.status, {
      "content-type": reply.stream ? "text/event-stream" : "application/json",
    });
    response.end(reply.body);
  });
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", () => resolve()));
const stubAddress = stub.address();
const stubPort = typeof stubAddress === "object" && stubAddress !== null ? stubAddress.port : 0;

// ---------------------------------------------------------------- OpenCode

const scratch = mkdtempSync(join(tmpdir(), "oncue-subagents-"));
const home = join(scratch, "home");
const work = join(scratch, "work");
for (const dir of [
  home,
  work,
  join(home, ".tmp"),
  join(home, ".config"),
  join(home, ".local/share"),
]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(work, "README.md"), "# Recording\n\nA tiny work tree.\n");
mkdirSync(join(work, "src"));
writeFileSync(join(work, "src", "a.ts"), "export const a = 1;\n");

const config = {
  share: "disabled",
  autoupdate: false,
  snapshot: false,
  model: `anthropic/${MODEL_ID}`,
  provider: {
    anthropic: { options: { baseURL: `http://127.0.0.1:${stubPort}/v1`, apiKey: "oncue-relay" } },
  },
  permission: {
    task: { "*": "deny", general: "ask", explore: "ask" },
    question: "deny",
  },
  subagent_depth: 1,
};

const child = spawn(
  OPENCODE_BIN,
  ["serve", "--port", String(OPENCODE_PORT), "--hostname", "127.0.0.1", "--log-level", "WARN"],
  {
    cwd: work,
    env: {
      PATH: GENERIC_PATH,
      HOME: home,
      LANG: "C.UTF-8",
      TMPDIR: join(home, ".tmp"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    },
    stdio: ["ignore", "ignore", "ignore"],
  },
);

// However the script ends, the server it started goes with it.
process.on("exit", () => child.kill("SIGKILL"));

const origin = `http://127.0.0.1:${OPENCODE_PORT}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(): Promise<string> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch(`${origin}/global/health`);
      if (response.ok) {
        return String(((await response.json()) as { version?: string }).version);
      }
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error("opencode never answered health");
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok && response.status !== 204) {
    throw new Error(`${path} answered ${response.status}: ${text}`);
  }
  return text.length === 0 ? null : JSON.parse(text);
}

function typeOf(event: unknown): string {
  return String((event as Rec | null)?.type ?? "");
}

function propsOf(event: unknown): Rec {
  return ((event as Rec | null)?.properties ?? {}) as Rec;
}

/** Answers every `task` ask as the bridge does: once. */
const answered = new Set<string>();
async function answerAsks(): Promise<void> {
  for (const line of recorded) {
    if (typeOf(line.event) !== "permission.asked") {
      continue;
    }
    const props = propsOf(line.event);
    const id = String(props.id);
    if (answered.has(id) || props.permission !== "task") {
      continue;
    }
    answered.add(id);
    await post(`/permission/${id}/reply`, { reply: "once" });
  }
}

async function waitFor(predicate: (event: unknown) => boolean, from: number): Promise<number> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await answerAsks();
    for (let index = from; index < recorded.length; index += 1) {
      if (predicate(recorded[index]?.event)) {
        return index;
      }
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for an event");
}

const version = await waitForHealth();
const controller = new AbortController();
const stream = await fetch(`${origin}/event`, { signal: controller.signal });
const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
void (async () => {
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      pending += decoder.decode(value, { stream: true });
      for (;;) {
        const split = pending.indexOf("\n\n");
        if (split === -1) {
          break;
        }
        const frame = pending.slice(0, split);
        pending = pending.slice(split + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data.length > 0) {
          recorded.push({ at: now(), event: JSON.parse(data) });
        }
      }
    }
  } catch {
    // Aborted at the end.
  }
})();
await sleep(500);

async function phase(name: string, note: string, text: string): Promise<string> {
  mark(name, note);
  const from = recorded.length;
  const session = (await post("/session", { title: name })) as { id: string };
  await post(`/session/${session.id}/prompt_async`, {
    model: { providerID: "anthropic", modelID: MODEL_ID },
    parts: [{ type: "text", text }],
  });
  return `${session.id}|${from}`;
}

const isIdleOf = (sessionId: string) => (event: unknown) =>
  typeOf(event) === "session.idle" && propsOf(event).sessionID === sessionId;

{
  const [id, from] = (
    await phase("parallel", "two subagents from one message", "PHASE-PARALLEL")
  ).split("|");
  await waitFor(isIdleOf(id as string), Number(from));
  await sleep(500);
}
{
  const [id, from] = (
    await phase("failure", "a subagent whose model call fails", "PHASE-FAIL")
  ).split("|");
  await waitFor(isIdleOf(id as string), Number(from));
  await sleep(500);
}
{
  const [id, from] = (
    await phase("stop", "a subagent stopped while it runs a command", "PHASE-STOP")
  ).split("|");
  const created = await waitFor(
    (event) =>
      typeOf(event) === "session.created" &&
      (propsOf(event).info as Rec | undefined)?.parentID === id,
    Number(from),
  );
  const childId = String(propsOf(recorded[created]?.event).sessionID);
  await waitFor(
    (event) =>
      typeOf(event) === "message.part.updated" &&
      ((propsOf(event).part as Rec | undefined)?.tool as string | undefined) === "bash" &&
      (((propsOf(event).part as Rec | undefined)?.state as Rec | undefined)?.status as string) ===
        "running",
    created,
  );
  mark("stop", "POST /session/{child}/abort");
  await post(`/session/${childId}/abort`, {});
  await waitFor(isIdleOf(id as string), created);
  await sleep(500);
}

controller.abort();
// Waited for, so nothing is still writing into the scratch when it is removed.
await new Promise<void>((resolve) => {
  child.once("exit", () => resolve());
  child.kill("SIGTERM");
});
stub.close();

// ---------------------------------------------------------------- scrub and write

const replacements: [string, string][] = [];
// The resolved form first: `/var/...` is a suffix of `/private/var/...`.
for (const path of [realpathSync(scratch), scratch]) {
  replacements.push(
    [join(path, "home"), "/home/agent"],
    [join(path, "work"), "/workspace"],
    [path, "/scratch"],
  );
}
replacements.push([userInfo().username, "user"]);
let text = recorded.map((line) => JSON.stringify(line)).join("\n");
for (const [from, to] of replacements) {
  text = text.split(from).join(to);
}
text = text.replace(/"PATH":"[^"]*"/g, `"PATH":"${GENERIC_PATH}"`);
if (text.includes(tmpdir()) || text.includes(userInfo().homedir)) {
  throw new Error("refusing to write: a machine path survived the scrub");
}
writeFileSync(join(OUT_DIR, "opencode-subagents-recorded.jsonl"), `${text}\n`);
writeFileSync(
  join(OUT_DIR, "opencode-subagents-recorded.meta.json"),
  `${JSON.stringify({ recordedAt: now(), opencodeVersion: version, model: "scripted", lines: recorded.length }, null, 2)}\n`,
);
rmSync(scratch, { recursive: true, force: true });
process.stdout.write(`wrote ${recorded.length} lines\n`);
process.exit(0);

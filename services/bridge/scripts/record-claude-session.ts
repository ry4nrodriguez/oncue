/**
 * Records one Claude Code stream-json session into
 * `fixtures/claude-session-recorded.jsonl`: every line in both directions, in
 * order, with marker lines naming each phase. The Claude adapter's parser is
 * currently built from the Agent SDK's type declarations
 * (`fixtures/claude-stream-json-docs-derived.jsonl`); this recording replaces
 * them with Claude Code's own wire.
 *
 * It drives a real Claude Code binary against a scripted model
 * (`messages-stub.ts`): no key, no model credit, no network beyond loopback.
 * Claude Code starts as the supervisor starts it, under the runtime host with
 * `plannedClaudeSpawn`'s argv and environment, in a temporary work tree and
 * home so it reads none of the machine's own configuration. It starts a coding
 * agent on the machine, so a person runs it:
 *
 *   ONCUE_RECORD_CLAUDE_BIN=/path/to/claude pnpm --filter @oncue/bridge exec tsx scripts/record-claude-session.ts
 */

import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plannedClaudeSpawn } from "../src/claude";
import { createClaudeClient } from "../src/claude-client";
import { type LineChannel, nodeLineChannel } from "../src/codex-client";
import type { RuntimeEvent } from "../src/normalize";
import { startToolServer } from "../src/tool-server";
import { startMessagesStub } from "./messages-stub";

const CLAUDE_BIN = process.env.ONCUE_RECORD_CLAUDE_BIN;
if (CLAUDE_BIN === undefined) {
  throw new Error("set ONCUE_RECORD_CLAUDE_BIN to a claude binary");
}
const OUT_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const HOST = fileURLToPath(new URL("../src/runtime-host-main.ts", import.meta.url));
const PORT = 4792;
const MODEL = { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" } as const;

interface Line {
  readonly at: string;
  readonly dir?: "in" | "out";
  readonly message?: unknown;
  readonly marker?: { readonly phase: string; readonly note: string };
}

const recorded: Line[] = [];
const now = (): string => new Date().toISOString();
const mark = (phase: string, note: string): void => {
  recorded.push({ at: now(), marker: { phase, note } });
  process.stdout.write(`[${phase}] ${note}\n`);
};

const stub = await startMessagesStub();
const tools = await startToolServer({
  onPropose: () => {},
  onDescribe: () => {},
  onCommit: async () => ({ text: "Committed.", isError: false }),
  secretAnswer: (name) => ({ text: `${name} is in a file only you can read.`, isError: false }),
});
const work = realpathSync(mkdtempSync(join(tmpdir(), "oncue-record-claude-work-")));
const home = realpathSync(mkdtempSync(join(tmpdir(), "oncue-record-claude-home-")));
writeFileSync(join(work, "README.md"), "# widgets\n");

const plan = plannedClaudeSpawn({
  port: PORT,
  relayPort: stub.port,
  toolPort: tools.port,
  model: MODEL,
  modelSpec: null,
  binary: CLAUDE_BIN,
  cwd: work,
  home,
  hostPaths: { node: TSX, host: HOST },
});
const host = spawn(plan.argv[0] as string, plan.argv.slice(1), {
  cwd: plan.cwd,
  env: { ...plan.env, PATH: `${plan.env.PATH}:${process.env.PATH ?? ""}` },
  stdio: ["ignore", "ignore", "inherit"],
});

/** The same channel the bridge uses, with every line copied into the recording. */
async function recordingChannel(port: number): Promise<LineChannel | null> {
  const channel = await nodeLineChannel(port);
  if (channel === null) {
    return null;
  }
  channel.onLine((line) => recorded.push({ at: now(), dir: "in", message: JSON.parse(line) }));
  return {
    ...channel,
    send: (line) => {
      recorded.push({ at: now(), dir: "out", message: JSON.parse(line) });
      channel.send(line);
    },
  };
}

const events: RuntimeEvent[] = [];
const client = createClaudeClient({
  connect: recordingChannel,
  readFile: () => Promise.reject(new Error("no attachments in the recording")),
});

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let health = await client.health(PORT);
while (health.kind !== "healthy") {
  await new Promise((resolve) => setTimeout(resolve, 200));
  health = await client.health(PORT);
}
void client.subscribe(PORT, (event) => events.push(event), new AbortController().signal);
mark("setup", `claude ${health.version} under the runtime host, scripted model, no key`);

let conversation: string | null = null;
async function turn(text: string): Promise<void> {
  const from = events.length;
  const outcome = await client.prompt(PORT, {
    conversation,
    title: "OnCue run",
    text,
    model: MODEL,
    effort: "low",
  });
  if (outcome.kind !== "held") {
    throw new Error(outcome.detail);
  }
  conversation = outcome.conversation;
  await until(() => events.slice(from).some((event) => event.kind === "session_idle"), "idle");
}

mark("answer", "a plain answer");
stub.push({ kind: "text", text: "Hello from the scripted model." });
await turn("Say hello.");

mark("edit", "a shell command that writes a file, then an answer");
stub.push(
  { kind: "call", name: "Bash", args: { command: "printf ok > health.txt && cat health.txt" } },
  { kind: "text", text: "Wrote health.txt." },
);
await turn("Write health.txt.");

mark("tool", "one of OnCue's tools over MCP");
stub.push(
  { kind: "call", name: "mcp__oncue__policy_propose", args: { push: "auto", rationale: "asked" } },
  { kind: "text", text: "Proposed pushing." },
);
await turn("Push this.");

mark("held", "secret_request asks, and the bridge answers after a while");
stub.push(
  { kind: "call", name: "mcp__oncue__secret_request", args: { name: "STRIPE_TEST_KEY" } },
  { kind: "text", text: "Thanks." },
);
{
  const from = events.length;
  await client.prompt(PORT, {
    conversation,
    title: "t",
    text: "Ask for the key.",
    model: MODEL,
    effort: null,
  });
  await until(
    () => events.slice(from).some((event) => event.kind === "permission_asked"),
    "the ask",
  );
  const asked = events.slice(from).find((event) => event.kind === "permission_asked");
  // Longer than the 60 seconds an MCP tool call is held for.
  await new Promise((resolve) => setTimeout(resolve, 65_000));
  await client.replyHeld(
    PORT,
    asked?.kind === "permission_asked" ? asked.requestId : "",
    "once",
    null,
  );
  await until(() => events.slice(from).some((event) => event.kind === "session_idle"), "idle");
}

mark("interrupt", "a turn that hangs, a second message into it, then an interrupt");
stub.push({ kind: "hang" });
{
  const from = events.length;
  const before = stub.requests.length;
  await client.prompt(PORT, {
    conversation,
    title: "t",
    text: "Take your time.",
    model: MODEL,
    effort: null,
  });
  await until(() => stub.requests.length > before, "the hanging request");
  await client.prompt(PORT, {
    conversation,
    title: "t",
    text: "Also check the README.",
    model: MODEL,
    effort: null,
  });
  await client.abort(PORT, conversation ?? "");
  await until(() => events.slice(from).some((event) => event.kind === "session_idle"), "idle");
}

mark("follow_up", "a new turn after the interrupt");
stub.push({ kind: "text", text: "Still here." });
await turn("Are you there?");

host.kill("SIGTERM");
await stub.close();
await tools.close();

// Scrub what names this machine: paths and the host name.
const scrub = (text: string): string =>
  text
    .split(work)
    .join("/workspace")
    .split(home)
    .join("/home/oncue-agent")
    .split(hostname())
    .join("sandbox");
writeFileSync(
  join(OUT_DIR, "claude-session-recorded.jsonl"),
  `${recorded.map((line) => scrub(JSON.stringify(line))).join("\n")}\n`,
);
writeFileSync(
  join(OUT_DIR, "claude-session-recorded.meta.json"),
  `${JSON.stringify(
    {
      recordedAt: now(),
      claudeVersion: health.version,
      model: "scripted (scripts/messages-stub.ts); not a real model",
      requests: stub.requests.map((request) => ({
        method: request.method,
        path: request.path,
        status: request.status,
        scripted: request.scripted,
        headerNames: request.headerNames,
        model: request.body?.model ?? null,
        bodyKeys: request.body === null ? null : Object.keys(request.body).sort(),
        outputConfig: request.body?.output_config ?? null,
        thinking: request.body?.thinking ?? null,
      })),
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`recorded ${recorded.length} lines\n`);
process.exit(0);

/**
 * Records one Codex app-server session into
 * `fixtures/codex-session-recorded.jsonl`: every JSON-RPC line in both
 * directions, in order, with marker lines naming each phase.
 *
 * It drives a real Codex binary against a scripted model (`responses-stub.ts`):
 * no key, no model credit, no network beyond loopback. Codex starts as the
 * supervisor starts it, under the runtime host with `plannedCodexSpawn`'s argv
 * and environment, in a temporary work tree and an isolated `CODEX_HOME`.
 * Paths, the host name, and installation ids are scrubbed.
 *
 *   ONCUE_RECORD_CODEX_BIN=/path/to/codex pnpm --filter @oncue/bridge exec tsx scripts/record-codex-session.ts
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plannedCodexSpawn } from "../src/codex";
import { createCodexClient, type LineChannel, nodeLineChannel } from "../src/codex-client";
import type { RuntimeEvent } from "../src/normalize";
import { startResponsesStub } from "./responses-stub";

const CODEX_BIN = process.env.ONCUE_RECORD_CODEX_BIN;
if (CODEX_BIN === undefined) {
  throw new Error("set ONCUE_RECORD_CODEX_BIN to a codex binary");
}
const OUT_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const HOST = fileURLToPath(new URL("../src/runtime-host-main.ts", import.meta.url));
const PORT = 4791;

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

const stub = await startResponsesStub();
const work = realpathSync(mkdtempSync(join(tmpdir(), "oncue-record-codex-work-")));
const home = realpathSync(mkdtempSync(join(tmpdir(), "oncue-record-codex-home-")));
mkdirSync(join(home, ".codex"), { mode: 0o700 });
execFileSync("git", ["init", "-q", work]);
writeFileSync(join(work, "README.md"), "# widgets\n");

const plan = plannedCodexSpawn({
  port: PORT,
  relayPort: stub.port,
  toolPort: 0,
  model: { provider: "openai", modelId: "gpt-6-sol" },
  modelSpec: null,
  binary: CODEX_BIN,
  cwd: work,
  home,
  hostPaths: { node: TSX, host: HOST },
  pathPrefix: "/usr/local/bin",
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
const client = createCodexClient({
  connect: recordingChannel,
  callTool: async (name) => ({ text: `OnCue ran ${name}.`, isError: false }),
  cwd: work,
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
mark("setup", `codex ${health.version} under the runtime host, scripted model, no key`);

const model = { provider: "openai", modelId: "gpt-6-sol" } as const;
async function turn(
  conversation: string | null,
  text: string,
  effort: "low" | null,
): Promise<string> {
  const from = events.length;
  const outcome = await client.prompt(PORT, {
    conversation,
    title: "OnCue run",
    text,
    model,
    effort,
  });
  if (outcome.kind !== "held") {
    throw new Error(outcome.detail);
  }
  await until(() => events.slice(from).some((event) => event.kind === "session_idle"), "idle");
  return outcome.conversation;
}

mark("answer", "a plain answer");
stub.push({ kind: "text", text: "Hello from the scripted model." });
const thread = await turn(null, "Say hello.", "low");

mark("edit", "a shell command that writes a file, then an answer");
stub.push(
  { kind: "call", name: "exec_command", args: { cmd: "printf ok > health.txt && cat health.txt" } },
  { kind: "text", text: "Wrote health.txt." },
);
await turn(thread, "Write health.txt.", null);

mark("tool", "one of OnCue's tools, answered by the bridge");
stub.push(
  { kind: "call", name: "oncue_policy_propose", args: { push: "auto", rationale: "asked" } },
  { kind: "text", text: "Proposed pushing." },
);
await turn(thread, "Push this.", null);

mark("held", "secret_request held by the bridge, then allowed");
stub.push(
  { kind: "call", name: "oncue_secret_request", args: { name: "STRIPE_TEST_KEY" } },
  { kind: "text", text: "Thanks." },
);
{
  const from = events.length;
  await client.prompt(PORT, {
    conversation: thread,
    title: "t",
    text: "Ask for the key.",
    model,
    effort: null,
  });
  await until(
    () => events.slice(from).some((event) => event.kind === "permission_asked"),
    "the ask",
  );
  const asked = events.slice(from).find((event) => event.kind === "permission_asked");
  await client.replyHeld(
    PORT,
    asked?.kind === "permission_asked" ? asked.requestId : "",
    "once",
    null,
  );
  await until(() => events.slice(from).some((event) => event.kind === "session_idle"), "idle");
}

mark("steer_and_abort", "a turn that hangs, a steer into it, then an interrupt");
stub.push({ kind: "hang" });
{
  const from = events.length;
  const before = stub.requests.length;
  await client.prompt(PORT, {
    conversation: thread,
    title: "t",
    text: "Take your time.",
    model,
    effort: null,
  });
  await until(() => stub.requests.length > before, "the hanging request");
  await client.prompt(PORT, {
    conversation: thread,
    title: "t",
    text: "Also check the README.",
    model,
    effort: null,
  });
  await client.abort(PORT, thread);
  await until(() => events.slice(from).some((event) => event.kind === "session_idle"), "idle");
}

mark("follow_up", "a new turn on the same thread after the abort");
stub.push({ kind: "text", text: "Still here." });
await turn(thread, "Are you there?", null);

host.kill("SIGTERM");
await stub.close();

// Scrub what names this machine: paths, the host name, installation ids.
const scrub = (text: string): string =>
  text
    .split(work)
    .join("/workspace")
    .split(home)
    .join("/home/oncue-agent")
    .split(hostname())
    .join("sandbox")
    .replace(/"installationId":"[^"]+"/g, '"installationId":"00000000-0000-0000-0000-000000000000"')
    .replace(/"processId":"\d+"/g, '"processId":"1"')
    .replace(/\((Mac OS|Linux)[^)]*\)/g, "(os)");
const lines = recorded.map((line) => scrub(JSON.stringify(line))).join("\n");
writeFileSync(join(OUT_DIR, "codex-session-recorded.jsonl"), `${lines}\n`);
writeFileSync(
  join(OUT_DIR, "codex-session-recorded.meta.json"),
  `${JSON.stringify(
    {
      recordedAt: now(),
      codexVersion: health.version,
      model: "scripted (scripts/responses-stub.ts); not a real model",
      requests: stub.requests.map((request) => ({
        path: request.path,
        headerNames: request.headerNames,
        bodyKeys: Object.keys(request.body).sort(),
        tools: ((request.body.tools as Array<{ name?: string; type?: string }>) ?? []).map(
          (tool) => tool.name ?? tool.type,
        ),
        reasoning: request.body.reasoning ?? null,
      })),
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`recorded ${recorded.length} lines\n`);
process.exit(0);

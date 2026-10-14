/**
 * The Codex adapter against a real Codex binary, started as the supervisor
 * would start it, with a scripted Responses stand-in as the model
 * (`scripts/responses-stub.ts`). No key, no network beyond loopback, and an
 * isolated `CODEX_HOME`. Runs only where `ONCUE_TEST_CODEX_BIN` names a
 * `codex` binary, since the repository ships none.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ResponsesStub, startResponsesStub } from "../scripts/responses-stub";
import { CODEX_RUNTIME, plannedCodexSpawn } from "./codex";
import { createCodexClient, nodeLineChannel } from "./codex-client";
import { advance, emptyNormalizerState, type RuntimeEvent } from "./normalize";
import type { RuntimeClient } from "./runtime";

const CODEX_BIN = process.env.ONCUE_TEST_CODEX_BIN;

/** Every tool a Responses request declares: top-level `tools`, and any `additional_tools` input item, namespaces flattened. */
function declaredToolNames(body: Readonly<Record<string, unknown>>): string[] {
  const names: string[] = [];
  const walk = (tools: unknown): void => {
    if (!Array.isArray(tools)) {
      return;
    }
    for (const raw of tools) {
      const tool = raw as { name?: unknown; tools?: unknown };
      if (Array.isArray(tool.tools)) {
        walk(tool.tools);
      } else if (typeof tool.name === "string") {
        names.push(tool.name);
      }
    }
  };
  walk(body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      walk((item as { tools?: unknown }).tools);
    }
  }
  return names;
}
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const HOST = fileURLToPath(new URL("./runtime-host-main.ts", import.meta.url));

describe.skipIf(CODEX_BIN === undefined)(
  "Codex under the runtime host, against a scripted model",
  () => {
    let stub: ResponsesStub;
    let host: ChildProcess;
    let client: RuntimeClient;
    let work: string;
    const events: RuntimeEvent[] = [];
    const toolCalls: Array<{ name: string; args: unknown }> = [];
    const port = 4600 + Math.floor(Math.random() * 300);

    async function until(check: () => boolean, what: string, ms = 30_000): Promise<void> {
      const deadline = Date.now() + ms;
      while (!check()) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    beforeAll(async () => {
      stub = await startResponsesStub();
      work = mkdtempSync(join(tmpdir(), "oncue-codex-work-"));
      const home = mkdtempSync(join(tmpdir(), "oncue-codex-home-"));
      // The image creates the agent's `CODEX_HOME`; Codex will not start without it.
      mkdirSync(join(home, ".codex"), { mode: 0o700 });
      const plan = plannedCodexSpawn({
        port,
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
      // The supervisor would run exactly this, as the agent user.
      expect(plan.argv.slice(2, 6)).toEqual(["--port", String(port), "--", CODEX_BIN]);
      host = spawn(plan.argv[0] as string, plan.argv.slice(1), {
        cwd: plan.cwd,
        env: { ...plan.env, PATH: `${plan.env.PATH}:${process.env.PATH ?? ""}` },
        stdio: ["ignore", "ignore", "ignore"],
      });
      client = createCodexClient({
        connect: nodeLineChannel,
        callTool: async (name, args) => {
          toolCalls.push({ name, args });
          return { text: `OnCue ran ${name}.`, isError: false };
        },
        cwd: work,
      });
      let health = await client.health(port);
      const deadline = Date.now() + 30_000;
      while (health.kind !== "healthy" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        health = await client.health(port);
      }
      expect(health).toMatchObject({ kind: "healthy" });
      void client.subscribe(port, (event) => events.push(event), new AbortController().signal);
      await until(() => events.some((event) => event.kind === "server_connected"), "the stream");
    }, 60_000);

    afterAll(async () => {
      host?.kill("SIGTERM");
      await stub?.close();
    });

    let thread: string | null = null;

    it("runs a shell command and one of OnCue's tools, and answers in text", async () => {
      stub.push(
        { kind: "call", name: "exec_command", args: { cmd: "printf ok > health.txt" } },
        { kind: "call", name: "oncue_policy_propose", args: { push: "auto", rationale: "asked" } },
        { kind: "text", text: "Wrote health.txt and proposed pushing." },
      );
      const from = events.length;
      const outcome = await client.prompt(port, {
        conversation: null,
        title: "OnCue run run_1",
        text: "Write health.txt, then propose pushing.",
        model: { provider: "openai", modelId: "gpt-6-sol" },
        effort: "low",
      });
      expect(outcome.kind).toBe("held");
      thread = outcome.kind === "held" ? outcome.conversation : null;
      await until(() => events.slice(from).some((event) => event.kind === "session_idle"), "idle");

      expect(readFileSync(join(work, "health.txt"), "utf8")).toBe("ok");
      expect(toolCalls).toEqual([
        { name: "policy_propose", args: { push: "auto", rationale: "asked" } },
      ]);
      const turn = events.slice(from);
      const tools = turn.flatMap((event) => (event.kind === "tool_part" ? [event.part] : []));
      expect(
        tools.find((part) => part.tool === "exec_command" && part.status === "completed"),
      ).toBeDefined();
      expect(
        tools.find((part) => part.tool === "oncue_policy_propose" && part.status === "completed"),
      ).toMatchObject({ output: "OnCue ran policy_propose." });
      expect(turn).toContainEqual(
        expect.objectContaining({
          kind: "text_part",
          text: "Wrote health.txt and proposed pushing.",
        }),
      );

      // OnCue's four tools and no subagents. 0.157 declares tools in an
      // `additional_tools` input item, most reachable through code mode's `exec`.
      const body = stub.requests[0]?.body ?? {};
      const offered = declaredToolNames(body);
      const described = JSON.stringify(body);
      for (const name of [
        "exec_command",
        "oncue_policy_propose",
        "oncue_pull_request_describe",
        "oncue_git_commit",
        "oncue_secret_request",
      ]) {
        expect(offered.includes(name) || described.includes(name)).toBe(true);
      }
      expect(offered.some((name) => name.includes("agent"))).toBe(false);
      expect(described).not.toContain("spawn_agent");
      expect(stub.requests[0]?.body.reasoning).toMatchObject({ effort: "low" });
      expect(stub.requests[0]?.headerNames).not.toContain("authorization");

      // The normalizer turns the turn into the protocol's rows.
      let state = emptyNormalizerState;
      const drafts: string[] = [];
      for (const event of turn) {
        const next = advance(state, event, {
          nowMs: Date.now(),
          newId: () => "id",
          runId: "run_1",
          contextWindow: null,
          runtime: CODEX_RUNTIME,
        });
        state = next.state;
        drafts.push(...next.drafts.map((draft) => draft.type));
      }
      expect(drafts).toEqual(
        expect.arrayContaining(["tool.requested", "tool.completed", "message.completed"]),
      );
    }, 90_000);

    it("holds secret_request until the reply, then gives Codex the answer", async () => {
      stub.push(
        { kind: "call", name: "oncue_secret_request", args: { name: "STRIPE_TEST_KEY" } },
        { kind: "text", text: "Thanks." },
      );
      const from = events.length;
      const before = stub.requests.length;
      await client.prompt(port, {
        conversation: thread,
        title: "t",
        text: "Ask for the Stripe key.",
        model: { provider: "openai", modelId: "gpt-6-sol" },
        effort: null,
      });
      await until(
        () => events.slice(from).some((event) => event.kind === "permission_asked"),
        "the ask",
      );
      const asked = events.slice(from).find((event) => event.kind === "permission_asked");
      expect(asked).toMatchObject({ permission: "oncue_secret_request" });
      // Nothing reaches the model while the call is held.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(stub.requests.length).toBe(before + 1);
      const requestId = asked?.kind === "permission_asked" ? asked.requestId : "";
      expect(await client.replyHeld(port, requestId, "once", null)).toBe(true);
      await until(() => events.slice(from).some((event) => event.kind === "session_idle"), "idle");
      expect(toolCalls.at(-1)).toEqual({
        name: "secret_request",
        args: { name: "STRIPE_TEST_KEY" },
      });
      const followUp = JSON.stringify(stub.requests.at(-1)?.body.input);
      expect(followUp).toContain("OnCue ran secret_request.");
    }, 90_000);

    it("interrupts a turn and reports it as an abort, then idle", async () => {
      stub.push({ kind: "hang" });
      const from = events.length;
      await client.prompt(port, {
        conversation: thread,
        title: "t",
        text: "Take your time.",
        model: { provider: "openai", modelId: "gpt-6-sol" },
        effort: null,
      });
      await until(
        () =>
          stub.requests.length > 0 &&
          JSON.stringify(stub.requests.at(-1)?.body).includes("Take your time."),
        "the hanging request",
      );
      expect(await client.abort(port, thread ?? "")).toBe(true);
      await until(() => events.slice(from).some((event) => event.kind === "session_idle"), "idle");
      expect(events.slice(from)).toContainEqual(
        expect.objectContaining({ kind: "session_error", name: "MessageAbortedError" }),
      );
    }, 90_000);
  },
);

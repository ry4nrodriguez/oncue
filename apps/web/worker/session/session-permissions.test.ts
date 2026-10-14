// The harness's own permission asks at the object's boundary (record 09,
// "Agent permissions"): the sandbox is trusted for the category, the resource,
// and the tool's kind; the object writes the card, answers from the session's
// mode and rules and the workspace's, saves what a card or the menu chose,
// runs the expiry on its alarm, and tells the bridge `allowed` or no.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { readWorkspaceApprovals, writeWorkspaceDefault } from "../approvals/store";
import {
  allowSubagentStart,
  eventsOfType,
  fireAlarm,
  openClient,
  readyBridge,
  registerSessionWorlds,
  runRowOf,
  type SessionWorld,
  sessionOnRealDriver,
  settle,
  type TestBridge,
  WORLD_TIME,
  waitFor,
} from "../test/session-world";
import { APPROVAL_TTL_MS } from "./approvals";
import { MAX_PERMISSION_ASKS_PER_RUN } from "./permission-asks";
import { MAX_APPROVAL_REFUSALS } from "./session-object";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

/** The real binding, kept before any test swaps the object's, which can be the same object. */
const REAL_DB = env.DB;

let worlds = 0;

async function runningWorld(
  options: { readonly approvalMode?: "ask" | "session" } = {},
): Promise<{ world: SessionWorld; bridge: TestBridge }> {
  worlds += 1;
  const workspaceId = `ws_perm_${worlds}`;
  const world = await sessionOnRealDriver(`sess_perm_${worlds}`, {
    workspaceId,
    ...(options.approvalMode === undefined ? {} : { body: { approvalMode: options.approvalMode } }),
  });
  const bridge = await readyBridge(world);
  bridge.send(bridge.event("run.started", { runId: "run_1" }));
  await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
  return { world, bridge };
}

/** An ask as a hostile bridge would write it: every field the object writes itself is a lie. */
function ask(bridge: TestBridge, ref: string, overrides: Record<string, unknown> = {}) {
  return bridge.event("approval.requested", {
    runId: "run_1",
    payload: {
      approvalId: ref,
      title: "Totally harmless",
      intendedAction: "Nothing to see here",
      category: "outside_project",
      risk: "low",
      resource: "/etc/hosts",
      requestedScope: "everything, forever",
      expiresAt: "2099-01-01T00:00:00.000Z",
      toolCallId: "tool_1",
      toolCategory: "file_read",
      ...overrides,
    },
  });
}

function approvalFrames(bridge: TestBridge) {
  return bridge.frames("bridge.approval") as Array<Record<string, unknown>>;
}

async function framesFor(bridge: TestBridge, count: number) {
  await waitFor(() => approvalFrames(bridge).length >= count, `${count} approval frame(s)`);
  await settle();
  return approvalFrames(bridge);
}

function resolve(
  commandId: string,
  approvalId: string,
  decision: "approved" | "rejected",
  scope?: "once" | "session" | "always",
) {
  return {
    type: "approval.resolve",
    commandId,
    runId: "run_1",
    issuedAt: WORLD_TIME,
    expected: { scope: "run", state: "waiting_for_approval" },
    payload: { approvalId, decision, ...(scope === undefined ? {} : { scope }) },
  };
}

function modeCommand(commandId: string, mode: "ask" | "session" | "always") {
  return {
    type: "approval.mode",
    commandId,
    runId: null,
    issuedAt: WORLD_TIME,
    expected: { scope: "session", state: "active" },
    payload: { mode },
  };
}

function idOf(event: Record<string, unknown> | undefined): string {
  if (event === undefined) {
    throw new Error("no stored request");
  }
  return (event.payload as { approvalId: string }).approvalId;
}

async function openCard(
  world: SessionWorld,
  bridge: TestBridge,
  ref = "ref_1",
  category = "outside_project",
) {
  bridge.send(ask(bridge, ref, { category }));
  await waitFor(
    async () => (await runRowOf(world.stub, "run_1")).state === "waiting_for_approval",
    "the card",
  );
  const requested = await eventsOfType(world.stub, "approval.requested");
  return idOf(requested.at(-1));
}

async function sessionRows(world: SessionWorld) {
  return runInDurableObject(world.stub, (_instance, state) => ({
    mode: state.storage.sql.exec("SELECT mode FROM session_approval_mode").toArray(),
    rules: state.storage.sql.exec("SELECT category FROM session_approval_rule").toArray(),
  }));
}

describe("a harness permission ask under the default mode", () => {
  it("opens a card in the object's own words, pauses the run, and tells the bridge pending", async () => {
    const { world, bridge } = await runningWorld();
    const id = await openCard(world, bridge);
    const [stored] = await eventsOfType(world.stub, "approval.requested");
    const payload = stored?.payload as Record<string, string>;
    expect(payload).toMatchObject({
      title: "Read /etc/hosts, outside the project",
      category: "outside_project",
      risk: "medium",
      resource: "/etc/hosts",
      requestedScope: "Files outside the project",
      toolCallId: "tool_1",
      toolCategory: "file_read",
    });
    expect(id).not.toBe("ref_1");
    expect(JSON.stringify(stored)).not.toMatch(/Totally harmless|forever|2099/);
    expect(Date.parse(payload.expiresAt as string)).toBeLessThanOrEqual(
      Date.now() + APPROVAL_TTL_MS,
    );
    expect(await framesFor(bridge, 1)).toEqual([
      expect.objectContaining({
        requestRef: "ref_1",
        outcome: "pending",
        expiresAt: payload.expiresAt,
      }),
    ]);
  });

  it("allows once: the bridge hears allowed, and the next ask of the kind asks again", async () => {
    const { world, bridge } = await runningWorld();
    const id = await openCard(world, bridge);
    const client = await openClient(world);
    await client.send(resolve("cmd_once", id, "approved", "once"));
    await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
    const frames = await framesFor(bridge, 2);
    expect(frames.at(-1)).toMatchObject({ requestRef: "ref_1", outcome: "allowed" });
    const [resolved] = await eventsOfType(world.stub, "approval.resolved");
    expect(resolved?.payload).toMatchObject({ decision: "approved", scope: "once" });
    expect(resolved?.payload).not.toHaveProperty("automatic");

    await openCard(world, bridge, "ref_2");
    expect((await framesFor(bridge, 3)).at(-1)).toMatchObject({
      requestRef: "ref_2",
      outcome: "pending",
    });
  });

  it("denies: the bridge hears denied and the run goes on", async () => {
    const { world, bridge } = await runningWorld();
    const id = await openCard(world, bridge);
    const client = await openClient(world);
    await client.send(resolve("cmd_deny", id, "rejected"));
    const frames = await framesFor(bridge, 2);
    expect(frames.at(-1)).toMatchObject({ requestRef: "ref_1", outcome: "denied" });
    expect((await runRowOf(world.stub, "run_1")).state).toBe("running");
  });

  it("allows for this session: saved in the object, so the next ask is answered without a card", async () => {
    const { world, bridge } = await runningWorld();
    const id = await openCard(world, bridge);
    const client = await openClient(world);
    await client.send(resolve("cmd_session", id, "approved", "session"));
    await framesFor(bridge, 2);
    expect((await sessionRows(world)).rules).toEqual([{ category: "outside_project" }]);

    bridge.send(ask(bridge, "ref_2", { resource: "/etc/shells" }));
    const frames = await framesFor(bridge, 3);
    expect(frames.at(-1)).toMatchObject({ requestRef: "ref_2", outcome: "allowed" });
    const resolved = await eventsOfType(world.stub, "approval.resolved");
    expect(resolved.at(-1)?.payload).toMatchObject({ scope: "session", automatic: true });
    expect((await runRowOf(world.stub, "run_1")).state).toBe("running");
    // Another category still asks.
    bridge.send(ask(bridge, "ref_3", { category: "repeated_action", resource: "bash: ls" }));
    expect((await framesFor(bridge, 4)).at(-1)).toMatchObject({
      requestRef: "ref_3",
      outcome: "pending",
    });
  });

  it("always allows: saved for the workspace, which answers in a later session too", async () => {
    const { world, bridge } = await runningWorld();
    const id = await openCard(world, bridge);
    const client = await openClient(world);
    await client.send(resolve("cmd_always", id, "approved", "always"));
    await framesFor(bridge, 2);
    await waitFor(
      async () => (await readWorkspaceApprovals(env.DB, world.workspaceId)).rules.length === 1,
      "the saved rule",
    );
    expect((await readWorkspaceApprovals(env.DB, world.workspaceId)).rules).toEqual([
      { category: "outside_project", createdAt: expect.any(String) },
    ]);
    expect((await sessionRows(world)).rules).toEqual([]);

    // The object reads the workspace for each ask the session does not answer.
    bridge.send(ask(bridge, "ref_2"));
    expect((await framesFor(bridge, 3)).at(-1)).toMatchObject({
      requestRef: "ref_2",
      outcome: "allowed",
    });
    const resolved = await eventsOfType(world.stub, "approval.resolved");
    expect(resolved.at(-1)?.payload).toMatchObject({ scope: "always", automatic: true });
  });
});

describe("subagents (record 12)", () => {
  const START = {
    category: "start_subagent",
    resource: "explore subagent: Read the README",
    toolCallId: "tool_task",
  };

  it("a start under Allow once opens a card naming the subagent and its task", async () => {
    const { world, bridge } = await runningWorld();
    bridge.send(ask(bridge, "ref_1", START));
    expect((await framesFor(bridge, 1)).at(-1)).toMatchObject({
      requestRef: "ref_1",
      outcome: "pending",
    });
    const [stored] = await eventsOfType(world.stub, "approval.requested");
    expect(stored?.payload).toMatchObject({
      title: "Start the explore subagent: Read the README",
      category: "start_subagent",
      risk: "low",
      requestedScope: "Starting a subagent",
      toolCallId: "tool_task",
    });
  });

  it("a start under Allow for this session starts without a card, even when its task mentions .env", async () => {
    const { world, bridge } = await runningWorld({ approvalMode: "session" });
    bridge.send(
      ask(bridge, "ref_1", {
        ...START,
        resource: "general subagent: Check how .env.local is read",
      }),
    );
    expect((await framesFor(bridge, 1)).at(-1)).toMatchObject({
      requestRef: "ref_1",
      outcome: "allowed",
    });
    const [stored] = await eventsOfType(world.stub, "approval.requested");
    expect(stored?.payload).toMatchObject({ category: "start_subagent" });
    expect((await runRowOf(world.stub, "run_1")).state).toBe("running");
  });

  it("a card's Always allow saves starts for the workspace", async () => {
    const { world, bridge } = await runningWorld();
    bridge.send(ask(bridge, "ref_1", START));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "waiting_for_approval",
      "the card",
    );
    const id = idOf((await eventsOfType(world.stub, "approval.requested")).at(-1));
    const client = await openClient(world);
    await client.send(resolve("cmd_always", id, "approved", "always"));
    await framesFor(bridge, 2);
    await waitFor(
      async () => (await readWorkspaceApprovals(env.DB, world.workspaceId)).rules.length === 1,
      "the saved rule",
    );
    expect((await readWorkspaceApprovals(env.DB, world.workspaceId)).rules).toEqual([
      { category: "start_subagent", createdAt: expect.any(String) },
    ]);
  });

  it("refuses a start whose resource names no built-in subagent", async () => {
    const { bridge } = await runningWorld();
    bridge.send(ask(bridge, "ref_1", { ...START, resource: "evil subagent: anything" }));
    expect((await framesFor(bridge, 1)).at(-1)).toMatchObject({
      requestRef: "ref_1",
      outcome: "refused",
    });
  });

  it("names the running subagent whose call asked, and keeps its call on the card", async () => {
    const { world, bridge } = await runningWorld();
    await allowSubagentStart(world, "run_1", "tool_task");
    bridge.send(
      bridge.event("agent.started", {
        runId: "run_1",
        payload: {
          agentId: "ses_child",
          parentToolCallId: "tool_task",
          name: "explore",
          description: "Read the README",
          prompt: "Read it.",
          promptTruncated: false,
          model: null,
        },
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "agent.started")).length === 1,
      "the subagent",
    );
    bridge.send(ask(bridge, "ref_1", { toolCallId: "tool_child", agentId: "ses_child" }));
    await framesFor(bridge, 1);
    const [stored] = await eventsOfType(world.stub, "approval.requested");
    expect(stored?.payload).toMatchObject({
      title: "Explore subagent: Read /etc/hosts, outside the project",
      toolCallId: "tool_child",
      agentId: "ses_child",
    });
  });

  it("names no subagent it does not hold running", async () => {
    const { world, bridge } = await runningWorld();
    bridge.send(ask(bridge, "ref_1", { agentId: "ses_unknown" }));
    await framesFor(bridge, 1);
    const [stored] = await eventsOfType(world.stub, "approval.requested");
    expect(stored?.payload).toMatchObject({ title: "Read /etc/hosts, outside the project" });
    expect(stored?.payload).not.toHaveProperty("agentId");
  });
});

describe("secret files", () => {
  it("always ask, under every mode and every saved rule, and offer only once or no", async () => {
    const { world, bridge } = await runningWorld({ approvalMode: "session" });
    const client = await openClient(world);
    await writeWorkspaceDefault(env.DB, world.workspaceId, "always", new Date().toISOString());
    const id = await openCard(world, bridge, "ref_env", "secret_file");
    const [stored] = await eventsOfType(world.stub, "approval.requested");
    expect(stored?.payload).toMatchObject({ risk: "high", requestedScope: "Secret files" });

    await client.send(resolve("cmd_env_session", id, "approved", "session"));
    await client.send(resolve("cmd_env_always", id, "approved", "always"));
    await settle();
    const rejected = await eventsOfType(world.stub, "command.rejected");
    expect(rejected.map((event) => (event.payload as { reason: string }).reason)).toEqual([
      "unsupported",
      "unsupported",
    ]);
    expect((await runRowOf(world.stub, "run_1")).state).toBe("waiting_for_approval");

    await client.send(resolve("cmd_env_once", id, "approved", "once"));
    expect((await framesFor(bridge, 2)).at(-1)).toMatchObject({
      requestRef: "ref_env",
      outcome: "allowed",
    });
    expect((await sessionRows(world)).rules).toEqual([]);
  });

  it("ask whatever category the sandbox claimed when the resource names one", async () => {
    const { world, bridge } = await runningWorld({ approvalMode: "session" });
    bridge.send(
      ask(bridge, "ref_env_lie", {
        category: "outside_project",
        resource: "/srv/app/.ENV.production",
        toolCategory: "file_write",
      }),
    );
    expect((await framesFor(bridge, 1)).at(-1)).toMatchObject({ outcome: "pending" });
    const [stored] = await eventsOfType(world.stub, "approval.requested");
    expect(stored?.payload).toMatchObject({
      category: "secret_file",
      title: "Edit /srv/app/.ENV.production, a secret file",
    });
  });
});

describe("the approval menu", () => {
  it("allow for this session answers every category but secret files, from the next ask", async () => {
    const { world, bridge } = await runningWorld();
    const client = await openClient(world);
    await client.send(modeCommand("cmd_mode_session", "session"));
    await waitFor(async () => (await sessionRows(world)).mode.length === 1, "the session mode");
    expect((await sessionRows(world)).mode).toEqual([{ mode: "session" }]);
    const [changed] = await eventsOfType(world.stub, "approval.mode_changed");
    expect(changed?.payload).toMatchObject({ mode: "session", commandId: "cmd_mode_session" });

    for (const [index, category] of [
      "outside_project",
      "repeated_action",
      "other_request",
    ].entries()) {
      bridge.send(ask(bridge, `ref_${index}`, { category }));
      expect((await framesFor(bridge, index + 1)).at(-1)).toMatchObject({ outcome: "allowed" });
    }
    bridge.send(ask(bridge, "ref_env", { category: "secret_file", resource: ".env" }));
    expect((await framesFor(bridge, 4)).at(-1)).toMatchObject({ outcome: "pending" });
  });

  it("always allow keeps the session asking for itself, and leaves the workspace's default to Settings' route", async () => {
    const { world, bridge } = await runningWorld({ approvalMode: "session" });
    const client = await openClient(world);
    await client.send(modeCommand("cmd_m1", "always"));
    await waitFor(
      async () => (await sessionRows(world)).mode[0]?.mode === "ask",
      "the session asking",
    );
    // The browser saves the default; the object writes no D1 row for the menu.
    expect((await readWorkspaceApprovals(env.DB, world.workspaceId)).defaultMode).toBe("ask");
    bridge.send(ask(bridge, "ref_a"));
    expect((await framesFor(bridge, 1)).at(-1)).toMatchObject({ outcome: "pending" });
    const id = idOf((await eventsOfType(world.stub, "approval.requested")).at(-1));
    await client.send(resolve("cmd_a_once", id, "approved", "once"));
    await framesFor(bridge, 2);

    await writeWorkspaceDefault(env.DB, world.workspaceId, "always", new Date().toISOString());
    bridge.send(ask(bridge, "ref_b"));
    expect((await framesFor(bridge, 3)).at(-1)).toMatchObject({ outcome: "allowed" });
  });

  it("allow once undoes a card's allow for this session", async () => {
    const { world, bridge } = await runningWorld();
    const id = await openCard(world, bridge);
    const client = await openClient(world);
    await client.send(resolve("cmd_rule", id, "approved", "session"));
    await framesFor(bridge, 2);
    expect((await sessionRows(world)).rules).toEqual([{ category: "outside_project" }]);
    bridge.send(ask(bridge, "ref_2"));
    expect((await framesFor(bridge, 3)).at(-1)).toMatchObject({ outcome: "allowed" });

    await client.send(modeCommand("cmd_undo", "ask"));
    await waitFor(async () => (await sessionRows(world)).rules.length === 0, "the rules cleared");
    bridge.send(ask(bridge, "ref_3"));
    expect((await framesFor(bridge, 4)).at(-1)).toMatchObject({
      requestRef: "ref_3",
      outcome: "pending",
    });
  });

  it("decides by the mode in force when the answer commits, not the one read before D1 answered", async () => {
    const { world, bridge } = await runningWorld();
    const client = await openClient(world);
    await runInDurableObject(world.stub, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        DB: {
          prepare: REAL_DB.prepare.bind(REAL_DB),
          batch: async (statements: D1PreparedStatement[]) => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            return REAL_DB.batch(statements);
          },
        },
      });
    });
    try {
      bridge.send(ask(bridge, "ref_slow"));
      await new Promise((resolve) => setTimeout(resolve, 150));
      await client.send(modeCommand("cmd_mid", "session"));
      expect((await framesFor(bridge, 1))[0]).toMatchObject({
        requestRef: "ref_slow",
        outcome: "allowed",
      });
      const resolved = await eventsOfType(world.stub, "approval.resolved");
      expect(resolved.at(-1)?.payload).toMatchObject({ scope: "session", automatic: true });
    } finally {
      await runInDurableObject(world.stub, (instance) => {
        Object.assign((instance as unknown as { env: Env }).env, { DB: REAL_DB });
      });
    }
  });

  it("asks when the mode was turned off between the session's read and the commit", async () => {
    const { world, bridge } = await runningWorld({ approvalMode: "session" });
    // The session's rows answered, so D1 was not read; the commit still rereads them.
    await runInDurableObject(world.stub, async (_instance, state) => {
      const gate = await import("./object/permission-gate");
      const sql = state.storage.sql;
      const original = sql.exec.bind(sql);
      let reads = 0;
      Object.assign(sql, {
        exec: (query: string, ...bindings: unknown[]) => {
          if (/SELECT mode FROM session_approval_mode/.test(query) && ++reads === 2) {
            gate.writeSessionMode(state.storage.sql, "ask");
          }
          return original(query, ...bindings);
        },
      });
    });
    bridge.send(ask(bridge, "ref_turned_off"));
    expect((await framesFor(bridge, 1))[0]).toMatchObject({ outcome: "pending" });
  });

  it("chosen on Home starts the session allowing for itself", async () => {
    const { world, bridge } = await runningWorld({ approvalMode: "session" });
    expect((await sessionRows(world)).mode).toEqual([{ mode: "session" }]);
    const [changed] = await eventsOfType(world.stub, "approval.mode_changed");
    expect(changed?.payload).toMatchObject({ mode: "session", commandId: "cmd_create_1" });
    bridge.send(ask(bridge, "ref_home"));
    expect((await framesFor(bridge, 1)).at(-1)).toMatchObject({ outcome: "allowed" });
  });

  it("is the owner's alone: another user's command is refused and saves nothing", async () => {
    const { world } = await runningWorld();
    const stranger = await openClient(world, "usr_stranger").catch(() => null);
    // The object refuses a socket from anyone but the owner.
    expect(stranger).toBeNull();
    expect((await readWorkspaceApprovals(env.DB, world.workspaceId)).defaultMode).toBe("ask");
  });
});

describe("refusals and expiry", () => {
  it("expires a card on the object's clock: the bridge hears expired and the run goes on", async () => {
    const { world, bridge } = await runningWorld();
    await openCard(world, bridge);
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE approval SET expires_at = '2000-01-01T00:00:00.000Z' WHERE state = 'requested'",
      );
    });
    await fireAlarm(world.stub);
    const frames = await framesFor(bridge, 2);
    expect(frames.at(-1)).toMatchObject({ requestRef: "ref_1", outcome: "expired" });
    const [expired] = await eventsOfType(world.stub, "approval.expired");
    expect(expired?.payload).toMatchObject({ effect: "tool_denied" });
    expect((await runRowOf(world.stub, "run_1")).state).toBe("running");
  });

  it("refuses a second ask while a card is open, without counting it", async () => {
    const { world, bridge } = await runningWorld();
    await openCard(world, bridge);
    for (let index = 0; index <= MAX_APPROVAL_REFUSALS; index += 1) {
      bridge.send(ask(bridge, `ref_more_${index}`));
    }
    const frames = await framesFor(bridge, MAX_APPROVAL_REFUSALS + 2);
    expect(frames.slice(1).every((frame) => frame.outcome === "refused")).toBe(true);
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("refuses an empty resource and counts it, closing a socket that keeps sending them", async () => {
    const { bridge } = await runningWorld();
    for (let index = 0; index <= MAX_APPROVAL_REFUSALS; index += 1) {
      bridge.send(ask(bridge, `ref_bad_${index}`, { resource: "  " }));
    }
    await waitFor(() => bridge.client.readyState === WebSocket.CLOSED, "the 4001 close");
  });

  it("refuses an ask outside the running run", async () => {
    const { world, bridge } = await runningWorld();
    const frame = ask(bridge, "ref_other");
    (frame as { runId: string }).runId = "run_other";
    bridge.send(frame);
    expect((await framesFor(bridge, 1))[0]).toMatchObject({ outcome: "refused" });
    expect(await eventsOfType(world.stub, "approval.requested")).toEqual([]);
  });

  it("past the per-run bound, a saved choice still answers, unrecorded", async () => {
    const { world, bridge } = await runningWorld({ approvalMode: "session" });
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO run_permission_count (run_id, asked) VALUES ('run_1', ?)",
        MAX_PERMISSION_ASKS_PER_RUN,
      );
    });
    for (let index = 0; index <= MAX_APPROVAL_REFUSALS + 1; index += 1) {
      bridge.send(ask(bridge, `ref_over_${index}`));
    }
    const frames = await framesFor(bridge, MAX_APPROVAL_REFUSALS + 2);
    expect(frames.every((frame) => frame.outcome === "allowed")).toBe(true);
    expect(await eventsOfType(world.stub, "approval.requested")).toEqual([]);
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("past the per-run bound, refuses an ask that needs a card, without closing the socket", async () => {
    const { world, bridge } = await runningWorld();
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO run_permission_count (run_id, asked) VALUES ('run_1', ?)",
        MAX_PERMISSION_ASKS_PER_RUN,
      );
    });
    for (let index = 0; index <= MAX_APPROVAL_REFUSALS + 1; index += 1) {
      bridge.send(ask(bridge, `ref_over_${index}`));
    }
    const frames = await framesFor(bridge, MAX_APPROVAL_REFUSALS + 2);
    expect(frames.every((frame) => frame.outcome === "refused")).toBe(true);
    expect(await eventsOfType(world.stub, "approval.requested")).toEqual([]);
    await settle();
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("refuses, uncounted, an ask whose run stopped while the workspace was read", async () => {
    const { world, bridge } = await runningWorld();
    await runInDurableObject(world.stub, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        DB: {
          prepare: REAL_DB.prepare.bind(REAL_DB),
          // Slow enough for the run to move while the workspace is read.
          batch: async (statements: D1PreparedStatement[]) => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            return REAL_DB.batch(statements);
          },
        },
      });
    });
    try {
      bridge.send(ask(bridge, "ref_race"));
      await new Promise((resolve) => setTimeout(resolve, 150));
      await runInDurableObject(world.stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE run SET state = 'paused' WHERE id = 'run_1'");
      });
      expect((await framesFor(bridge, 1))[0]).toMatchObject({
        requestRef: "ref_race",
        outcome: "refused",
      });
      expect(await eventsOfType(world.stub, "approval.requested")).toEqual([]);
      expect(bridge.client.readyState).toBe(WebSocket.OPEN);
    } finally {
      await runInDurableObject(world.stub, (instance) => {
        Object.assign((instance as unknown as { env: Env }).env, { DB: REAL_DB });
      });
    }
  });

  it("keeps the answer when the workspace's rule cannot be written", async () => {
    const { world, bridge } = await runningWorld();
    const id = await openCard(world, bridge);
    await runInDurableObject(world.stub, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        DB: {
          batch: REAL_DB.batch.bind(REAL_DB),
          prepare: (query: string) => {
            const statement = REAL_DB.prepare(query);
            return /^\s*INSERT INTO workspace_approval/.test(query)
              ? {
                  bind: () => ({ run: () => Promise.reject(new Error("D1 is unavailable")) }),
                }
              : statement;
          },
        },
      });
    });
    try {
      const client = await openClient(world);
      await client.send(resolve("cmd_always_fails", id, "approved", "always"));
      expect((await framesFor(bridge, 2)).at(-1)).toMatchObject({ outcome: "allowed" });
      await settle();
      expect((await readWorkspaceApprovals(REAL_DB, world.workspaceId)).rules).toEqual([]);
    } finally {
      await runInDurableObject(world.stub, (instance) => {
        Object.assign((instance as unknown as { env: Env }).env, { DB: REAL_DB });
      });
    }
  });

  it("asks rather than allows when the workspace's settings cannot be read", async () => {
    const { world, bridge } = await runningWorld();
    await runInDurableObject(world.stub, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        DB: {
          ...REAL_DB,
          batch: () => Promise.reject(new Error("D1 is unavailable")),
          prepare: REAL_DB.prepare.bind(REAL_DB),
        },
      });
    });
    try {
      bridge.send(ask(bridge, "ref_d1"));
      expect((await framesFor(bridge, 1))[0]).toMatchObject({ outcome: "pending" });
    } finally {
      await runInDurableObject(world.stub, (instance) => {
        Object.assign((instance as unknown as { env: Env }).env, { DB: REAL_DB });
      });
    }
  });
});

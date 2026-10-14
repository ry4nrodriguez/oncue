// Approvals at the object's boundary (records 04 and 09): the sandbox is
// trusted only for the secret's name; the object mints the id, writes every
// shown field, runs the expiry on its alarm, and carries no decision across a
// generation.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { deriveKeyring } from "../broker/envelope";
import { saveDevelopmentSecret } from "../secrets/store";
import {
  completeVerification,
  eventsOfType,
  eventTypes,
  fireAlarm,
  MODAL_CREDENTIAL,
  OWNER_USER_ID,
  openClient,
  REPOSITORY,
  REPOSITORY_ID,
  readyBridge,
  recordCheck,
  registerSessionWorlds,
  runRowOf,
  type SessionWorld,
  sessionOnRealDriver,
  settle,
  storedAlarm,
  type TestBridge,
  WORLD_TIME,
  waitFor,
  waitingForUserInD1,
} from "../test/session-world";
import { APPROVAL_TTL_MS, MAX_APPROVALS_PER_RUN } from "./approvals";
import { MAX_APPROVAL_REFUSALS, MAX_SESSION_APPROVAL_REFUSALS } from "./session-object";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const WORKSPACE = "ws_1";

/** The repository connection and the saved names the workspace has in D1. Values are never opened here. */
async function seedSavedSecrets(names: readonly string[]): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO github_installation (
         installation_row_id, workspace_id, github_installation_id, github_user_id,
         account_login, account_type, status, user_token_reference, refresh_token_reference,
         user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
       ) VALUES ('ins_appr', ?, 4001, 42, 'acme', 'Organization', 'active', 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(WORKSPACE, WORLD_TIME, WORLD_TIME, WORLD_TIME, WORLD_TIME, WORLD_TIME),
    env.DB.prepare(
      `INSERT INTO repository_connection (
         repository_connection_id, workspace_id, installation_row_id, github_repository_id,
         full_name, default_branch, status, created_at, updated_at
       ) VALUES ('rpc_appr', ?, 'ins_appr', ?, 'acme/widgets', 'main', 'verified', ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(WORKSPACE, REPOSITORY_ID, WORLD_TIME, WORLD_TIME),
    env.DB.prepare("DELETE FROM development_secret WHERE workspace_id = ?").bind(WORKSPACE),
    ...names.map((name) =>
      env.DB.prepare(
        `INSERT INTO development_secret (
           secret_id, workspace_id, repository_connection_id, name, value_reference,
           status, created_at, updated_at
         ) VALUES (?, ?, 'rpc_appr', ?, 'oncue1.1.n.v', 'active', ?, ?)`,
      ).bind(`dsc_${name}`, WORKSPACE, name, WORLD_TIME, WORLD_TIME),
    ),
  ]);
}

async function pinDeclaration(world: SessionWorld, optional: readonly string[]): Promise<void> {
  await runInDurableObject(world.stub, (_instance, state) => {
    for (const name of optional) {
      state.storage.sql.exec(
        "INSERT INTO session_secret (name, kind, selected, supplied_generation) VALUES (?, 'optional', 0, NULL)",
        name,
      );
    }
  });
}

async function waitingWorld(
  sessionId: string,
  optional: readonly string[] = ["STRIPE_TEST_KEY", "SENTRY_DSN"],
  saved: readonly string[] = optional,
): Promise<{ world: SessionWorld; bridge: TestBridge }> {
  const world = await sessionOnRealDriver(sessionId, { repository: REPOSITORY });
  // After the world, which creates the workspace row these reference.
  await seedSavedSecrets(saved);
  await pinDeclaration(world, optional);
  const bridge = await readyBridge(world);
  bridge.send(bridge.event("run.started", { runId: "run_1" }));
  await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
  return { world, bridge };
}

/** A request as a hostile bridge would write it: every field but the name is a lie the object must not repeat. */
function request(bridge: TestBridge, ref: string, overrides: Record<string, unknown> = {}) {
  return bridge.event("approval.requested", {
    runId: "run_1",
    payload: {
      approvalId: ref,
      title: "Totally harmless",
      intendedAction: "Nothing to see here",
      category: "development_secret",
      risk: "low",
      resource: "STRIPE_TEST_KEY",
      requestedScope: "everything, forever",
      expiresAt: "2099-01-01T00:00:00.000Z",
      toolCallId: "tool_1",
      ...overrides,
    },
  });
}

async function approvalRows(world: SessionWorld) {
  return runInDurableObject(world.stub, (_instance, state) =>
    state.storage.sql
      .exec<Record<string, string | number | null>>(
        "SELECT a.id, a.run_id, a.state, a.title, a.risk, a.resource, a.requested_scope, a.expires_at, a.requested_generation, a.decided_by, a.decided_at, a.expired_effect, r.sandbox_ref, r.secret_name FROM approval a JOIN approval_request r ON r.approval_id = a.id ORDER BY a.requested_at, a.id",
      )
      .toArray(),
  );
}

async function admitted(world: SessionWorld, count = 1) {
  await waitFor(
    async () => (await eventsOfType(world.stub, "approval.requested")).length === count,
    `${count} stored request(s)`,
  );
  await settle();
  return eventsOfType(world.stub, "approval.requested");
}

function idOf(event: Record<string, unknown> | undefined): string {
  if (event === undefined) {
    throw new Error("no stored request");
  }
  return (event.payload as { approvalId: string }).approvalId;
}

function resolve(commandId: string, approvalId: string, decision: "approved" | "rejected") {
  return {
    type: "approval.resolve",
    commandId,
    runId: "run_1",
    issuedAt: WORLD_TIME,
    expected: { scope: "run", state: "waiting_for_approval" },
    payload: { approvalId, decision },
  };
}

async function expireNow(world: SessionWorld): Promise<void> {
  await runInDurableObject(world.stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE approval SET expires_at = '2000-01-01T00:00:00.000Z' WHERE state = 'requested'",
    );
  });
  await fireAlarm(world.stub);
  await settle();
}

describe("an approval.requested frame", () => {
  it("is stored under the object's id with the object's words, and pauses the run", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_admit");
    const before = Date.now();
    bridge.send(request(bridge, "sandbox_ref_1"));
    const [stored] = await admitted(world);

    const payload = stored?.payload as Record<string, string>;
    expect(payload.approvalId).not.toBe("sandbox_ref_1");
    expect(payload).toMatchObject({
      title: "Supply STRIPE_TEST_KEY",
      category: "development_secret",
      risk: "medium",
      resource: "STRIPE_TEST_KEY",
      requestedScope: "This session's sandbox (generation 1), until it stops",
      toolCallId: "tool_1",
    });
    expect(JSON.stringify(stored)).not.toContain("Totally harmless");
    expect(JSON.stringify(stored)).not.toContain("forever");
    const expiresAtMs = Date.parse(String(payload.expiresAt));
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + APPROVAL_TTL_MS);
    expect(expiresAtMs).toBeLessThan(Date.now() + APPROVAL_TTL_MS + 1);

    expect(await approvalRows(world)).toMatchObject([
      {
        id: payload.approvalId,
        run_id: "run_1",
        state: "requested",
        resource: "STRIPE_TEST_KEY",
        requested_generation: 1,
        sandbox_ref: "sandbox_ref_1",
        secret_name: "STRIPE_TEST_KEY",
      },
    ]);
    expect((await runRowOf(world.stub, "run_1")).state).toBe("waiting_for_approval");
    // The bridge hears about ITS request, by its own reference, and when it will expire.
    expect(bridge.frames("bridge.approval")).toEqual([
      {
        type: "bridge.approval",
        sessionId: "sess_appr_admit",
        sandboxGeneration: 1,
        requestRef: "sandbox_ref_1",
        outcome: "pending",
        expiresAt: payload.expiresAt,
      },
    ]);
    // The expiry is the object's alarm, armed from the stored deadline.
    expect(await storedAlarm(world.stub)).toBeLessThanOrEqual(expiresAtMs);
  });

  it.each([
    ["a name the pinned declaration does not list", { resource: "DEPLOY_KEY" }],
    ["a category this version does not offer", { category: "network_expansion" }],
    ["a name that is not a variable's name", { resource: "../../etc/passwd" }],
    ["a run that is not the session's", { __runId: "run_other" }],
  ])("for %s is never stored, and the bridge is told", async (_label, overrides) => {
    const { world, bridge } = await waitingWorld(`sess_appr_refuse_${_label.length}`);
    const { __runId, ...payload } = overrides as Record<string, unknown>;
    const frame = request(bridge, "sandbox_ref_x", payload);
    if (typeof __runId === "string") {
      (frame as { runId: string }).runId = __runId;
    }
    bridge.send(frame);
    await waitFor(() => bridge.frames("bridge.approval").length === 1, "the refusal");

    expect(bridge.frames("bridge.approval")[0]).toMatchObject({
      requestRef: "sandbox_ref_x",
      outcome: "refused",
      expiresAt: null,
    });
    expect(await eventsOfType(world.stub, "approval.requested")).toEqual([]);
    expect(await approvalRows(world)).toEqual([]);
    expect((await runRowOf(world.stub, "run_1")).state).toBe("running");
  });

  it("is stored under the sequence it commits at, though the next frame landed while D1 was read", async () => {
    // While the judgement awaits D1, the next frame can commit under the
    // sequence ingest gave the request. The test runtime serializes a socket's
    // messages, so this pins that both frames are stored, in commit order,
    // with D1 slowed.
    const { world, bridge } = await waitingWorld("sess_appr_race");
    const realDb = env.DB;
    await runInDurableObject(world.stub, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        DB: new Proxy(realDb, {
          get(target, key) {
            const member = Reflect.get(target, key);
            if (key !== "prepare" || typeof member !== "function") {
              return typeof member === "function" ? member.bind(target) : member;
            }
            return (...args: unknown[]) => {
              const statement = member.apply(target, args) as D1PreparedStatement;
              return new Proxy(statement, {
                get(inner, innerKey) {
                  const value = Reflect.get(inner, innerKey);
                  if (innerKey !== "first" && innerKey !== "all" && innerKey !== "run") {
                    return typeof value === "function" ? value.bind(inner) : value;
                  }
                  return async (...innerArgs: unknown[]) => {
                    await new Promise((resolve) => setTimeout(resolve, 150));
                    return (value as (...a: unknown[]) => unknown).apply(inner, innerArgs);
                  };
                },
              });
            };
          },
        }),
      });
    });
    try {
      bridge.send(request(bridge, "ref_race"));
      // The frame the real bridge sends right behind the request.
      bridge.send(
        bridge.event("tool.requested", {
          runId: "run_1",
          payload: {
            toolCallId: "tool_1",
            category: "other",
            title: "oncue_secret_request",
            runtimeName: "oncue_secret_request",
            input: { name: "STRIPE_TEST_KEY" },
            inputComplete: true,
            approvalId: null,
          },
        }),
      );
      const [stored] = await admitted(world);
      expect(stored?.payload).toMatchObject({ resource: "STRIPE_TEST_KEY" });
      const sequences = await runInDurableObject(world.stub, (_instance, state) =>
        state.storage.sql
          .exec<{ session_sequence: number; event_type: string }>(
            "SELECT session_sequence, event_type FROM event ORDER BY session_sequence DESC LIMIT 2",
          )
          .toArray(),
      );
      expect(sequences.map((row) => row.event_type).sort()).toEqual([
        "approval.requested",
        "tool.requested",
      ]);
      expect((await runRowOf(world.stub, "run_1")).state).toBe("waiting_for_approval");
    } finally {
      await runInDurableObject(world.stub, (instance) => {
        Object.assign((instance as unknown as { env: Env }).env, { DB: realDb });
      });
    }
  });

  it("for a declared name with no saved value is refused", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_unsaved", ["STRIPE_TEST_KEY"], []);
    bridge.send(request(bridge, "sandbox_ref_u"));
    await waitFor(() => bridge.frames("bridge.approval").length === 1, "the refusal");
    expect(bridge.frames("bridge.approval")[0]).toMatchObject({ outcome: "refused" });
    expect(await eventsOfType(world.stub, "approval.requested")).toEqual([]);
  });

  it("in a session with no repository is refused: a secret belongs to a repository", async () => {
    const world = await sessionOnRealDriver("sess_appr_no_repo");
    await pinDeclaration(world, ["STRIPE_TEST_KEY"]);
    const bridge = await readyBridge(world);
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");

    bridge.send(request(bridge, "ref_no_repo"));
    await waitFor(() => bridge.frames("bridge.approval").length === 1, "the refusal");
    expect(bridge.frames("bridge.approval")[0]).toMatchObject({ outcome: "refused" });
    expect(await eventsOfType(world.stub, "approval.requested")).toEqual([]);
  });

  it("while one is open is refused without counting, however many arrive", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_second");
    bridge.send(request(bridge, "ref_first"));
    await admitted(world);
    for (let index = 0; index < MAX_APPROVAL_REFUSALS + 2; index += 1) {
      bridge.send(request(bridge, `ref_again_${index}`, { resource: "SENTRY_DSN" }));
    }
    await waitFor(
      () => bridge.frames("bridge.approval").length === MAX_APPROVAL_REFUSALS + 3,
      "every answer",
    );
    expect(await eventsOfType(world.stub, "approval.requested")).toHaveLength(1);
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("refused a fourth time closes the socket, and the session remembers across a reconnect", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_flood");
    for (let index = 0; index <= MAX_APPROVAL_REFUSALS; index += 1) {
      bridge.send(request(bridge, `ref_${index}`, { resource: "DEPLOY_KEY" }));
    }
    await waitFor(() => bridge.client.readyState === WebSocket.CLOSED, "the 4001 close");
    expect(await eventsOfType(world.stub, "approval.requested")).toEqual([]);
    const refused = await runInDurableObject(
      world.stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ refused: number }>("SELECT refused FROM approval_refusal_count")
          .one().refused,
    );
    expect(refused).toBe(MAX_APPROVAL_REFUSALS + 1);
  });

  it("for a name this generation was already given is refused without counting", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_supplied");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE session_secret SET supplied_generation = 1 WHERE name = 'STRIPE_TEST_KEY'",
      );
    });
    for (let index = 0; index < MAX_APPROVAL_REFUSALS + 2; index += 1) {
      bridge.send(request(bridge, `ref_supplied_${index}`));
    }
    await waitFor(
      () => bridge.frames("bridge.approval").length === MAX_APPROVAL_REFUSALS + 2,
      "every answer",
    );
    expect(bridge.frames("bridge.approval").every((frame) => frame.outcome === "refused")).toBe(
      true,
    );
    expect(await eventsOfType(world.stub, "approval.requested")).toEqual([]);
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("is refused once a run has had five admitted", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_sixth");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO run_approval_count (run_id, admitted) VALUES ('run_1', ?)",
        MAX_APPROVALS_PER_RUN,
      );
    });
    bridge.send(request(bridge, "ref_sixth"));
    await waitFor(() => bridge.frames("bridge.approval").length === 1, "the refusal");
    expect(bridge.frames("bridge.approval")[0]).toMatchObject({ outcome: "refused" });
    expect(await eventsOfType(world.stub, "approval.requested")).toEqual([]);
  });
});

describe("the user's decision", () => {
  it("to approve is recorded as the authenticated user's, at the object's time, and the run resumes", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_approve");
    await sealSavedSecret("STRIPE_TEST_KEY", FAKE_STRIPE);
    bridge.send(request(bridge, "ref_a"));
    const [stored] = await admitted(world);
    const approvalId = idOf(stored);

    const client = await openClient(world);
    await client.send(resolve("cmd_approve", approvalId, "approved"));
    await settle();

    const [resolved] = await eventsOfType(world.stub, "approval.resolved");
    expect(resolved?.payload).toMatchObject({
      approvalId,
      decision: "approved",
      decidedBy: OWNER_USER_ID,
      decidedForGeneration: 1,
    });
    const [row] = await approvalRows(world);
    expect(row).toMatchObject({ state: "approved", decided_by: OWNER_USER_ID });
    expect(Date.parse(String(row?.decided_at))).toBeGreaterThan(Date.parse(WORLD_TIME));
    expect((await runRowOf(world.stub, "run_1")).state).toBe("running");
    // The bridge hears of an approval as a grant carrying the value, never as a word.
    expect(bridge.frames("bridge.approval").map((frame) => frame.outcome)).toEqual(["pending"]);
  });

  it("that tries to say who decided, or when, is not a command at all", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_forged_decider");
    bridge.send(request(bridge, "ref_f"));
    const [stored] = await admitted(world);
    const forged = resolve("cmd_forged", idOf(stored), "approved");

    const client = await openClient(world);
    await client.send({
      ...forged,
      payload: {
        ...forged.payload,
        decidedBy: "user_somebody_else",
        decidedAt: "1999-01-01T00:00:00.000Z",
      },
    });
    await settle();

    expect(await eventsOfType(world.stub, "approval.resolved")).toEqual([]);
    expect((await approvalRows(world))[0]).toMatchObject({ state: "requested" });
  });

  it("to deny continues the run, and that name is not asked for again in the run", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_deny");
    bridge.send(request(bridge, "ref_d"));
    const [stored] = await admitted(world);
    const approvalId = idOf(stored);

    const client = await openClient(world);
    await client.send(resolve("cmd_deny", approvalId, "rejected"));
    await settle();

    expect((await runRowOf(world.stub, "run_1")).state).toBe("running");
    expect((await runRowOf(world.stub, "run_1")).outcome).toBeNull();
    expect(bridge.frames("bridge.approval").at(-1)).toMatchObject({
      requestRef: "ref_d",
      outcome: "denied",
    });

    bridge.send(request(bridge, "ref_d_again"));
    await waitFor(
      () => bridge.frames("bridge.approval").at(-1)?.requestRef === "ref_d_again",
      "the second answer",
    );
    expect(bridge.frames("bridge.approval").at(-1)).toMatchObject({ outcome: "refused" });
    expect(await eventsOfType(world.stub, "approval.requested")).toHaveLength(1);
  });

  it("from someone who is not the owner is never heard", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_stranger");
    bridge.send(request(bridge, "ref_s"));
    const [stored] = await admitted(world);
    const approvalId = idOf(stored);

    // A stranger never gets a socket to send a decision on: the object
    // refuses the upgrade itself, whatever the Worker let through.
    const response = await world.stub.fetch(
      new Request(`https://do/ws/sessions/${world.sessionId}/client?after=0`, {
        headers: { Upgrade: "websocket", "x-oncue-user-id": "user_stranger" },
      }),
    );
    const socket = response.webSocket as WebSocket;
    const closeCode = await new Promise<number>((done) => {
      socket.addEventListener("close", (event: CloseEvent) => done(event.code));
      socket.accept();
      socket.send(
        JSON.stringify({ type: "command", command: resolve("cmd_x", approvalId, "approved") }),
      );
    });
    expect(closeCode).toBe(4403);
    await settle();

    expect(await eventsOfType(world.stub, "approval.resolved")).toEqual([]);
    expect((await approvalRows(world))[0]).toMatchObject({ state: "requested" });
    expect((await runRowOf(world.stub, "run_1")).state).toBe("waiting_for_approval");
  });
});

describe("the sidebar's Needs you", () => {
  it("is projected into session_index while an approval is open, and cleared by the decision", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_needs_you");
    expect(await waitingForUserInD1(world.sessionId)).toBe(false);
    bridge.send(request(bridge, "ref_a"));
    const [stored] = await admitted(world);
    await waitFor(() => waitingForUserInD1(world.sessionId), "the projection to say waiting");

    const client = await openClient(world);
    await client.send(resolve("cmd_deny", idOf(stored), "rejected"));
    await settle();
    await waitFor(
      async () => !(await waitingForUserInD1(world.sessionId)),
      "the projection to clear",
    );
  });

  it("is cleared by the expiry too", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_needs_you_expiry");
    bridge.send(request(bridge, "ref_a"));
    await admitted(world);
    await waitFor(() => waitingForUserInD1(world.sessionId), "the projection to say waiting");
    await expireNow(world);
    await waitFor(
      async () => !(await waitingForUserInD1(world.sessionId)),
      "the projection to clear",
    );
  });
});

describe("silence", () => {
  it("expires the approval on the object's alarm: the call is denied and the run goes on", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_expire");
    bridge.send(request(bridge, "ref_e"));
    const [stored] = await admitted(world);
    const approvalId = idOf(stored);

    await expireNow(world);

    const [expired] = await eventsOfType(world.stub, "approval.expired");
    expect(expired).toMatchObject({
      runId: "run_1",
      payload: { approvalId, effect: "tool_denied" },
    });
    expect((await approvalRows(world))[0]).toMatchObject({
      state: "expired",
      expired_effect: "tool_denied",
    });
    expect((await runRowOf(world.stub, "run_1")).state).toBe("running");
    expect(bridge.frames("bridge.approval").at(-1)).toMatchObject({
      requestRef: "ref_e",
      outcome: "expired",
    });

    // A click that lost the race to the expiry approves nothing.
    const client = await openClient(world);
    await client.send(resolve("cmd_late", approvalId, "approved"));
    await settle();
    expect(await eventsOfType(world.stub, "approval.resolved")).toEqual([]);
    expect((await approvalRows(world))[0]).toMatchObject({ state: "expired" });
  });

  it("expires it with the bridge's socket gone: the clock is the object's, not the sandbox's", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_expire_offline");
    bridge.send(request(bridge, "ref_offline"));
    await admitted(world);
    bridge.close();
    await settle();

    await expireNow(world);

    expect((await approvalRows(world))[0]).toMatchObject({
      state: "expired",
      expired_effect: "tool_denied",
    });
    expect(await eventsOfType(world.stub, "approval.expired")).toHaveLength(1);
  });

  it("does nothing before the deadline, however often the alarm fires", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_early");
    bridge.send(request(bridge, "ref_early"));
    await admitted(world);
    await fireAlarm(world.stub);
    await fireAlarm(world.stub);
    await settle();
    expect(await eventsOfType(world.stub, "approval.expired")).toEqual([]);
    expect((await runRowOf(world.stub, "run_1")).state).toBe("waiting_for_approval");
  });
});

describe("an approval whose tool call is gone", () => {
  it("ends with its generation, before the credentials are revoked, and a late click approves nothing", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_stop");
    bridge.send(request(bridge, "ref_stop"));
    const [stored] = await admitted(world);
    const approvalId = idOf(stored);

    await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: OWNER_USER_ID, modalCredential: MODAL_CREDENTIAL }),
    );
    await settle();

    const [expired] = await eventsOfType(world.stub, "approval.expired");
    // `run_paused` resumes nothing: the stop's own events say what became of the run.
    expect(expired).toMatchObject({ payload: { approvalId, effect: "run_paused" } });
    const types = await eventTypes(world.stub);
    expect(types.indexOf("approval.expired")).toBeLessThan(
      types.indexOf("sandbox.credentials_revoked"),
    );
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "cancelled" });

    const client = await openClient(world);
    await client.send(resolve("cmd_after_stop", approvalId, "approved"));
    await settle();
    expect(await eventsOfType(world.stub, "approval.resolved")).toEqual([]);
    expect((await approvalRows(world))[0]).toMatchObject({ state: "expired" });
  });

  it("ends when the user cancels the run it paused", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_cancel");
    bridge.send(request(bridge, "ref_cancel"));
    const [stored] = await admitted(world);

    const client = await openClient(world);
    await client.send({
      type: "run.cancel",
      commandId: "cmd_cancel_waiting",
      runId: "run_1",
      issuedAt: WORLD_TIME,
      expected: { scope: "run", state: "waiting_for_approval" },
      payload: { reason: "The user stopped waiting.", checkpointFirst: false },
    });
    await settle();

    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "cancelled" });
    expect((await eventsOfType(world.stub, "approval.expired"))[0]).toMatchObject({
      payload: { approvalId: idOf(stored), effect: "run_paused" },
    });
    // The bridge is told, so its waiting tool call ends too.
    expect(bridge.frames("bridge.approval").at(-1)).toMatchObject({
      requestRef: "ref_cancel",
      outcome: "expired",
    });
  });

  it("ends when the bridge ends the run while it waits, and the run stays ended", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_terminal");
    bridge.send(request(bridge, "ref_terminal"));
    await admitted(world);

    bridge.send(
      bridge.event("run.failed", {
        runId: "run_1",
        payload: {
          stage: "execution",
          error: { category: "runtime_error", message: "It stopped." },
        },
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "approval.expired")).length === 1,
      "the orphaned approval's end",
    );
    expect(await runRowOf(world.stub, "run_1")).toMatchObject({ state: "failed" });
    expect((await approvalRows(world))[0]).toMatchObject({
      state: "expired",
      expired_effect: "run_paused",
    });
  });
});

describe("the declaration pinned at launch", () => {
  const launched = {
    baseSha: "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    pinned: [
      { name: "DATABASE_URL", kind: "required", selected: true },
      { name: "REDIS_URL", kind: "required", selected: false },
      { name: "STRIPE_TEST_KEY", kind: "optional", selected: true },
      { name: "SENTRY_DSN", kind: "optional", selected: false },
    ],
    missingRequired: ["REDIS_URL"],
    declarationInvalid: false,
  } as const;

  it("is recorded as names only, in rows and in one event, and is what a request is judged against", async () => {
    const world = await sessionOnRealDriver("sess_appr_pinned", {
      repository: REPOSITORY,
      body: { secrets: launched },
    });
    await seedSavedSecrets(["SENTRY_DSN"]);

    const [disclosed] = await eventsOfType(world.stub, "secrets.disclosed");
    expect(disclosed?.payload).toEqual({
      baseSha: launched.baseSha,
      supplied: ["DATABASE_URL", "STRIPE_TEST_KEY"],
      withheld: ["SENTRY_DSN"],
      missing: ["REDIS_URL"],
      invalid: false,
    });
    const rows = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, string | number | null>>(
          "SELECT name, kind, selected, supplied_generation FROM session_secret ORDER BY name",
        )
        .toArray(),
    );
    expect(rows).toEqual([
      { name: "DATABASE_URL", kind: "required", selected: 1, supplied_generation: null },
      { name: "REDIS_URL", kind: "required", selected: 0, supplied_generation: null },
      { name: "SENTRY_DSN", kind: "optional", selected: 0, supplied_generation: null },
      { name: "STRIPE_TEST_KEY", kind: "optional", selected: 1, supplied_generation: null },
    ]);

    // The withheld optional name can be asked for; a required one cannot, saved or not.
    const bridge = await readyBridge(world);
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    await waitFor(async () => (await runRowOf(world.stub, "run_1")).state === "running", "running");
    bridge.send(request(bridge, "ref_required", { resource: "DATABASE_URL" }));
    await waitFor(() => bridge.frames("bridge.approval").length === 1, "the refusal");
    expect(bridge.frames("bridge.approval")[0]).toMatchObject({ outcome: "refused" });
    bridge.send(request(bridge, "ref_withheld", { resource: "SENTRY_DSN" }));
    const [stored] = await admitted(world);
    expect(stored?.payload).toMatchObject({ resource: "SENTRY_DSN" });
  });

  it("keeps a session that started without a required secret from ending verified", async () => {
    const world = await sessionOnRealDriver("sess_appr_degraded", {
      repository: REPOSITORY,
      body: { secrets: launched },
    });
    const bridge = await readyBridge(world);
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    await recordCheck(world, bridge, { checkId: "chk_test" });
    completeVerification(bridge);
    // Every required check passed, with evidence: the claim is fully backed.
    bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).outcome === "completed_with_warnings",
      "the downgraded outcome",
    );

    expect(await eventsOfType(world.stub, "run.verified")).toEqual([]);
    const [ended] = await eventsOfType(world.stub, "run.completed_with_warnings");
    // DATABASE_URL was selected, and nothing was saved to send: it counts too.
    expect(JSON.stringify(ended?.payload)).toContain(
      "started without the required secrets DATABASE_URL, REDIS_URL",
    );
  });

  it("writes nothing for a session whose repository declares nothing", async () => {
    const world = await sessionOnRealDriver("sess_appr_unpinned", { repository: REPOSITORY });
    expect(await eventsOfType(world.stub, "secrets.disclosed")).toEqual([]);
  });
});

/** Obviously fake, and long enough that finding it anywhere is no accident. */
const FAKE_STRIPE = "fake-stripe-value-0001-not-a-secret";
const FAKE_DATABASE = "fake-database-url-0002-not-a-secret";

/** Seals a real envelope under the keyring the object itself opens with, replacing the placeholder row. */
async function sealSavedSecret(name: string, value: string): Promise<void> {
  const keyring = await deriveKeyring(env.ONCUE_BROKER_KEYRING, "credential");
  if (keyring.kind !== "ok") {
    throw new Error("no test keyring");
  }
  const saved = await saveDevelopmentSecret(
    env.DB,
    {
      keyring: keyring.keyring,
      now: WORLD_TIME,
      // Distinct per call: a replacement is a new row under a new id.
      newSecretId: () => `dsc_sealed_${name}_${crypto.randomUUID().slice(0, 8)}`,
    },
    { workspaceId: WORKSPACE, repositoryConnectionId: "rpc_appr" },
    name,
    value,
  );
  expect(saved.kind).toBe("saved");
}

/** Everything the object keeps: every table's rows as text. A value must be in none of it. */
async function everythingStored(world: SessionWorld): Promise<string> {
  return runInDurableObject(world.stub, (_instance, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'",
      )
      .toArray();
    return tables
      .map((table) =>
        JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${table.name}"`).toArray()),
      )
      .join("\n");
  });
}

async function secretRows(world: SessionWorld) {
  return runInDurableObject(world.stub, (_instance, state) => ({
    session: state.storage.sql
      .exec<Record<string, string | number | null>>(
        "SELECT name, supplied_generation FROM session_secret ORDER BY name",
      )
      .toArray(),
    requests: state.storage.sql
      .exec<Record<string, string | number | null>>(
        "SELECT secret_name, delivered_generation FROM approval_request ORDER BY secret_name",
      )
      .toArray(),
  }));
}

async function approveOne(sessionId: string, seal: boolean) {
  const { world, bridge } = await waitingWorld(sessionId);
  if (seal) {
    await sealSavedSecret("STRIPE_TEST_KEY", FAKE_STRIPE);
  }
  bridge.send(request(bridge, "ref_a"));
  const [stored] = await admitted(world);
  const approvalId = idOf(stored);
  const client = await openClient(world);
  await client.send(resolve("cmd_approve", approvalId, "approved"));
  await settle();
  return { world, bridge, approvalId };
}

describe("a value the user approved", () => {
  it("travels in a grant naming the waiting call, and is in nothing the object stores", async () => {
    const { world, bridge } = await approveOne("sess_appr_deliver", true);
    await waitFor(() => bridge.grants("secret").length === 1, "the secret grant");
    const [grant] = bridge.grants("secret");
    expect(grant).toMatchObject({
      requestRef: "ref_a",
      secrets: [{ name: "STRIPE_TEST_KEY", value: FAKE_STRIPE }],
    });
    // Approved is not supplied: nothing says so until the bridge answers.
    expect(await eventsOfType(world.stub, "secrets.supplied")).toEqual([]);
    expect((await secretRows(world)).session).toContainEqual({
      name: "STRIPE_TEST_KEY",
      supplied_generation: null,
    });
    expect(await everythingStored(world)).not.toContain(FAKE_STRIPE);
  });

  it("is supplied once the bridge says the file is written, and not before", async () => {
    const { world, bridge, approvalId } = await approveOne("sess_appr_supplied_ack", true);
    await waitFor(() => bridge.grants("secret").length === 1, "the secret grant");
    bridge.ack({ grantId: String(bridge.grants("secret")[0]?.grantId) });
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    const [supplied] = await eventsOfType(world.stub, "secrets.supplied");
    expect(supplied?.payload).toEqual({
      names: ["STRIPE_TEST_KEY"],
      approvalId,
      delivered: true,
    });
    const rows = await secretRows(world);
    expect(rows.session).toContainEqual({ name: "STRIPE_TEST_KEY", supplied_generation: 1 });
    expect(rows.requests).toEqual([{ secret_name: "STRIPE_TEST_KEY", delivered_generation: 1 }]);
    // A second ack for the same grant says nothing twice.
    bridge.ack({ grantId: String(bridge.grants("secret")[0]?.grantId) });
    await settle();
    expect(await eventsOfType(world.stub, "secrets.supplied")).toHaveLength(1);
    expect(await everythingStored(world)).not.toContain(FAKE_STRIPE);
  });

  it("is recorded as not delivered when the bridge could not put it in place", async () => {
    const { world, bridge, approvalId } = await approveOne("sess_appr_ack_rejected", true);
    await waitFor(() => bridge.grants("secret").length === 1, "the secret grant");
    bridge.ack(
      { grantId: String(bridge.grants("secret")[0]?.grantId) },
      { kind: "rejected", reason: "wrong_state" },
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    expect((await eventsOfType(world.stub, "secrets.supplied"))[0]?.payload).toEqual({
      names: ["STRIPE_TEST_KEY"],
      approvalId,
      delivered: false,
    });
    const rows = await secretRows(world);
    expect(rows.session).toContainEqual({ name: "STRIPE_TEST_KEY", supplied_generation: null });
    expect(rows.requests).toEqual([{ secret_name: "STRIPE_TEST_KEY", delivered_generation: null }]);
  });

  it("that cannot be opened sends no grant: the call is told, the card says so, and the row is marked", async () => {
    // The placeholder envelope `seedSavedSecrets` writes opens under no key.
    const { world, bridge, approvalId } = await approveOne("sess_appr_unreadable", false);
    await waitFor(() => bridge.frames("bridge.approval").length === 2, "the answer");
    expect(bridge.frames("bridge.approval").at(-1)).toMatchObject({
      requestRef: "ref_a",
      outcome: "unavailable",
    });
    expect(bridge.grants("secret")).toEqual([]);
    expect((await eventsOfType(world.stub, "secrets.supplied"))[0]?.payload).toEqual({
      names: ["STRIPE_TEST_KEY"],
      approvalId,
      delivered: false,
    });
    const row = await env.DB.prepare(
      "SELECT status FROM development_secret WHERE workspace_id = ? AND name = 'STRIPE_TEST_KEY'",
    )
      .bind(WORKSPACE)
      .first<{ status: string }>();
    expect(row?.status).toBe("unreadable");
  });

  it("is never sent to a generation that began stopping while it was being opened", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_stale");
    await sealSavedSecret("STRIPE_TEST_KEY", FAKE_STRIPE);
    bridge.send(request(bridge, "ref_a"));
    const [stored] = await admitted(world);
    // End the attachment during the D1 read that opens the value, as a stop's
    // revoke would. The env is shared, so the real binding is restored after.
    const realDb = env.DB;
    await runInDurableObject(world.stub, (instance, state) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        DB: new Proxy(realDb, {
          get(target, key) {
            if (key === "prepare") {
              state.storage.sql.exec("UPDATE sandbox_attachment SET state = 'stopped'");
            }
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      });
    });
    try {
      const client = await openClient(world);
      await client.send(resolve("cmd_approve", idOf(stored), "approved"));
      await settle();
    } finally {
      await runInDurableObject(world.stub, (instance) => {
        Object.assign((instance as unknown as { env: Env }).env, { DB: realDb });
      });
    }
    expect(bridge.grants("secret")).toEqual([]);
    expect(await eventsOfType(world.stub, "secrets.supplied")).toEqual([]);
  });
});

describe("the secrets a launch selected", () => {
  const launched = {
    baseSha: "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    pinned: [
      { name: "DATABASE_URL", kind: "required", selected: true },
      { name: "STRIPE_TEST_KEY", kind: "optional", selected: true },
      { name: "SENTRY_DSN", kind: "optional", selected: false },
    ],
    missingRequired: [],
    declarationInvalid: false,
  } as const;

  async function launchedWorld(sessionId: string) {
    const world = await sessionOnRealDriver(sessionId, {
      repository: REPOSITORY,
      body: { secrets: launched },
    });
    await seedSavedSecrets(["DATABASE_URL", "STRIPE_TEST_KEY", "SENTRY_DSN"]);
    return world;
  }

  it("reach the bridge before the run's first command, and only the selected ones", async () => {
    const world = await launchedWorld("sess_launch_deliver");
    await sealSavedSecret("DATABASE_URL", FAKE_DATABASE);
    await sealSavedSecret("STRIPE_TEST_KEY", FAKE_STRIPE);
    const bridge = await readyBridge(world);
    await waitFor(() => bridge.grants("secret").length === 1, "the secret grant");
    const [grant] = bridge.grants("secret");
    expect(grant).toMatchObject({
      requestRef: null,
      secrets: [
        { name: "DATABASE_URL", value: FAKE_DATABASE },
        { name: "STRIPE_TEST_KEY", value: FAKE_STRIPE },
      ],
    });
    const all = bridge.received.map((frame) =>
      frame.type === "bridge.grant" ? `grant:${String(frame.kind)}` : String(frame.type),
    );
    expect(all.indexOf("grant:secret")).toBeLessThan(all.indexOf("bridge.command"));

    bridge.ack({ grantId: String(grant?.grantId) });
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    expect((await eventsOfType(world.stub, "secrets.supplied"))[0]?.payload).toEqual({
      names: ["DATABASE_URL", "STRIPE_TEST_KEY"],
      approvalId: null,
      delivered: true,
    });
    const stored = await everythingStored(world);
    expect(stored).not.toContain(FAKE_DATABASE);
    expect(stored).not.toContain(FAKE_STRIPE);
  });

  it("send what opens and say what did not, and a run missing a required value cannot end verified", async () => {
    const world = await launchedWorld("sess_launch_partial");
    // DATABASE_URL keeps the placeholder envelope, which opens under no key.
    await sealSavedSecret("STRIPE_TEST_KEY", FAKE_STRIPE);
    const bridge = await readyBridge(world);
    await waitFor(() => bridge.grants("secret").length === 1, "the secret grant");
    expect(bridge.grants("secret")[0]?.secrets).toEqual([
      { name: "STRIPE_TEST_KEY", value: FAKE_STRIPE },
    ]);
    expect((await eventsOfType(world.stub, "secrets.supplied"))[0]?.payload).toEqual({
      names: ["DATABASE_URL"],
      approvalId: null,
      delivered: false,
    });
    bridge.ack({ grantId: String(bridge.grants("secret")[0]?.grantId) });
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 2,
      "the second secrets.supplied",
    );
    expect((await secretRows(world)).session).toEqual([
      { name: "DATABASE_URL", supplied_generation: null },
      { name: "SENTRY_DSN", supplied_generation: null },
      { name: "STRIPE_TEST_KEY", supplied_generation: 1 },
    ]);

    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    await recordCheck(world, bridge, { checkId: "chk_test" });
    completeVerification(bridge);
    bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).outcome === "completed_with_warnings",
      "the downgraded outcome",
    );
    expect(await eventsOfType(world.stub, "run.verified")).toEqual([]);
    const [ended] = await eventsOfType(world.stub, "run.completed_with_warnings");
    expect(JSON.stringify(ended?.payload)).toContain("DATABASE_URL");
  });

  it("send nothing when the repository's connection is gone", async () => {
    const world = await launchedWorld("sess_launch_disconnected");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM development_secret WHERE workspace_id = ?").bind(WORKSPACE),
      env.DB.prepare("DELETE FROM development_secret_superseded WHERE workspace_id = ?").bind(
        WORKSPACE,
      ),
      env.DB.prepare("DELETE FROM repository_connection WHERE workspace_id = ?").bind(WORKSPACE),
    ]);
    const bridge = await readyBridge(world);
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    expect(bridge.grants("secret")).toEqual([]);
    expect((await eventsOfType(world.stub, "secrets.supplied"))[0]?.payload).toMatchObject({
      delivered: false,
    });
  });

  it("send nothing in a session with no repository: a secret belongs to one", async () => {
    const world = await sessionOnRealDriver("sess_launch_no_repo", { body: { secrets: launched } });
    const bridge = await readyBridge(world);
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    expect(bridge.grants("secret")).toEqual([]);
  });

  it("send nothing when the deployment's keyring cannot be read, and the waiting call is told", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_no_keyring");
    await sealSavedSecret("STRIPE_TEST_KEY", FAKE_STRIPE);
    bridge.send(request(bridge, "ref_a"));
    const [stored] = await admitted(world);
    const keyring = env.ONCUE_BROKER_KEYRING;
    await runInDurableObject(world.stub, (instance) => {
      Object.assign((instance as unknown as { env: Env }).env, { ONCUE_BROKER_KEYRING: "" });
    });
    try {
      const client = await openClient(world);
      await client.send(resolve("cmd_approve", idOf(stored), "approved"));
      await waitFor(() => bridge.frames("bridge.approval").length === 2, "the answer");
      expect(bridge.frames("bridge.approval").at(-1)).toMatchObject({ outcome: "unavailable" });
      expect(bridge.grants("secret")).toEqual([]);
    } finally {
      await runInDurableObject(world.stub, (instance) => {
        Object.assign((instance as unknown as { env: Env }).env, { ONCUE_BROKER_KEYRING: keyring });
      });
    }
  });

  it("send nothing at all when none opens", async () => {
    const world = await launchedWorld("sess_launch_none");
    const bridge = await readyBridge(world);
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    expect(bridge.grants("secret")).toEqual([]);
    expect((await eventsOfType(world.stub, "secrets.supplied"))[0]?.payload).toEqual({
      names: ["DATABASE_URL", "STRIPE_TEST_KEY"],
      approvalId: null,
      delivered: false,
    });
  });
});

describe("a checkpoint withheld because the changes hold a secret", () => {
  const withheld = (bridge: TestBridge, pushId: string, category = "secret_in_changes") =>
    bridge.event("git.push.failed", {
      runId: "run_1",
      payload: {
        pushId,
        category,
        message: "OnCue published nothing. Found in: .env.",
        retryable: false,
      },
    } as never);

  it("is stored as a warning though nobody asked for a push, once this generation holds a secret", async () => {
    const { world, bridge } = await waitingWorld("sess_withheld_stored");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE session_secret SET supplied_generation = 1 WHERE name = 'STRIPE_TEST_KEY'",
      );
    });
    bridge.send(withheld(bridge, "push_unasked_1"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "git.push.failed")).length === 1,
      "the stored warning",
    );
    expect((await eventsOfType(world.stub, "git.push.failed"))[0]?.payload).toMatchObject({
      category: "secret_in_changes",
    });
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("is refused like any unrequested push when no secret was supplied, or under another category", async () => {
    const { world, bridge } = await waitingWorld("sess_withheld_refused");
    bridge.send(withheld(bridge, "push_unasked_1"));
    await settle();
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE session_secret SET supplied_generation = 1 WHERE name = 'STRIPE_TEST_KEY'",
      );
    });
    bridge.send(withheld(bridge, "push_unasked_2", "network"));
    await settle();
    expect(await eventsOfType(world.stub, "git.push.failed")).toEqual([]);
  });
});

describe("the object's own redactor, after it was evicted from memory", () => {
  interface Evictable {
    pendingRedactionSecrets: readonly string[];
    redactorGeneration: number | null;
    env: Env;
  }

  /** What an eviction does to the two things the object keeps only in memory. */
  async function evict(world: SessionWorld): Promise<void> {
    await runInDurableObject(world.stub, (instance) => {
      const held = instance as unknown as Evictable;
      held.pendingRedactionSecrets = [];
      held.redactorGeneration = null;
    });
  }

  async function suppliedWorld(sessionId: string) {
    const { world, bridge } = await approveOne(sessionId, true);
    await waitFor(() => bridge.grants("secret").length === 1, "the secret grant");
    return { world, bridge, grantId: String(bridge.grants("secret")[0]?.grantId) };
  }

  const leak = (bridge: TestBridge) =>
    bridge.event("message.completed", {
      runId: "run_1",
      payload: {
        messageId: "msg_leak",
        role: "assistant",
        parts: [{ type: "text", text: `the key is ${FAKE_STRIPE}` }],
      },
    } as never);

  it("is rebuilt from the names before the next frame is stored, for an acknowledged value", async () => {
    const { world, bridge, grantId } = await suppliedWorld("sess_redactor_acked");
    bridge.ack({ grantId });
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    await evict(world);
    bridge.send(leak(bridge));
    await waitFor(
      async () => (await eventsOfType(world.stub, "message.completed")).length === 1,
      "the stored message",
    );
    const stored = await everythingStored(world);
    expect(stored).toContain("the key is [REDACTED]");
    expect(stored).not.toContain(FAKE_STRIPE);
  });

  it("covers a value that was sent and not yet acknowledged", async () => {
    const { world, bridge } = await suppliedWorld("sess_redactor_in_flight");
    await evict(world);
    bridge.send(leak(bridge));
    await waitFor(
      async () => (await eventsOfType(world.stub, "message.completed")).length === 1,
      "the stored message",
    );
    expect(await everythingStored(world)).not.toContain(FAKE_STRIPE);
  });

  it("fails closed: with the keyring unreadable the frame is not stored and the socket is closed", async () => {
    const { world, bridge, grantId } = await suppliedWorld("sess_redactor_closed");
    bridge.ack({ grantId });
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    await evict(world);
    const keyring = env.ONCUE_BROKER_KEYRING;
    await runInDurableObject(world.stub, (instance) => {
      Object.assign((instance as unknown as Evictable).env, { ONCUE_BROKER_KEYRING: "" });
    });
    try {
      bridge.send(leak(bridge));
      await waitFor(() => bridge.client.readyState !== WebSocket.OPEN, "the socket to close");
      expect(await eventsOfType(world.stub, "message.completed")).toEqual([]);
    } finally {
      await runInDurableObject(world.stub, (instance) => {
        Object.assign((instance as unknown as Evictable).env, { ONCUE_BROKER_KEYRING: keyring });
      });
    }
  });

  it("goes on without a value the user has since deleted: the bridge's own layer still holds it", async () => {
    const { world, bridge, grantId } = await suppliedWorld("sess_redactor_deleted");
    bridge.ack({ grantId });
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    await env.DB.prepare("DELETE FROM development_secret WHERE workspace_id = ?")
      .bind(WORKSPACE)
      .run();
    await evict(world);
    bridge.send(bridge.event("message.completed", { runId: "run_1" }));
    await waitFor(
      async () => (await eventsOfType(world.stub, "message.completed")).length === 1,
      "the stored message",
    );
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("goes on when the repository was disconnected since", async () => {
    const { world, bridge, grantId } = await suppliedWorld("sess_redactor_disconnected");
    bridge.ack({ grantId });
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    await env.DB.batch([
      env.DB.prepare("DELETE FROM development_secret WHERE workspace_id = ?").bind(WORKSPACE),
      env.DB.prepare("DELETE FROM development_secret_superseded WHERE workspace_id = ?").bind(
        WORKSPACE,
      ),
      env.DB.prepare("DELETE FROM repository_connection WHERE workspace_id = ?").bind(WORKSPACE),
    ]);
    await evict(world);
    bridge.send(bridge.event("message.completed", { runId: "run_1" }));
    await waitFor(
      async () => (await eventsOfType(world.stub, "message.completed")).length === 1,
      "the stored message",
    );
  });
});

describe("the review's findings", () => {
  interface Held {
    approvalJudging: boolean;
    secretGrantDeadlineLoaded: boolean;
    pendingRedactionSecrets: readonly string[];
    redactorGeneration: number | null;
    alarm(): Promise<void>;
    webSocketMessage(ws: WebSocket, raw: string): Promise<void>;
  }

  it("admits one of a burst of requests: the second, judged while the first awaits D1, is refused uncounted", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_burst");
    await sealSavedSecret("STRIPE_TEST_KEY", FAKE_STRIPE);
    const first = JSON.stringify(request(bridge, "ref_burst_1"));
    const second = JSON.stringify(request(bridge, "ref_burst_2", { resource: "SENTRY_DSN" }));
    // Calling the handler twice without waiting reproduces the interleaving
    // the real runtime allows during the judgement's D1 reads.
    await runInDurableObject(world.stub, async (instance, state) => {
      const [ws] = state.getWebSockets("bridge");
      const held = instance as unknown as Held;
      await Promise.all([
        held.webSocketMessage(ws as WebSocket, first),
        held.webSocketMessage(ws as WebSocket, second),
      ]);
    });
    await settle();
    expect(await eventsOfType(world.stub, "approval.requested")).toHaveLength(1);
    const answers = bridge
      .frames("bridge.approval")
      .map((frame) => [frame.requestRef, frame.outcome]);
    expect(answers).toContainEqual(["ref_burst_1", "pending"]);
    expect(answers).toContainEqual(["ref_burst_2", "refused"]);
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
    const counted = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.sql.exec("SELECT refused FROM approval_refusal_count").toArray(),
    );
    expect(counted).toEqual([]);
  });

  it("rebuilds the redactor after a wake for a value the bridge received and then refused to write", async () => {
    const { world, bridge, grantId } = await (async () => {
      const made = await approveOne("sess_redactor_rejected_ack", true);
      await waitFor(() => made.bridge.grants("secret").length === 1, "the secret grant");
      return { ...made, grantId: String(made.bridge.grants("secret")[0]?.grantId) };
    })();
    bridge.ack({ grantId }, { kind: "rejected", reason: "wrong_state" });
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    await runInDurableObject(world.stub, (instance) => {
      const held = instance as unknown as Held;
      held.pendingRedactionSecrets = [];
      held.redactorGeneration = null;
    });
    bridge.send(
      bridge.event("message.completed", {
        runId: "run_1",
        payload: {
          messageId: "msg_leak_rejected",
          role: "assistant",
          parts: [{ type: "text", text: `the key is ${FAKE_STRIPE}` }],
        },
      } as never),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "message.completed")).length === 1,
      "the stored message",
    );
    const stored = await everythingStored(world);
    expect(stored).toContain("the key is [REDACTED]");
    expect(stored).not.toContain(FAKE_STRIPE);
  });

  it("redacts the value a generation was sent, not the one the user saved since", async () => {
    const { world, bridge } = await approveOne("sess_redactor_replaced", true);
    await waitFor(() => bridge.grants("secret").length === 1, "the secret grant");
    bridge.ack({ grantId: String(bridge.grants("secret")[0]?.grantId) });
    await waitFor(
      async () => (await eventsOfType(world.stub, "secrets.supplied")).length === 1,
      "secrets.supplied",
    );
    const REPLACED = "fake-stripe-value-0003-replaced";
    await sealSavedSecret("STRIPE_TEST_KEY", REPLACED);
    await runInDurableObject(world.stub, (instance) => {
      const held = instance as unknown as Held;
      held.pendingRedactionSecrets = [];
      held.redactorGeneration = null;
    });
    bridge.send(
      bridge.event("message.completed", {
        runId: "run_1",
        payload: {
          messageId: "msg_leak_replaced",
          role: "assistant",
          parts: [{ type: "text", text: `old ${FAKE_STRIPE} new ${REPLACED}` }],
        },
      } as never),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "message.completed")).length === 1,
      "the stored message",
    );
    const stored = await everythingStored(world);
    // The sandbox holds the old value, so that is the one the object redacts.
    expect(stored).toContain("old [REDACTED]");
    expect(stored).not.toContain(FAKE_STRIPE);
  });

  it("settles a secret grant the bridge never answered as not delivered, and tells the waiting call", async () => {
    const { world, bridge, approvalId } = await approveOne("sess_grant_unanswered", true);
    await waitFor(() => bridge.grants("secret").length === 1, "the secret grant");
    await runInDurableObject(world.stub, async (instance, state) => {
      // Two minutes ago, by the row itself: the deadline is read from storage.
      state.storage.sql.exec(
        "UPDATE bridge_dispatch SET created_at = ? WHERE state = 'sent'",
        new Date(Date.now() - 3 * 60_000).toISOString(),
      );
      // As after an eviction: the deadline is read back from the rows.
      (instance as unknown as Held).secretGrantDeadlineLoaded = false;
      await (instance as unknown as Held).alarm();
    });
    await settle();
    expect((await eventsOfType(world.stub, "secrets.supplied"))[0]?.payload).toEqual({
      names: ["STRIPE_TEST_KEY"],
      approvalId,
      delivered: false,
    });
    expect(bridge.frames("bridge.approval").at(-1)).toMatchObject({
      requestRef: "ref_a",
      outcome: "unavailable",
    });
    // A late ack settles nothing twice.
    bridge.ack({ grantId: String(bridge.grants("secret")[0]?.grantId) });
    await settle();
    expect(await eventsOfType(world.stub, "secrets.supplied")).toHaveLength(1);
  });

  it("admits nothing when the run ended during the judgement's reads: the sandbox is told, uncounted", async () => {
    const { world, bridge } = await waitingWorld("sess_appr_run_ended_meanwhile");
    await sealSavedSecret("STRIPE_TEST_KEY", FAKE_STRIPE);
    const realDb = env.DB;
    await runInDurableObject(world.stub, (instance, state) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        DB: new Proxy(realDb, {
          get(target, key) {
            if (key === "prepare") {
              // The run ends under the judgement, as a cancel landing in the await would.
              state.storage.sql.exec("UPDATE run SET state = 'cancelled', outcome = 'cancelled'");
            }
            const member = Reflect.get(target, key);
            return typeof member === "function" ? member.bind(target) : member;
          },
        }),
      });
    });
    try {
      bridge.send(request(bridge, "ref_late"));
      await waitFor(() => bridge.frames("bridge.approval").length === 1, "the answer");
      expect(bridge.frames("bridge.approval")[0]).toMatchObject({
        requestRef: "ref_late",
        outcome: "refused",
      });
      expect(await eventsOfType(world.stub, "approval.requested")).toEqual([]);
      expect(await approvalRows(world)).toEqual([]);
    } finally {
      await runInDurableObject(world.stub, (instance) => {
        Object.assign((instance as unknown as { env: Env }).env, { DB: realDb });
      });
    }
  });

  it("fails closed when D1 throws during the rebuild: the frame is not stored and the socket is closed", async () => {
    const { world, bridge } = await approveOne("sess_redactor_throws", true);
    await waitFor(() => bridge.grants("secret").length === 1, "the secret grant");
    const realDb = env.DB;
    await runInDurableObject(world.stub, (instance) => {
      const held = instance as unknown as Held & { env: Env };
      held.pendingRedactionSecrets = [];
      held.redactorGeneration = null;
      Object.assign(held.env, {
        DB: new Proxy(realDb, {
          get(target, key) {
            if (key === "prepare") {
              return () => {
                throw new Error("D1 is unavailable");
              };
            }
            const member = Reflect.get(target, key);
            return typeof member === "function" ? member.bind(target) : member;
          },
        }),
      });
    });
    try {
      bridge.send(bridge.event("message.completed", { runId: "run_1" }));
      await waitFor(() => bridge.client.readyState !== WebSocket.OPEN, "the socket to close");
      expect(await eventsOfType(world.stub, "message.completed")).toEqual([]);
    } finally {
      await runInDurableObject(world.stub, (instance) => {
        Object.assign((instance as unknown as { env: Env }).env, { DB: realDb });
      });
    }
  });

  it("settles a launch grant the bridge never answered too, with no waiting call to tell", async () => {
    const world = await sessionOnRealDriver("sess_launch_unanswered", {
      repository: REPOSITORY,
      body: {
        secrets: {
          baseSha: "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
          pinned: [{ name: "STRIPE_TEST_KEY", kind: "optional", selected: true }],
          missingRequired: [],
          declarationInvalid: false,
        },
      },
    });
    await seedSavedSecrets(["STRIPE_TEST_KEY"]);
    await sealSavedSecret("STRIPE_TEST_KEY", FAKE_STRIPE);
    const bridge = await readyBridge(world);
    await waitFor(() => bridge.grants("secret").length === 1, "the secret grant");
    await runInDurableObject(world.stub, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE bridge_dispatch SET created_at = ? WHERE state = 'sent'",
        new Date(Date.now() - 3 * 60_000).toISOString(),
      );
      // As after an eviction: the deadline is read back from the rows.
      (instance as unknown as Held).secretGrantDeadlineLoaded = false;
      await (instance as unknown as Held).alarm();
    });
    await settle();
    expect((await eventsOfType(world.stub, "secrets.supplied"))[0]?.payload).toEqual({
      names: ["STRIPE_TEST_KEY"],
      approvalId: null,
      delivered: false,
    });
    expect(bridge.frames("bridge.approval")).toEqual([]);
  });

  it("stores at most three withheld-checkpoint reports a generation, then refuses them as unrequested pushes", async () => {
    const { world, bridge } = await waitingWorld("sess_withheld_bound");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE session_secret SET supplied_generation = 1 WHERE name = 'STRIPE_TEST_KEY'",
      );
    });
    for (let index = 0; index < 4; index += 1) {
      bridge.send(
        bridge.event("git.push.failed", {
          runId: "run_1",
          payload: {
            pushId: `push_withheld_${index}`,
            category: "secret_in_changes",
            message: "OnCue published nothing.",
            retryable: false,
          },
        } as never),
      );
    }
    await settle();
    await settle();
    expect(await eventsOfType(world.stub, "git.push.failed")).toHaveLength(3);
  });

  it("counts refusals per generation: past the bound a fresh socket is closed on its first, and a new generation starts clean", async () => {
    const { world, bridge } = await waitingWorld("sess_refusals_generation");
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO approval_refusal_count (generation, refused) VALUES (1, ?)",
        MAX_SESSION_APPROVAL_REFUSALS,
      );
    });
    bridge.send(request(bridge, "ref_over", { resource: "NOT_DECLARED_NAME" }));
    await waitFor(() => bridge.client.readyState !== WebSocket.OPEN, "the socket to close");
    const rows = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ generation: number; refused: number }>(
          "SELECT generation, refused FROM approval_refusal_count ORDER BY generation",
        )
        .toArray(),
    );
    expect(rows).toEqual([{ generation: 1, refused: MAX_SESSION_APPROVAL_REFUSALS + 1 }]);
  });
});

describe("a project file the reader refused (record 08)", () => {
  it("keeps a session started anyway from ending verified", async () => {
    const world = await sessionOnRealDriver("sess_declaration_invalid", {
      repository: REPOSITORY,
      body: {
        secrets: {
          baseSha: "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
          pinned: [],
          missingRequired: [],
          declarationInvalid: true,
        },
      },
    });
    const bridge = await readyBridge(world);
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    await recordCheck(world, bridge, { checkId: "chk_test" });
    completeVerification(bridge);
    bridge.send(bridge.event("run.verified", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).outcome === "completed_with_warnings",
      "the downgraded outcome",
    );
    const [ended] = await eventsOfType(world.stub, "run.completed_with_warnings");
    expect(JSON.stringify(ended?.payload)).toContain("could not be read exactly");
  });
});

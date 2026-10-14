// Publishing at the object's boundary: the object asks only when policy
// allows and a run ended with work to push, names the branch in the grant,
// refuses reports for pushes it never asked for, and revokes the token on the report.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  ageEvents,
  completeVerification,
  eventsOfType,
  finishRun,
  fireAlarm,
  GITHUB_ORIGIN,
  INSTALLATION_ID,
  MODAL_CREDENTIAL,
  OWNER_USER_ID,
  openClient,
  quietRepositoryWorld,
  REPOSITORY,
  REPOSITORY_ID,
  recordCheck,
  registerSessionWorlds,
  runStartCommand,
  type SessionWorld,
  settle,
  stubFor,
  TASK_BRANCH,
  type TestBridge,
  WORLD_TIME,
  waitFor,
} from "../test/session-world";
import { MAX_PROPOSAL_REFUSALS } from "./session-object";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const HEAD = "c".repeat(40);
/** The workspace every world's session belongs to (`sessionOnRealDriver`). */
const WORKSPACE = "ws_1";

function allowPush(commandId: string, policyVersion = 1) {
  return {
    type: "policy.set",
    commandId,
    runId: null,
    issuedAt: WORLD_TIME,
    expected: { scope: "session", state: "active" },
    payload: {
      action: "set",
      policyVersion,
      commit: "auto",
      push: "auto",
      pullRequest: "manual",
    },
  };
}

async function publishRows(world: SessionWorld) {
  return runInDurableObject(world.stub, (_instance, state) => [
    ...state.storage.sql.exec<Record<string, string | null>>(
      "SELECT push_id, run_id, state, head_sha FROM publish ORDER BY requested_at",
    ),
  ]);
}

/** A quiet repository session whose user has just allowed pushing: the publish is asked for. */
async function publishRequested(sessionId: string): Promise<{
  world: SessionWorld;
  bridge: TestBridge;
  pushId: string;
}> {
  const { world, bridge } = await quietRepositoryWorld(sessionId);
  expect(await eventsOfType(world.stub, "git.push.requested")).toEqual([]);
  const client = await openClient(world);
  await client.send(allowPush("cmd_allow"));
  await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish command");
  const grant = bridge.grants("push")[0] as { grantId: string };
  return { world, bridge, pushId: grant.grantId };
}

function reportPublish(bridge: TestBridge, kind: "branch_push" | "local_commit" = "branch_push") {
  bridge.send(
    bridge.event("repository.checkpointed", {
      runId: "run_1",
      payload: {
        checkpointId: "ckpt_publish",
        kind,
        headSha: HEAD,
        bundle: null,
        reason: "user_requested",
      },
    }),
  );
}

describe("naming the branch at the first push", () => {
  /** A session that started without a task branch. */
  const UNNAMED = { ...REPOSITORY, taskBranch: null };

  it("clones the base branch with no task branch named, and names one from the run's summary at the first push", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_name_from_summary", {
      repository: UNNAMED,
    });
    const gitGrant = bridge.grants("git")[0] as { branch: string; taskBranch: string | null };
    expect(gitGrant.branch).toBe("main");
    expect(gitGrant.taskBranch).toBeNull();

    const client = await openClient(world);
    await client.send(allowPush("cmd_allow"));
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish command");

    const [requested] = await eventsOfType(world.stub, "git.push.requested");
    const branch = String((requested as { payload: { branch: string } }).payload.branch);
    expect(branch).toMatch(/^oncue\/[a-z0-9-]+-[0-9a-f]{4}$/);
    expect(branch).not.toMatch(/^oncue\/task-/);
    const grant = bridge.grants("push")[0] as { ref: string };
    expect(grant.ref).toBe(`refs/heads/${branch}`);
    // Projected to the index, where the rail, the sidebar, and the push
    // webhook's incident rule read it.
    await waitFor(async () => {
      const row = await env.DB.prepare("SELECT task_branch FROM session_index WHERE session_id = ?")
        .bind("sess_name_from_summary")
        .first<{ task_branch: string | null }>();
      return row?.task_branch === branch;
    }, "the index's branch");
  });

  it("uses the name the card asked for, once", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_name_requested", {
      repository: UNNAMED,
    });
    const client = await openClient(world);
    await client.send({
      ...allowPush("cmd_allow"),
      payload: { ...allowPush("cmd_allow").payload, branchName: "oncue/health-endpoint" },
    });
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish command");
    const [requested] = await eventsOfType(world.stub, "git.push.requested");
    expect((requested as { payload: { branch: string } }).payload.branch).toBe(
      "oncue/health-endpoint",
    );
    expect((bridge.grants("push")[0] as { ref: string }).ref).toBe(
      "refs/heads/oncue/health-endpoint",
    );
  });

  it("suffixes a requested name another session of the repository already holds, and indexes the suffixed one", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_name_taken", {
      repository: UNNAMED,
    });
    // Both sessions on one repository connection; the other holds the name.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO github_installation (
           installation_row_id, workspace_id, github_installation_id, github_user_id,
           account_login, account_type, status, user_token_reference, refresh_token_reference,
           user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
         ) VALUES ('ins_taken', ?, 4002, 42, 'acme', 'Organization', 'active', 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)`,
      ).bind(WORKSPACE, WORLD_TIME, WORLD_TIME, WORLD_TIME, WORLD_TIME, WORLD_TIME),
      env.DB.prepare(
        `INSERT INTO repository_connection (
           repository_connection_id, workspace_id, installation_row_id, github_repository_id,
           full_name, default_branch, status, created_at, updated_at
         ) VALUES ('rc_taken', ?, 'ins_taken', ?, 'acme/widgets', 'main', 'verified', ?, ?)`,
      ).bind(WORKSPACE, REPOSITORY_ID, WORLD_TIME, WORLD_TIME),
      env.DB.prepare(
        "UPDATE session_index SET repository_connection_id = 'rc_taken' WHERE session_id = ?",
      ).bind("sess_name_taken"),
      env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, task_id, state, repository_connection_id, task_branch, created_at, updated_at)
         VALUES ('sess_name_holder', ?, NULL, 'active', 'rc_taken', 'oncue/health-endpoint', ?, ?)`,
      ).bind(WORKSPACE, WORLD_TIME, WORLD_TIME),
    ]);
    const client = await openClient(world);
    await client.send({
      ...allowPush("cmd_allow"),
      payload: { ...allowPush("cmd_allow").payload, branchName: "oncue/health-endpoint" },
    });
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish command");
    const [requested] = await eventsOfType(world.stub, "git.push.requested");
    const branch = String((requested as { payload: { branch: string } }).payload.branch);
    expect(branch).toMatch(/^oncue\/health-endpoint-[0-9a-f]{4}$/);
    expect((bridge.grants("push")[0] as { ref: string }).ref).toBe(`refs/heads/${branch}`);
    const row = await env.DB.prepare("SELECT task_branch FROM session_index WHERE session_id = ?")
      .bind("sess_name_taken")
      .first<{ task_branch: string | null }>();
    expect(row?.task_branch).toBe(branch);
  });

  it("suffixes a name another workspace's session holds on the same GitHub repository", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_name_taken_elsewhere", {
      repository: UNNAMED,
    });
    // Each workspace has its own connection to the one GitHub repository; the
    // other workspace's session works directly on a branch of that name.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user (id, status, created_at, updated_at) VALUES ('usr_elsewhere', 'active', ?, ?) ON CONFLICT DO NOTHING",
      ).bind(WORLD_TIME, WORLD_TIME),
      env.DB.prepare(
        "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES ('ws_elsewhere', 'usr_elsewhere', 'private', ?, ?) ON CONFLICT DO NOTHING",
      ).bind(WORLD_TIME, WORLD_TIME),
      env.DB.prepare(
        `INSERT INTO github_installation (
           installation_row_id, workspace_id, github_installation_id, github_user_id,
           account_login, account_type, status, user_token_reference, refresh_token_reference,
           user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
         ) VALUES ('ins_mine_elsewhere', ?, 4003, 42, 'acme', 'Organization', 'active', 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?),
                  ('ins_theirs_elsewhere', 'ws_elsewhere', 4003, 43, 'acme', 'Organization', 'active', 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        WORKSPACE,
        WORLD_TIME,
        WORLD_TIME,
        WORLD_TIME,
        WORLD_TIME,
        WORLD_TIME,
        WORLD_TIME,
        WORLD_TIME,
        WORLD_TIME,
        WORLD_TIME,
        WORLD_TIME,
      ),
      env.DB.prepare(
        `INSERT INTO repository_connection (
           repository_connection_id, workspace_id, installation_row_id, github_repository_id,
           full_name, default_branch, status, created_at, updated_at
         ) VALUES ('rc_mine_elsewhere', ?, 'ins_mine_elsewhere', ?, 'acme/widgets', 'main', 'verified', ?, ?),
                  ('rc_theirs_elsewhere', 'ws_elsewhere', 'ins_theirs_elsewhere', ?, 'acme/widgets', 'main', 'verified', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        WORKSPACE,
        REPOSITORY_ID,
        WORLD_TIME,
        WORLD_TIME,
        REPOSITORY_ID,
        WORLD_TIME,
        WORLD_TIME,
      ),
      // An earlier case may already hold this workspace's connection to it.
      env.DB.prepare(
        `UPDATE session_index SET repository_connection_id = (
           SELECT repository_connection_id FROM repository_connection
            WHERE workspace_id = ? AND github_repository_id = ?)
          WHERE session_id = ?`,
      ).bind(WORKSPACE, REPOSITORY_ID, "sess_name_taken_elsewhere"),
      env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, task_id, state, repository_connection_id, task_branch, branch_mode, created_at, updated_at)
         VALUES ('sess_name_holder_elsewhere', 'ws_elsewhere', NULL, 'active', 'rc_theirs_elsewhere', 'oncue/shared-name', 'existing_branch', ?, ?)`,
      ).bind(WORLD_TIME, WORLD_TIME),
    ]);
    const client = await openClient(world);
    await client.send({
      ...allowPush("cmd_allow"),
      payload: { ...allowPush("cmd_allow").payload, branchName: "oncue/shared-name" },
    });
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish command");
    const [requested] = await eventsOfType(world.stub, "git.push.requested");
    expect(String((requested as { payload: { branch: string } }).payload.branch)).toMatch(
      /^oncue\/shared-name-[0-9a-f]{4}$/,
    );
  });

  it("pushes nothing when the name cannot be indexed: the webhook would take the push for an incident", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_name_unindexed", {
      repository: UNNAMED,
    });
    await runInDurableObject(world.stub, (instance) => {
      const holder = instance as unknown as { env: { DB: D1Database } };
      const real = holder.env.DB;
      holder.env = {
        ...holder.env,
        DB: new Proxy(real, {
          get(target, property) {
            if (property !== "prepare") {
              return Reflect.get(target, property);
            }
            return (sql: string) =>
              sql.includes("SET task_branch = ?1")
                ? { bind: () => ({ run: () => Promise.reject(new Error("no such column")) }) }
                : target.prepare(sql);
          },
        }),
      };
    });
    const client = await openClient(world);
    await client.send(allowPush("cmd_allow"));
    await settle();
    expect(bridge.commands("checkpoint.create")).toEqual([]);
    expect(bridge.grants("push")).toEqual([]);
    expect(await eventsOfType(world.stub, "git.push.requested")).toEqual([]);
    const branch = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ task_branch: string | null }>("SELECT task_branch FROM session_repository")
        .one(),
    );
    expect(branch.task_branch).toBeNull();
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("marks the branch pushed once the publish reports it, so the next generation clones it", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_name_pushed", {
      repository: UNNAMED,
    });
    const client = await openClient(world);
    await client.send(allowPush("cmd_allow"));
    await waitFor(() => bridge.grants("push").length === 1, "the publish's grant");
    const pushed = () =>
      runInDurableObject(world.stub, (_instance, state) =>
        state.storage.sql.exec<{ pushed: number }>("SELECT pushed FROM task_branch_ref").one(),
      );
    expect((await pushed()).pushed).toBe(0);
    reportPublish(bridge);
    await waitFor(async () => (await pushed()).pushed === 1, "the pushed mark");
  });

  it("gives up when the name and its suffixed retry are both taken, and pushes nothing", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_name_twice_taken", {
      repository: UNNAMED,
    });
    // The index write changes nothing however the name is spelled, while the
    // session's row is still there: every name is another session's.
    await runInDurableObject(world.stub, (instance) => {
      const holder = instance as unknown as { env: { DB: D1Database } };
      const real = holder.env.DB;
      holder.env = {
        ...holder.env,
        DB: new Proxy(real, {
          get(target, property) {
            if (property !== "prepare") {
              return Reflect.get(target, property);
            }
            return (sql: string) =>
              sql.includes("SET task_branch = ?1")
                ? { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }
                : target.prepare(sql);
          },
        }),
      };
    });
    const client = await openClient(world);
    await client.send(allowPush("cmd_allow"));
    await settle();
    expect(bridge.grants("push")).toEqual([]);
    expect(await eventsOfType(world.stub, "git.push.requested")).toEqual([]);
  });

  it("pushes nothing for a session whose index row is gone, and an idle stop then checkpoints without a grant", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_name_no_row", {
      repository: UNNAMED,
    });
    await env.DB.prepare("DELETE FROM session_index WHERE session_id = ?")
      .bind("sess_name_no_row")
      .run();
    const client = await openClient(world);
    await client.send(allowPush("cmd_allow"));
    await settle();
    expect(bridge.grants("push")).toEqual([]);
    expect(bridge.commands("checkpoint.create")).toEqual([]);

    // The idle stop still saves the work, as a bundle: no name, no grant.
    await ageEvents(world.stub, 30 * 60_000);
    await fireAlarm(world.stub);
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the idle checkpoint");
    expect(bridge.grants("push")).toEqual([]);
    const branch = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ task_branch: string | null }>("SELECT task_branch FROM session_repository")
        .one(),
    );
    expect(branch.task_branch).toBeNull();
  });

  it("names once when two pushes ask during the same index write", async () => {
    const { world } = await quietRepositoryWorld("sess_name_once", { repository: UNNAMED });
    const names = await runInDurableObject(world.stub, async (instance) => {
      const object = instance as unknown as {
        readSession: () => unknown;
        readRepositoryBase: () => unknown;
        nameTaskBranch: (session: unknown, repository: unknown) => Promise<string | null>;
      };
      const session = object.readSession();
      const repository = object.readRepositoryBase();
      const first = object.nameTaskBranch(session, repository);
      const second = object.nameTaskBranch(session, repository);
      expect(second).toBe(first);
      return Promise.all([first, second]);
    });
    expect(names[0]).toMatch(/^oncue\//);
    expect(names[1]).toBe(names[0]);
    const row = await env.DB.prepare("SELECT task_branch FROM session_index WHERE session_id = ?")
      .bind("sess_name_once")
      .first<{ task_branch: string | null }>();
    expect(row?.task_branch).toBe(names[0]);
  });

  it("keeps a branch the session started with", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_name_kept");
    const client = await openClient(world);
    await client.send({
      ...allowPush("cmd_allow"),
      payload: { ...allowPush("cmd_allow").payload, branchName: "oncue/ignored" },
    });
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish command");
    expect((bridge.grants("push")[0] as { ref: string }).ref).toBe(`refs/heads/${TASK_BRANCH}`);
  });
});

describe("a publish", () => {
  it("is asked for on the click that allows a push, with the session branch as the one ref", async () => {
    const { world, bridge, pushId } = await publishRequested("sess_publish_happy");

    const [requested] = await eventsOfType(world.stub, "git.push.requested");
    expect(requested).toMatchObject({
      runId: "run_1",
      payload: {
        headSha: null,
        commitCount: 1,
        policy: { policyVersion: 2, rule: "auto_push", approvalId: null },
      },
    });
    const grant = bridge.grants("push")[0] as Record<string, unknown>;
    expect(grant).toMatchObject({ grantId: pushId });
    expect(String(grant.ref)).toMatch(/^refs\/heads\//);
    expect(bridge.commands("checkpoint.create")[0]).toMatchObject({
      command: { payload: { reason: "user_requested" } },
    });
    expect(await publishRows(world)).toEqual([
      { push_id: pushId, run_id: "run_1", state: "requested", head_sha: null },
    ]);

    const revocationsBefore = world.github.calls.filter((call) => call.tokenRevoked).length;
    bridge.ack({ grantId: pushId });
    bridge.send(bridge.event("git.committed", { runId: "run_1" }));
    bridge.send(
      bridge.event("git.push.completed", {
        runId: "run_1",
        payload: { pushId, branch: "oncue/task", headSha: HEAD, remoteSha: HEAD },
      }),
    );
    reportPublish(bridge);
    await waitFor(
      () => world.github.calls.filter((call) => call.tokenRevoked).length > revocationsBefore,
      "the push token's revocation",
    );

    expect(await eventsOfType(world.stub, "git.committed")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "git.push.completed")).toHaveLength(1);
    expect(await publishRows(world)).toEqual([
      { push_id: pushId, run_id: "run_1", state: "pushed", head_sha: HEAD },
    ]);
    // No stop was under way: the sandbox is still up.
    expect(await eventsOfType(world.stub, "sandbox.stopped")).toEqual([]);
  });

  it("is made once for a run: a second click that changes the policy does not push again", async () => {
    const { world, bridge, pushId } = await publishRequested("sess_publish_once");
    bridge.ack({ grantId: pushId });
    bridge.send(
      bridge.event("git.push.completed", {
        runId: "run_1",
        payload: { pushId, branch: "oncue/task", headSha: HEAD, remoteSha: HEAD },
      }),
    );
    reportPublish(bridge);
    await waitFor(async () => (await publishRows(world))[0]?.state === "pushed", "the push");

    const client = await openClient(world);
    await client.send({
      ...allowPush("cmd_more", 2),
      payload: {
        action: "set",
        policyVersion: 2,
        commit: "auto",
        push: "auto",
        pullRequest: "auto_after_verification",
      },
    });
    await waitFor(
      async () => (await eventsOfType(world.stub, "policy.updated")).length === 2,
      "the second update",
    );
    await settle();
    expect(await eventsOfType(world.stub, "git.push.requested")).toHaveLength(1);
    expect(bridge.commands("checkpoint.create")).toHaveLength(1);
  });

  it("records a failed push, and an unchanged tree as nothing to push", async () => {
    const failed = await publishRequested("sess_publish_failed");
    failed.bridge.send(
      failed.bridge.event("git.push.failed", {
        runId: "run_1",
        payload: {
          pushId: failed.pushId,
          branch: "oncue/task",
          headSha: HEAD,
          category: "workflow_file_rejected",
          message: "GitHub blocked the push.",
          retryable: false,
        },
      }),
    );
    reportPublish(failed.bridge, "local_commit");
    await waitFor(async () => (await publishRows(failed.world))[0]?.state === "failed", "failed");

    const unchanged = await publishRequested("sess_publish_unchanged");
    reportPublish(unchanged.bridge);
    await waitFor(
      async () => (await publishRows(unchanged.world))[0]?.state === "nothing_to_push",
      "nothing to push",
    );
    expect(await eventsOfType(unchanged.world.stub, "git.push.completed")).toEqual([]);
  });

  it("never stores a push report it did not ask for, and cuts off a socket that keeps sending them", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_publish_forged");
    for (let index = 0; index <= MAX_PROPOSAL_REFUSALS; index += 1) {
      bridge.send(
        bridge.event(index % 2 === 0 ? "git.push.completed" : "git.push.failed", {
          runId: "run_1",
        }),
      );
    }
    await waitFor(() => bridge.client.readyState === WebSocket.CLOSED, "the closed socket");
    expect(await eventsOfType(world.stub, "git.push.completed")).toEqual([]);
    expect(await eventsOfType(world.stub, "git.push.failed")).toEqual([]);
    expect(await publishRows(world)).toEqual([]);
  });

  it("that never reports stops holding up the next one once its grant has expired", async () => {
    const { world, bridge } = await publishRequested("sess_publish_lost");
    const client = await openClient(world);
    const nextRun = async (commandId: string, messageId: string) => {
      const before = bridge.commands("run.start").length;
      await client.send(runStartCommand(commandId, messageId, "Do more."));
      await waitFor(() => bridge.commands("run.start").length > before, "the next run");
      const runId = String(bridge.commands("run.start").at(-1)?.runId);
      await finishRun(world, bridge, runId);
      await settle();
    };

    // The first publish is still open, so the second run's end asks for nothing.
    await nextRun("cmd_run_2", "msg_run_2");
    expect(await eventsOfType(world.stub, "git.push.requested")).toHaveLength(1);

    // Past the grant's lifetime it no longer counts as open.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE publish SET requested_at = '2020-01-01T00:00:00.000Z'");
    });
    await nextRun("cmd_run_3", "msg_run_3");
    await waitFor(
      async () => (await eventsOfType(world.stub, "git.push.requested")).length === 2,
      "the next publish",
    );
  });

  it("is not asked for while the policy says manual, however the run ended", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_publish_manual");
    await settle();
    expect(await eventsOfType(world.stub, "git.push.requested")).toEqual([]);
    expect(bridge.grants("push")).toEqual([]);
  });
});

const WITH_PULL_REQUEST = {
  repository: { ...REPOSITORY, baseBranch: "main", appOrigin: "https://oncue.example" },
};

function allowPullRequests(commandId: string, policyVersion = 1) {
  return {
    ...allowPush(commandId, policyVersion),
    payload: {
      action: "set",
      policyVersion,
      commit: "auto",
      push: "auto",
      pullRequest: "auto_after_verification",
    },
  };
}

/** The user allowed pushing and pull requests, and the bridge reports the push. */
async function published(
  sessionId: string,
  options: Parameters<typeof quietRepositoryWorld>[1] = WITH_PULL_REQUEST,
) {
  const { world, bridge } = await quietRepositoryWorld(sessionId, options);
  world.github.setRef("acme/widgets", "main", "sha-main");
  world.github.setRef("acme/widgets", TASK_BRANCH, HEAD);
  const client = await openClient(world);
  await client.send(allowPullRequests("cmd_allow"));
  await waitFor(() => bridge.grants("push").length === 1, "the publish's grant");
  const pushId = String((bridge.grants("push")[0] as { grantId: string }).grantId);
  bridge.send(
    bridge.event("git.push.completed", {
      runId: "run_1",
      payload: { pushId, branch: TASK_BRANCH, headSha: HEAD, remoteSha: HEAD },
    }),
  );
  reportPublish(bridge);
  return { world, bridge, client };
}

describe("the draft pull request", () => {
  it("writes nothing into a session deleted and erased while GitHub was still answering", async () => {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { world, bridge } = await quietRepositoryWorld("sess_pr_deleted", WITH_PULL_REQUEST);
    world.github.setRef("acme/widgets", "main", "sha-main");
    world.github.setRef("acme/widgets", TASK_BRANCH, HEAD);
    // GitHub's answer to the pull request's own call is held open.
    const worldFetch = globalThis.fetch;
    let held = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(GITHUB_ORIGIN) && url.includes("/pulls")) {
        held += 1;
        await opened;
      }
      return worldFetch(input as string, init);
    }) as typeof fetch;
    const client = await openClient(world);
    await client.send(allowPullRequests("cmd_allow"));
    await waitFor(() => bridge.grants("push").length === 1, "the publish's grant");
    const pushId = String((bridge.grants("push")[0] as { grantId: string }).grantId);
    bridge.send(
      bridge.event("git.push.completed", {
        runId: "run_1",
        payload: { pushId, branch: TASK_BRANCH, headSha: HEAD, remoteSha: HEAD },
      }),
    );
    reportPublish(bridge);
    await waitFor(() => held > 0, "the pull request's call");

    await runInDurableObject(world.stub, (instance) =>
      instance.deleteSession({
        requestedByUserId: OWNER_USER_ID,
        modalCredential: MODAL_CREDENTIAL,
      }),
    );
    await waitFor(
      async () =>
        (await runInDurableObject(world.stub, (instance) => instance.eraseSession())).kind ===
        "erased",
      "the erase",
    );
    open();
    await waitFor(() => world.github.pullRequests.length === 1, "GitHub's answer");
    await settle();

    // The pull request is GitHub's and stays; the erased object holds nothing of it.
    expect(
      await runInDurableObject(world.stub, (instance, state) => ({
        session: instance.readSession(),
        events: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM event").one().n,
        outbox: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n,
        pullRequests: state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM pull_request")
          .one().n,
      })),
    ).toEqual({ session: null, events: 0, outbox: 0, pullRequests: 0 });
  });

  it("is opened by the control plane after the push, with the verification section, under its own revoked token", async () => {
    const { world } = await published("sess_pr_created");
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.created")).length === 1,
      "the pull request",
    );

    const [created] = await eventsOfType(world.stub, "pull_request.created");
    expect(created).toMatchObject({
      runId: "run_1",
      payload: {
        number: 1,
        url: "https://github.com/acme/widgets/pull/1",
        draft: true,
        baseBranch: "main",
        headBranch: TASK_BRANCH,
        headSha: HEAD,
        verificationSectionVersion: 1,
      },
    });
    const [pullRequest] = world.github.pullRequests;
    expect(pullRequest).toMatchObject({ draft: true, base: "main", head: TASK_BRANCH });
    expect(pullRequest?.body).toContain("This change is NOT fully verified.");
    expect(pullRequest?.body).toContain("https://oncue.example/sessions/sess_pr_created");
    // The pull-request token was narrowed to the one repository and its two permissions, and revoked.
    const mint = world.github.calls.find(
      (call) => call.tokenNarrowing?.permissions.pull_requests !== undefined,
    );
    expect(mint?.tokenNarrowing).toEqual({
      repositoryIds: [REPOSITORY.repositoryId],
      permissions: { pull_requests: "write", contents: "read" },
    });
    expect(world.github.calls.at(-1)).toMatchObject({
      path: "/installation/token",
      tokenRevoked: true,
    });
  });

  it("is the same pull request on the next run, its section replaced and versioned", async () => {
    const { world, bridge, client } = await published("sess_pr_updated");
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.created")).length === 1,
      "the pull request",
    );

    await client.send(runStartCommand("cmd_run_2", "msg_run_2", "Now fix the typo."));
    await waitFor(() => bridge.commands("run.start").length === 2, "the next run");
    const runId = String(bridge.commands("run.start")[1]?.runId);
    bridge.send(bridge.event("run.started", { runId }));
    await recordCheck(world, bridge, { runId, checkId: "test" });
    await finishRun(world, bridge, runId);
    await waitFor(() => bridge.grants("push").length === 2, "the second publish's grant");
    const pushId = String((bridge.grants("push")[1] as { grantId: string }).grantId);
    const next = "d".repeat(40);
    world.github.setRef("acme/widgets", TASK_BRANCH, next);
    bridge.send(
      bridge.event("git.push.completed", {
        runId,
        payload: { pushId, branch: TASK_BRANCH, headSha: next, remoteSha: next },
      }),
    );
    bridge.send(
      bridge.event("repository.checkpointed", {
        runId,
        payload: {
          checkpointId: "ckpt_publish_2",
          kind: "branch_push",
          headSha: next,
          bundle: null,
          reason: "user_requested",
        },
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.updated")).length === 1,
      "the update",
    );

    expect((await eventsOfType(world.stub, "pull_request.updated"))[0]).toMatchObject({
      runId,
      payload: {
        number: 1,
        headSha: next,
        verificationSectionVersion: 2,
        changed: ["verification_section"],
      },
    });
    expect(world.github.pullRequests).toHaveLength(1);
    const body = world.github.pullRequests[0]?.body ?? "";
    expect(body.match(/oncue:verification:start/g)).toHaveLength(1);
    // By the check's name, as the sandbox reported it, not by its id.
    expect(body).toContain("- `unit tests`: passed");
    expect(body).not.toContain("- `test`:");
    expect(body).toContain("Checked at `dddddddddddd`");
  });

  it("is not opened when the branch has nothing ahead of its base, and the session carries on", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_pr_no_commits", WITH_PULL_REQUEST);
    world.github.setRef("acme/widgets", "main", "sha-same");
    world.github.setRef("acme/widgets", TASK_BRANCH, "sha-same");
    const client = await openClient(world);
    await client.send(allowPullRequests("cmd_allow"));
    await waitFor(() => bridge.grants("push").length === 1, "the publish's grant");
    const revocationsBefore = world.github.calls.filter((call) => call.tokenRevoked).length;
    reportPublish(bridge);
    await waitFor(
      () => world.github.calls.filter((call) => call.tokenRevoked).length >= revocationsBefore + 2,
      "both tokens' revocation",
    );
    await settle();
    expect(await eventsOfType(world.stub, "pull_request.created")).toEqual([]);
    expect(world.github.pullRequests).toEqual([]);
  });

  it("is not opened after a failed push, under a policy that does not allow it, or for a session with no base branch", async () => {
    const failed = await quietRepositoryWorld("sess_pr_push_failed", WITH_PULL_REQUEST);
    const failedClient = await openClient(failed.world);
    await failedClient.send(allowPullRequests("cmd_allow"));
    await waitFor(() => failed.bridge.grants("push").length === 1, "the publish's grant");
    const pushId = String((failed.bridge.grants("push")[0] as { grantId: string }).grantId);
    failed.bridge.send(
      failed.bridge.event("git.push.failed", {
        runId: "run_1",
        payload: {
          pushId,
          branch: TASK_BRANCH,
          headSha: HEAD,
          category: "network",
          message: "The push could not reach GitHub.",
          retryable: true,
        },
      }),
    );
    reportPublish(failed.bridge, "local_commit");

    const pushOnly = await publishRequested("sess_pr_push_only");
    reportPublish(pushOnly.bridge);

    const legacy = await published("sess_pr_legacy", {});

    await settle();
    await settle();
    for (const world of [failed.world, pushOnly.world, legacy.world]) {
      expect(await eventsOfType(world.stub, "pull_request.created")).toEqual([]);
      expect(world.github.pullRequests).toEqual([]);
    }
  });

  it("says every required check passed when the run ended verified, with no warnings", async () => {
    const { world, bridge, client } = await published("sess_pr_verified");
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.created")).length === 1,
      "the pull request",
    );
    await client.send(runStartCommand("cmd_run_2", "msg_run_2", "Make it pass."));
    await waitFor(() => bridge.commands("run.start").length === 2, "the next run");
    const runId = String(bridge.commands("run.start")[1]?.runId);
    bridge.send(bridge.event("run.started", { runId }));
    await recordCheck(world, bridge, { runId, checkId: "test" });
    completeVerification(bridge, { runId, requiredTotal: 1 });
    bridge.send(bridge.event("run.verified", { runId }));
    await waitFor(() => bridge.grants("push").length === 2, "the second publish's grant");
    // A check with no stored name (older sessions) reads by its id.
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM verification_check_name");
    });
    bridge.send(
      bridge.event("repository.checkpointed", {
        runId,
        payload: {
          checkpointId: "ckpt_verified",
          kind: "branch_push",
          headSha: HEAD,
          bundle: null,
          reason: "user_requested",
        },
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.updated")).length === 1,
      "the update",
    );
    const body = world.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("Every required check passed.");
    expect(body).not.toContain("**Warnings**");
    expect(body).toContain("- `test`: passed");
  });

  it("is named after its branch when the session has no title", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_pr_untitled", WITH_PULL_REQUEST);
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET title = NULL");
    });
    world.github.setRef("acme/widgets", "main", "sha-main");
    world.github.setRef("acme/widgets", TASK_BRANCH, HEAD);
    const client = await openClient(world);
    await client.send(allowPullRequests("cmd_allow"));
    await waitFor(() => bridge.grants("push").length === 1, "the publish's grant");
    reportPublish(bridge);
    await waitFor(() => world.github.pullRequests.length === 1, "the pull request");
    expect(world.github.pullRequests[0]?.title).toBe(`OnCue: ${TASK_BRANCH}`);
  });

  it("is not opened when the deployment has lost its GitHub App by then", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_pr_unconfigured", WITH_PULL_REQUEST);
    world.github.setRef("acme/widgets", TASK_BRANCH, HEAD);
    const client = await openClient(world);
    await client.send(allowPullRequests("cmd_allow"));
    await waitFor(() => bridge.grants("push").length === 1, "the publish's grant");
    await runInDurableObject(world.stub, (instance) => {
      Object.assign((instance as unknown as { env: Record<string, string> }).env, {
        ONCUE_GITHUB_APP_ID: "",
        ONCUE_GITHUB_APP_PRIVATE_KEY: "",
      });
    });
    reportPublish(bridge);
    await settle();
    await settle();
    expect(await eventsOfType(world.stub, "pull_request.created")).toEqual([]);
  });

  it("an unprompted checkpoint report from the sandbox reaches GitHub not at all, however many arrive", async () => {
    const { world, bridge } = await published("sess_pr_unprompted");
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.created")).length === 1,
      "the pull request",
    );
    await settle();
    const callsBefore = world.github.calls.length;
    const bodyBefore = world.github.pullRequests[0]?.body;

    for (let index = 0; index < 5; index += 1) {
      bridge.send(
        bridge.event("repository.checkpointed", {
          runId: "run_1",
          payload: {
            checkpointId: `ckpt_forged_${index}`,
            kind: "branch_push",
            headSha: "f".repeat(40),
            bundle: null,
            reason: "user_requested",
          },
        }),
      );
    }
    await waitFor(
      async () => (await eventsOfType(world.stub, "repository.checkpointed")).length === 6,
      "the forged reports to be stored",
    );
    await settle();

    expect(world.github.calls).toHaveLength(callsBefore);
    expect(await eventsOfType(world.stub, "pull_request.updated")).toEqual([]);
    expect(world.github.pullRequests[0]?.body).toBe(bodyBefore);
  });

  it("a publish whose commit was never pushed is a failed publish, not nothing to push, and opens no pull request", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_pr_unpushed", WITH_PULL_REQUEST);
    world.github.setRef("acme/widgets", "main", "sha-main");
    world.github.setRef("acme/widgets", TASK_BRANCH, HEAD);
    const client = await openClient(world);
    await client.send(allowPullRequests("cmd_allow"));
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish command");
    // The bridge had no usable grant: it committed locally and reports no push at all.
    reportPublish(bridge, "local_commit");
    await waitFor(async () => (await publishRows(world))[0]?.state === "failed", "the failure");
    await settle();
    expect(await eventsOfType(world.stub, "pull_request.created")).toEqual([]);
    expect(world.github.pullRequests).toEqual([]);
  });

  it("opens nothing when the publish's report arrives after the user has stopped the sandbox", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_pr_stopping", WITH_PULL_REQUEST, {
      closeOnShutdown: false,
    });
    world.github.setRef("acme/widgets", "main", "sha-main");
    world.github.setRef("acme/widgets", TASK_BRANCH, HEAD);
    const client = await openClient(world);
    await client.send(allowPullRequests("cmd_allow"));
    await waitFor(() => bridge.grants("push").length === 1, "the publish's grant");

    // The stop first, all the way through; then the bridge's report, late.
    await world.stub.fetch("https://session/internal/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestedByUserId: OWNER_USER_ID, modalCredential: MODAL_CREDENTIAL }),
    });
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
    reportPublish(bridge);
    await waitFor(
      async () => (await eventsOfType(world.stub, "repository.checkpointed")).length === 1,
      "the late report to be stored",
    );
    await settle();

    expect(await eventsOfType(world.stub, "pull_request.created")).toEqual([]);
    expect(world.github.pullRequests).toEqual([]);
  });

  it("still records the pull request when the Worker's index cannot be written, as on a database without migration 0007", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_pr_no_column", WITH_PULL_REQUEST);
    world.github.setRef("acme/widgets", "main", "sha-main");
    world.github.setRef("acme/widgets", TASK_BRANCH, HEAD);
    await runInDurableObject(world.stub, (instance) => {
      const holder = instance as unknown as { env: { DB: D1Database } };
      const real = holder.env.DB;
      holder.env = {
        ...holder.env,
        DB: new Proxy(real, {
          get(target, property) {
            if (property !== "prepare") {
              return Reflect.get(target, property);
            }
            return (sql: string) =>
              sql.includes("pull_request_number")
                ? { bind: () => ({ run: () => Promise.reject(new Error("no such column")) }) }
                : target.prepare(sql);
          },
        }),
      };
    });
    const client = await openClient(world);
    await client.send(allowPullRequests("cmd_allow"));
    await waitFor(() => bridge.grants("push").length === 1, "the publish's grant");
    reportPublish(bridge);
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.created")).length === 1,
      "the pull request, recorded despite the index",
    );
    // The bridge's socket is still up: the failure did not escape the frame handler.
    expect(bridge.client.readyState).toBe(WebSocket.OPEN);
  });

  it("adopting a pull request GitHub already had still tells the Worker's index its number", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_pr_adopted", WITH_PULL_REQUEST);
    world.github.setRef("acme/widgets", "main", "sha-main");
    world.github.setRef("acme/widgets", TASK_BRANCH, HEAD);
    // Someone opened a pull request for this branch before OnCue did.
    const token = await world.github.fetchImpl(
      `${GITHUB_ORIGIN}/app/installations/${INSTALLATION_ID}/access_tokens`,
      {
        method: "POST",
        headers: { authorization: "Bearer jwt" },
        body: JSON.stringify({
          repository_ids: [REPOSITORY.repositoryId],
          permissions: { pull_requests: "write" },
        }),
      },
    );
    const minted = ((await token.json()) as { token: string }).token;
    await world.github.fetchImpl(`${GITHUB_ORIGIN}/repos/acme/widgets/pulls`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted}` },
      body: JSON.stringify({
        title: "By hand",
        head: TASK_BRANCH,
        base: "main",
        body: "Mine.",
      }),
    });

    const client = await openClient(world);
    await client.send(allowPullRequests("cmd_allow"));
    await waitFor(() => bridge.grants("push").length === 1, "the publish's grant");
    reportPublish(bridge);
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.updated")).length === 1,
      "the adoption",
    );
    await waitFor(async () => {
      const row = await env.DB.prepare(
        "SELECT pull_request_number FROM session_index WHERE session_id = ?",
      )
        .bind("sess_pr_adopted")
        .first<{ pull_request_number: number | null }>();
      return row?.pull_request_number === 1;
    }, "the index to name the adopted pull request");
    expect(world.github.pullRequests).toHaveLength(1);
    expect(world.github.pullRequests[0]?.body).toContain("Mine.");
  });

  describe("once GitHub says a person changed it", () => {
    const tell = async (stub: SessionWorld["stub"], body: Record<string, unknown>) =>
      (
        await stub.fetch("https://session/internal/pull-request-state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json();
    const change = (to: string, overrides: Record<string, unknown> = {}) => ({
      number: 1,
      to,
      actor: "octocat",
      mergedSha: null,
      changedAt: WORLD_TIME,
      ...overrides,
    });

    it("records the new state once, and tells the Worker's index which session owns the number", async () => {
      const { world } = await published("sess_pr_state");
      await waitFor(
        async () => (await eventsOfType(world.stub, "pull_request.created")).length === 1,
        "the pull request",
      );
      await waitFor(async () => {
        const row = await env.DB.prepare(
          "SELECT pull_request_number FROM session_index WHERE session_id = ?",
        )
          .bind("sess_pr_state")
          .first<{ pull_request_number: number | null }>();
        return row?.pull_request_number === 1;
      }, "the index to name the pull request");

      expect(await tell(world.stub, change("open"))).toEqual({ kind: "recorded" });
      // GitHub delivers at least once: the same word again changes nothing.
      expect(await tell(world.stub, change("open"))).toEqual({ kind: "unchanged" });
      expect(await tell(world.stub, change("merged", { number: 9 }))).toEqual({
        kind: "not_this_sessions",
      });

      const [changed] = await eventsOfType(world.stub, "pull_request.state_changed");
      expect(await eventsOfType(world.stub, "pull_request.state_changed")).toHaveLength(1);
      expect(changed).toMatchObject({
        runId: null,
        payload: { number: 1, from: "draft", to: "open", actor: "octocat", mergedSha: null },
      });
    });

    it("is ignored by a session with no pull request, and by an object with no session", async () => {
      const { world } = await quietRepositoryWorld("sess_pr_state_none", WITH_PULL_REQUEST);
      expect(await tell(world.stub, change("closed"))).toEqual({ kind: "not_this_sessions" });
      const legacy = await quietRepositoryWorld("sess_pr_state_legacy");
      expect(await tell(legacy.world.stub, change("closed"))).toEqual({
        kind: "not_this_sessions",
      });
      expect(await tell(stubFor("sess_pr_state_nobody"), change("closed"))).toEqual({
        kind: "no_session",
      });
    });

    it.each(["merged", "closed"])(
      "a %s pull request is never written to again, and no second one is opened",
      async (to) => {
        const { world, bridge, client } = await published(`sess_pr_finished_${to}`);
        await waitFor(
          async () => (await eventsOfType(world.stub, "pull_request.created")).length === 1,
          "the pull request",
        );
        const bodyBefore = world.github.pullRequests[0]?.body;
        expect(
          await tell(
            world.stub,
            change(to, { mergedSha: to === "merged" ? "e".repeat(40) : null }),
          ),
        ).toEqual({ kind: "recorded" });

        await client.send(runStartCommand("cmd_run_2", "msg_run_2", "One more thing."));
        await waitFor(() => bridge.commands("run.start").length === 2, "the next run");
        const runId = String(bridge.commands("run.start")[1]?.runId);
        await finishRun(world, bridge, runId);
        await waitFor(() => bridge.grants("push").length === 2, "the second publish's grant");
        const revocations = world.github.calls.filter((call) => call.tokenRevoked).length;
        bridge.send(
          bridge.event("repository.checkpointed", {
            runId,
            payload: {
              checkpointId: "ckpt_after_finish",
              kind: "branch_push",
              headSha: HEAD,
              bundle: null,
              reason: "user_requested",
            },
          }),
        );
        await waitFor(
          () => world.github.calls.filter((call) => call.tokenRevoked).length > revocations,
          "the push token's revocation",
        );
        await settle();

        expect(await eventsOfType(world.stub, "pull_request.updated")).toEqual([]);
        expect(world.github.pullRequests).toHaveLength(1);
        expect(world.github.pullRequests[0]?.body).toBe(bodyBefore);
      },
    );
  });
});

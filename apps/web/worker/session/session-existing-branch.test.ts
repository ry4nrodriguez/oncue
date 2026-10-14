// The branch a session works from (record 07): a session that starts from a
// chosen branch, and one that works directly on an existing branch, pushing
// there under a grant naming only that branch, after GitHub confirms before
// each grant that the branch is still one it may push to.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  attachmentStates,
  BASE_SHA,
  connectBridge,
  eventsOfType,
  eventTypes,
  finishRun,
  GITHUB_ORIGIN,
  INSTALLATION_ID,
  idleStopIssued,
  openClient,
  quietRepositoryWorld,
  REPOSITORY,
  recordCheck,
  registerSessionWorlds,
  reportCheckpoint,
  runStartCommand,
  type SessionWorld,
  setObjectEnv,
  settle,
  type TestBridge,
  WORLD_TIME,
  waitFor,
} from "../test/session-world";
import { CONFIRM_BUDGET_MS } from "./object/existing-branch";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const HEAD = "c".repeat(40);
const BRANCH = "feature/login";
const APP_ORIGIN = "https://oncue.example";

/** A session the user asked to work directly on `feature/login`. */
const EXISTING = {
  repository: {
    ...REPOSITORY,
    taskBranch: BRANCH,
    baseBranch: "main",
    appOrigin: APP_ORIGIN,
    existingBranch: true as const,
  },
};

/** A session the user asked to start from `release/1.4`, pushing to a new task branch. */
const STARTED_FROM_RELEASE = {
  repository: {
    ...REPOSITORY,
    taskBranch: null,
    baseBranch: "release/1.4",
    appOrigin: APP_ORIGIN,
  },
};

function allowPullRequests(commandId: string) {
  return {
    type: "policy.set",
    commandId,
    runId: null,
    issuedAt: WORLD_TIME,
    expected: { scope: "session", state: "active" },
    payload: {
      action: "set",
      policyVersion: 1,
      commit: "auto",
      push: "auto",
      pullRequest: "auto_after_verification",
    },
  };
}

function seedBranches(world: SessionWorld): void {
  world.github.setRef("acme/widgets", "main", "sha-main");
  world.github.setRef("acme/widgets", BRANCH, BASE_SHA);
  world.github.setRef("acme/widgets", "release/1.4", BASE_SHA);
}

async function existingWorld(sessionId: string) {
  const { world, bridge } = await quietRepositoryWorld(sessionId, EXISTING);
  seedBranches(world);
  return { world, bridge };
}

/** Allows pushing and pull requests, and waits for the publish's checkpoint command. */
async function allowAndAwaitCheckpoint(world: SessionWorld, bridge: TestBridge): Promise<void> {
  const client = await openClient(world);
  await client.send(allowPullRequests("cmd_allow"));
  await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish command");
}

function reportPushed(bridge: TestBridge, branch: string): void {
  const pushId = String((bridge.grants("push")[0] as { grantId: string }).grantId);
  bridge.send(
    bridge.event("git.push.completed", {
      runId: "run_1",
      payload: { pushId, branch, headSha: HEAD, remoteSha: HEAD },
    }),
  );
  bridge.send(
    bridge.event("repository.checkpointed", {
      runId: "run_1",
      payload: {
        checkpointId: "ckpt_publish",
        kind: "branch_push",
        headSha: HEAD,
        bundle: null,
        reason: "user_requested",
      },
    }),
  );
}

async function existingRow(world: SessionWorld) {
  return runInDurableObject(world.stub, (_instance, state) =>
    state.storage.sql
      .exec<{ pull_request_adopted: number }>("SELECT * FROM session_existing_branch")
      .toArray(),
  );
}

/** A pull request a person opened for `head` before the session, as GitHub would hold it. */
async function personOpens(world: SessionWorld, head: string, base: string): Promise<void> {
  const minted = await world.github.fetchImpl(
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
  const token = ((await minted.json()) as { token: string }).token;
  await world.github.fetchImpl(`${GITHUB_ORIGIN}/repos/acme/widgets/pulls`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "Login, by hand", head, base, body: "My notes." }),
  });
}

/** Fails GitHub calls whose path matches, for this test's object, and passes the rest on. */
function failingGitHub(matches: (path: string) => boolean): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(GITHUB_ORIGIN) && matches(new URL(url).pathname)) {
      return new Response("", { status: 500 });
    }
    return real(input as string, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

describe("a session working directly on an existing branch", () => {
  it("clones that branch as its own from the first generation, at the commit it was read at", async () => {
    const { world, bridge } = await existingWorld("sess_existing_clone");
    expect(bridge.grants("git")[0]).toMatchObject({
      branch: BRANCH,
      taskBranch: BRANCH,
      baseSha: BASE_SHA,
      headSha: BASE_SHA,
    });
    expect(await existingRow(world)).toEqual([{ id: 1, pull_request_adopted: 0 }]);
  });

  it("pushes to exactly that branch after GitHub confirms it, under a read token it revokes first", async () => {
    const { world, bridge } = await existingWorld("sess_existing_push");
    const callsBefore = world.github.calls.length;
    await allowAndAwaitCheckpoint(world, bridge);

    const [requested] = await eventsOfType(world.stub, "git.push.requested");
    expect((requested as { payload: { branch: string } }).payload.branch).toBe(BRANCH);
    expect(bridge.grants("push")).toHaveLength(1);
    expect((bridge.grants("push")[0] as { ref: string }).ref).toBe(`refs/heads/${BRANCH}`);

    // The confirmation: a read-only token, the branch, the repository, revoked,
    // all before the write token is minted for the grant.
    const calls = world.github.calls.slice(callsBefore);
    const confirm = calls.findIndex((call) => call.tokenNarrowing?.permissions.contents === "read");
    const write = calls.findIndex((call) => call.tokenNarrowing?.permissions.contents === "write");
    expect(confirm).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(confirm);
    const between = calls.slice(confirm, write).map((call) => call.path);
    expect(between).toEqual([
      `/app/installations/${INSTALLATION_ID}/access_tokens`,
      `/repos/acme/widgets/branches/${BRANCH}`,
      `/repos/acme/widgets/rules/branches/${BRANCH}`,
      "/repos/acme/widgets",
      "/installation/token",
    ]);
    // The object named nothing: the create route writes the chosen branch to the
    // index, and a push leaves the row as it found it.
    const row = await env.DB.prepare("SELECT task_branch FROM session_index WHERE session_id = ?")
      .bind("sess_existing_push")
      .first<{ task_branch: string | null }>();
    expect(row?.task_branch).toBeNull();
  });

  it.each([
    [
      "protected since creation",
      "protected",
      (world: SessionWorld) => world.github.setProtected("acme/widgets", BRANCH, true),
    ],
    [
      "deleted on GitHub",
      "deleted",
      (world: SessionWorld) => world.github.deleteRef("acme/widgets", BRANCH),
    ],
    [
      "made the default branch",
      "default",
      (world: SessionWorld) => world.github.setDefaultBranch("acme/widgets", BRANCH),
    ],
    [
      "unconfirmed because the token cannot be minted",
      "unminted",
      (world: SessionWorld) => world.github.setMode("token_mint_fails"),
    ],
  ])(
    "withholds the push grant for a branch %s, and checkpoints without one",
    async (_, id, change) => {
      const { world, bridge } = await existingWorld(`sess_existing_withheld_${id}`);
      change(world);
      const logged = vi.spyOn(console, "log");
      await allowAndAwaitCheckpoint(world, bridge);
      await settle();
      expect(bridge.grants("push")).toEqual([]);
      expect(
        world.github.calls.some((call) => call.tokenNarrowing?.permissions.contents === "write"),
      ).toBe(false);
      expect(
        logged.mock.calls.some((args) =>
          String(args[0]).includes('"operation":"session.existing_branch_push"'),
        ),
      ).toBe(true);
      logged.mockRestore();
    },
  );

  it.each([
    ["the branch", "branch", (path: string) => path.includes("/branches/")],
    ["the repository", "repository", (path: string) => path === "/repos/acme/widgets"],
    ["its rules", "rules", (path: string) => path.includes("/rules/branches/")],
  ])("withholds the grant when GitHub cannot say what %s is", async (_, id, matches) => {
    const { world, bridge } = await existingWorld(`sess_existing_unread_${id}`);
    const restore = failingGitHub(matches);
    try {
      await allowAndAwaitCheckpoint(world, bridge);
      await settle();
      expect(bridge.grants("push")).toEqual([]);
    } finally {
      restore();
    }
  });

  it("withholds the grant for a branch a ruleset guards, and tells the timeline why the publish was not pushed", async () => {
    const { world, bridge } = await existingWorld("sess_existing_ruleset");
    world.github.setRulesets("acme/widgets", [
      {
        id: 4,
        name: "Feature branches",
        target: "branch",
        enforcement: "active",
        include: ["refs/heads/feature/*"],
        exclude: [],
        rules: ["update"],
        source: "Organization",
      },
    ]);
    await allowAndAwaitCheckpoint(world, bridge);
    await waitFor(
      async () => (await eventsOfType(world.stub, "git.push.withheld")).length === 1,
      "the withheld push",
    );
    expect(bridge.grants("push")).toEqual([]);
    const [requested] = await eventsOfType(world.stub, "git.push.requested");
    const pushId = (requested as { payload: { pushId: string } }).payload.pushId;
    expect((await eventsOfType(world.stub, "git.push.withheld"))[0]).toMatchObject({
      runId: "run_1",
      payload: { pushId, branch: BRANCH, reason: "protected" },
    });
    const rows = await runInDurableObject(world.stub, (_instance, state) => ({
      publish: state.storage.sql
        .exec<{ state: string }>("SELECT state FROM publish WHERE push_id = ?", pushId)
        .one().state,
      grant: state.storage.sql
        .exec<{ state: string }>("SELECT state FROM bridge_dispatch WHERE intent_id = ?", pushId)
        .one().state,
    }));
    // Failed, so no pull request describes it; rejected, so it is never redelivered.
    expect(rows).toEqual({ publish: "failed", grant: "rejected" });
  });

  it("asks again when a grant left pending is redelivered to a reconnecting bridge", async () => {
    const { world, bridge } = await existingWorld("sess_existing_redelivered");
    // The confirmation passes, then the write token cannot be minted: the grant
    // stays pending for the next bridge connection.
    const real = globalThis.fetch;
    let refused = false;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!refused && url.includes("/access_tokens") && String(init?.body).includes('"write"')) {
        refused = true;
        return new Response("", { status: 500 });
      }
      return real(input as string, init);
    }) as typeof fetch;
    try {
      await allowAndAwaitCheckpoint(world, bridge);
      await waitFor(() => refused, "the refused write mint");
      await settle();
      expect(bridge.grants("push")).toEqual([]);
      world.github.setProtected("acme/widgets", BRANCH, true);
      bridge.close();
      const again = await connectBridge(world, 1);
      await again.hello();
      await waitFor(
        async () => (await eventsOfType(world.stub, "git.push.withheld")).length === 1,
        "the re-check on redelivery",
      );
      expect(again.grants("push")).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("answers within its time budget when GitHub hangs, and withholds the grant", async () => {
    const { world, bridge } = await existingWorld("sess_existing_slow");
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/access_tokens") && String(init?.body).includes('"read"')) {
        return new Promise<Response>(() => undefined);
      }
      return real(input as string, init);
    }) as typeof fetch;
    try {
      const startedAt = Date.now();
      const client = await openClient(world);
      await client.send(allowPullRequests("cmd_allow"));
      await waitFor(
        async () => (await eventsOfType(world.stub, "git.push.withheld")).length === 1,
        "the withheld push",
        CONFIRM_BUDGET_MS + 10_000,
      );
      expect(Date.now() - startedAt).toBeLessThan(CONFIRM_BUDGET_MS + 8_000);
      expect((await eventsOfType(world.stub, "git.push.withheld"))[0]).toMatchObject({
        payload: { reason: "unconfirmed" },
      });
      await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the checkpoint");
      expect(bridge.grants("push")).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("commits nothing for a grant cleared while GitHub was being asked", async () => {
    const { world } = await existingWorld("sess_existing_cleared");
    const real = globalThis.fetch;
    let asked = false;
    let cleared = false;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/access_tokens") && String(init?.body).includes('"read"')) {
        // Waits on timers rather than forever: the runtime ends a request
        // that can never settle at once.
        asked = true;
        while (!cleared) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return new Response("", { status: 500 });
      }
      return real(input as string, init);
    }) as typeof fetch;
    try {
      const client = await openClient(world);
      // Not awaited: the command is answered only once the grant is settled.
      const sent = client.send(allowPullRequests("cmd_allow"));
      await waitFor(() => asked, "the confirmation's read mint");
      // What a generation's end does to its open grants while the object waits.
      await runInDurableObject(world.stub, (_instance, state) => {
        state.storage.sql.exec(
          "DELETE FROM bridge_dispatch WHERE kind = 'git_grant' AND state IN ('pending', 'sent')",
        );
      });
      cleared = true;
      await sent;
      await settle();
      expect(await eventsOfType(world.stub, "git.push.withheld")).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("withholds the grant when the deployment has lost its GitHub App", async () => {
    const { world, bridge } = await existingWorld("sess_existing_unconfigured");
    await setObjectEnv(world, { ONCUE_GITHUB_APP_PRIVATE_KEY: "" });
    await allowAndAwaitCheckpoint(world, bridge);
    await settle();
    expect(bridge.grants("push")).toEqual([]);
  });

  it("asks again before the idle checkpoint's grant", async () => {
    const { world, bridge } = await existingWorld("sess_existing_idle");
    world.github.setProtected("acme/widgets", BRANCH, true);
    const { push } = await idleStopIssued(world, bridge);
    expect(push).toBeUndefined();
  });

  it("opens a draft against the default branch when the branch has no pull request", async () => {
    const { world, bridge } = await existingWorld("sess_existing_pr_new");
    await allowAndAwaitCheckpoint(world, bridge);
    world.github.setRef("acme/widgets", BRANCH, HEAD);
    reportPushed(bridge, BRANCH);
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.created")).length === 1,
      "the pull request",
    );
    expect(world.github.pullRequests[0]).toMatchObject({
      draft: true,
      base: "main",
      head: BRANCH,
    });
    expect(await existingRow(world)).toEqual([{ id: 1, pull_request_adopted: 0 }]);
  });

  it("adopts the branch's open pull request, keeping the person's title, description, and base", async () => {
    const { world, bridge } = await existingWorld("sess_existing_pr_adopt");
    world.github.setRef("acme/widgets", "develop", "sha-develop");
    await personOpens(world, BRANCH, "develop");
    // The agent describes the change; on a person's pull request that writes
    // nothing but the verification section.
    bridge.send(
      bridge.event("pull_request.described", {
        runId: "run_1",
        payload: { title: "Agent title", body: "Agent body.", branchName: null },
      }),
    );
    await allowAndAwaitCheckpoint(world, bridge);
    world.github.setRef("acme/widgets", BRANCH, HEAD);
    reportPushed(bridge, BRANCH);
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.updated")).length === 1,
      "the adoption",
    );
    expect(world.github.pullRequests).toHaveLength(1);
    const [adopted] = world.github.pullRequests;
    expect(adopted).toMatchObject({ title: "Login, by hand", base: "develop", head: BRANCH });
    expect(adopted?.body).toContain("My notes.");
    expect(adopted?.body).not.toContain("Agent body.");
    expect(adopted?.body).toContain("<!-- oncue:verification:start -->");
    expect(await existingRow(world)).toEqual([{ id: 1, pull_request_adopted: 1 }]);
    // GitHub's state for it, not OnCue's default: a person's pull request is
    // not a draft.
    const stored = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ number: number; state: string }>("SELECT number, state FROM pull_request")
        .one(),
    );
    expect(stored).toEqual({ number: 1, state: "open" });
    await waitFor(async () => {
      const row = await env.DB.prepare(
        "SELECT pull_request_number FROM session_index WHERE session_id = ?",
      )
        .bind("sess_existing_pr_adopt")
        .first<{ pull_request_number: number | null }>();
      return row?.pull_request_number === 1;
    }, "the index to name the adopted pull request");

    // The next run describes the change again and publishes: the person's
    // pull request still keeps its words, and only the section moves on.
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_run_2", "msg_run_2", "Now tidy the login form."));
    await waitFor(() => bridge.commands("run.start").length === 2, "the next run");
    const runId = String(bridge.commands("run.start")[1]?.runId);
    bridge.send(bridge.event("run.started", { runId }));
    bridge.send(
      bridge.event("pull_request.described", {
        runId,
        payload: { title: "Second agent title", body: "Second agent body.", branchName: null },
      }),
    );
    await recordCheck(world, bridge, { runId, checkId: "test" });
    await finishRun(world, bridge, runId);
    await waitFor(() => bridge.grants("push").length === 2, "the second publish's grant");
    const pushId = String((bridge.grants("push")[1] as { grantId: string }).grantId);
    const next = "d".repeat(40);
    world.github.setRef("acme/widgets", BRANCH, next);
    bridge.send(
      bridge.event("git.push.completed", {
        runId,
        payload: { pushId, branch: BRANCH, headSha: next, remoteSha: next },
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
      async () => (await eventsOfType(world.stub, "pull_request.updated")).length === 2,
      "the second update",
    );
    expect((await eventsOfType(world.stub, "pull_request.updated"))[1]).toMatchObject({
      payload: { number: 1, changed: ["verification_section"] },
    });
    expect(world.github.pullRequests[0]).toMatchObject({ title: "Login, by hand" });
    expect(world.github.pullRequests[0]?.body).toContain("My notes.");
    expect(world.github.pullRequests[0]?.body).not.toContain("Second agent body.");
    expect(world.github.pullRequests[0]?.body).toContain("Checked at `dddddddddddd`");
  });

  it("resumes on the branch at the commit it last knew, whatever moved on GitHub", async () => {
    const { world, bridge } = await existingWorld("sess_existing_resume");
    // Someone pushed on top of the branch while the session was idle; the bridge
    // lands on their tip because the branch is the session's own.
    world.github.setRef("acme/widgets", BRANCH, "sha-someone-else");
    await idleStopIssued(world, bridge);
    reportCheckpoint(bridge, { checkpointId: "ckpt_idle", headSha: BASE_SHA });
    await waitFor(
      async () => (await eventTypes(world.stub)).includes("sandbox.stopped"),
      "the stop",
    );
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_start_2", "msg_2", "Carry on"));
    await waitFor(
      async () =>
        (await attachmentStates(world.stub)).some(
          (row) => row.generation === 2 && row.state === "attached",
        ),
      "generation 2",
    );
    const again = await connectBridge(world, 2);
    await again.hello();
    await waitFor(() => again.grants("git").length >= 1, "the git grant");
    expect(again.grants("git")[0]).toMatchObject({
      branch: BRANCH,
      taskBranch: BRANCH,
      baseSha: BASE_SHA,
      headSha: BASE_SHA,
    });
  });
});

describe("a session started from a chosen branch", () => {
  it("clones that branch at its base commit, before and after a resume, and names a new task branch at the first push", async () => {
    const { world, bridge } = await quietRepositoryWorld(
      "sess_started_from_release",
      STARTED_FROM_RELEASE,
    );
    seedBranches(world);
    expect(bridge.grants("git")[0]).toMatchObject({
      branch: "release/1.4",
      taskBranch: null,
      headSha: BASE_SHA,
    });
    // The base moved on while the session idled: the next generation still asks
    // for the commit it started from, and the bridge checks it out there.
    world.github.setRef("acme/widgets", "release/1.4", "sha-release-newer");
    await idleStopIssued(world, bridge);
    reportCheckpoint(bridge, { checkpointId: "ckpt_idle", headSha: BASE_SHA });
    await waitFor(
      async () => (await eventTypes(world.stub)).includes("sandbox.stopped"),
      "the stop",
    );
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_start_2", "msg_2", "Carry on"));
    await waitFor(
      async () =>
        (await attachmentStates(world.stub)).some(
          (row) => row.generation === 2 && row.state === "attached",
        ),
      "generation 2",
    );
    const again = await connectBridge(world, 2);
    await again.hello();
    await waitFor(() => again.grants("git").length >= 1, "the git grant");
    const grant = again.grants("git")[0] as Record<string, unknown>;
    expect(grant).toMatchObject({ branch: "release/1.4", baseSha: BASE_SHA, headSha: BASE_SHA });
    expect(String(grant.taskBranch)).toMatch(/^oncue\//);
    expect(await existingRow(world)).toEqual([]);
  });

  it("opens its draft pull request against the branch it started from", async () => {
    const { world, bridge } = await quietRepositoryWorld(
      "sess_started_from_release_pr",
      STARTED_FROM_RELEASE,
    );
    seedBranches(world);
    await allowAndAwaitCheckpoint(world, bridge);
    const [requested] = await eventsOfType(world.stub, "git.push.requested");
    const branch = String((requested as { payload: { branch: string } }).payload.branch);
    expect(branch).toMatch(/^oncue\//);
    world.github.setRef("acme/widgets", branch, HEAD);
    reportPushed(bridge, branch);
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.created")).length === 1,
      "the pull request",
    );
    const [created] = await eventsOfType(world.stub, "pull_request.created");
    expect(created).toMatchObject({ payload: { baseBranch: "release/1.4", headBranch: branch } });
    expect(world.github.pullRequests[0]).toMatchObject({ base: "release/1.4", head: branch });
    // No confirmation read: only a branch the user chose to push to is asked about.
    expect(world.github.calls.filter((call) => call.path === "/repos/acme/widgets")).toEqual([]);
  });
});

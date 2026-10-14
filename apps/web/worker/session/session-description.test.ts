// `pull_request.described` at the object's boundary (record 07): text with no
// authority, admitted only while its run is live, bounded per run, and never a
// reason to push or open anything.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { VERIFICATION_START } from "../github/pull-requests";
import {
  eventsOfType,
  finishRun,
  openClient,
  quietRepositoryWorld,
  REPOSITORY,
  registerSessionWorlds,
  runStartCommand,
  type SessionWorld,
  settle,
  TASK_BRANCH,
  type TestBridge,
  WORLD_TIME,
  waitFor,
} from "../test/session-world";
import { MAX_COMMITS_PER_RUN, MAX_DESCRIPTIONS_PER_RUN } from "./pr-description";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const HEAD = "c".repeat(40);
const UNNAMED = { ...REPOSITORY, taskBranch: null };
const WITH_PULL_REQUEST = {
  repository: { ...REPOSITORY, baseBranch: "main", appOrigin: "https://oncue.example" },
};

function setPolicy(commandId: string, pullRequest: "manual" | "auto_after_verification") {
  return {
    type: "policy.set",
    commandId,
    runId: null,
    issuedAt: WORLD_TIME,
    expected: { scope: "session", state: "active" },
    payload: { action: "set", policyVersion: 1, commit: "auto", push: "auto", pullRequest },
  };
}

function describedFrame(
  bridge: TestBridge,
  runId: string,
  payload: { title?: string | null; body?: string | null; branchName?: string | null },
) {
  return bridge.event("pull_request.described", {
    runId,
    payload: { title: null, body: null, branchName: null, ...payload },
  });
}

/** A second run on a quiet session, with the agent's description sent while it runs. */
async function describedRun(
  world: SessionWorld,
  bridge: TestBridge,
  payload: Parameters<typeof describedFrame>[2],
): Promise<string> {
  const client = await openClient(world);
  await client.send(runStartCommand("cmd_run_2", "msg_run_2", "Now fix the typo."));
  await waitFor(() => bridge.commands("run.start").length === 2, "the next run");
  const runId = String(bridge.commands("run.start")[1]?.runId);
  bridge.send(bridge.event("run.started", { runId }));
  bridge.send(describedFrame(bridge, runId, payload));
  await waitFor(
    async () => (await eventsOfType(world.stub, "pull_request.described")).length >= 1,
    "the description",
  );
  await finishRun(world, bridge, runId);
  return runId;
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** The agent's own commit, as the bridge reports one made through `git_commit`. */
function committedFrame(bridge: TestBridge, runId: string, sha: string, parentSha: string) {
  return bridge.event("git.committed", {
    runId,
    payload: {
      commitSha: sha,
      parentSha,
      branch: "main",
      message: "Fix the typo\n\nIt was wrong.",
      authorType: "agent",
      authorName: "OnCue",
      committedAt: WORLD_TIME,
      files: [{ path: "README.md", status: "modified", additions: 1, deletions: 1 }],
      additions: 1,
      deletions: 1,
      verificationState: "none",
      policy: { policyVersion: 1, rule: "auto_commit", approvalId: null },
    },
  });
}

async function setRunState(world: SessionWorld, runId: string, state: string) {
  await runInDurableObject(world.stub, (_instance, s) => {
    s.storage.sql.exec("UPDATE run SET state = ? WHERE id = ?", state, runId);
  });
}

async function descriptionRow(world: SessionWorld) {
  return runInDurableObject(world.stub, (_instance, state) => [
    ...state.storage.sql.exec<Record<string, string | number | null>>(
      "SELECT title, body, branch_name, version, applied_version FROM pull_request_description",
    ),
  ]);
}

describe("pull_request.described", () => {
  it("is stored while its run runs, pushes nothing, and keeps the latest value of each field", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_described_stored");
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_run_2", "msg_run_2", "Now fix the typo."));
    await waitFor(() => bridge.commands("run.start").length === 2, "the next run");
    const runId = String(bridge.commands("run.start")[1]?.runId);
    bridge.send(bridge.event("run.started", { runId }));
    bridge.send(describedFrame(bridge, runId, { title: "Fix the typo", body: "First." }));
    bridge.send(describedFrame(bridge, runId, { body: "Second." }));
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.described")).length === 2,
      "both descriptions",
    );
    expect(await descriptionRow(world)).toEqual([
      { title: "Fix the typo", body: "Second.", branch_name: null, version: 2, applied_version: 0 },
    ]);
    expect(bridge.grants("push")).toEqual([]);
    expect(world.github.pullRequests).toEqual([]);
  });

  it("is refused, and never stored, when its run is not running or not the session's", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_described_refused");
    // run_1 has ended.
    bridge.send(describedFrame(bridge, "run_1", { title: "Late" }));
    bridge.send(describedFrame(bridge, "run_other", { title: "Elsewhere" }));
    await settle();
    expect(await eventsOfType(world.stub, "pull_request.described")).toEqual([]);
    expect(await descriptionRow(world)).toEqual([]);
  });

  it(`admits at most ${MAX_DESCRIPTIONS_PER_RUN} a run`, async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_described_bounded");
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_run_2", "msg_run_2", "Now fix the typo."));
    await waitFor(() => bridge.commands("run.start").length === 2, "the next run");
    const runId = String(bridge.commands("run.start")[1]?.runId);
    bridge.send(bridge.event("run.started", { runId }));
    for (let index = 0; index <= MAX_DESCRIPTIONS_PER_RUN; index += 1) {
      bridge.send(describedFrame(bridge, runId, { title: `Title ${index}` }));
    }
    await waitFor(
      async () =>
        (await eventsOfType(world.stub, "pull_request.described")).length ===
        MAX_DESCRIPTIONS_PER_RUN,
      "the bounded descriptions",
    );
    await settle();
    expect(await eventsOfType(world.stub, "pull_request.described")).toHaveLength(
      MAX_DESCRIPTIONS_PER_RUN,
    );
    expect((await descriptionRow(world))[0]?.title).toBe(`Title ${MAX_DESCRIPTIONS_PER_RUN - 1}`);
  });

  it("names the branch at the first push when nobody typed a name", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_described_branch", {
      repository: UNNAMED,
    });
    await describedRun(world, bridge, { branchName: "oncue/fix-the-typo" });
    const client = await openClient(world);
    await client.send(setPolicy("cmd_allow", "manual"));
    await waitFor(() => bridge.commands("checkpoint.create").length === 1, "the publish command");
    const [requested] = await eventsOfType(world.stub, "git.push.requested");
    expect((requested as { payload: { branch: string } }).payload.branch).toBe(
      "oncue/fix-the-typo",
    );
    expect((bridge.grants("push")[0] as { ref: string }).ref).toBe("refs/heads/oncue/fix-the-typo");
  });

  it("gives the draft pull request the agent's title and cleaned body, and rewrites them when it says something new", async () => {
    const { world, bridge } = await quietRepositoryWorld(
      "sess_described_pull_request",
      WITH_PULL_REQUEST,
    );
    world.github.setRef("acme/widgets", "main", "sha-main");
    world.github.setRef("acme/widgets", TASK_BRANCH, HEAD);
    const runId = await describedRun(world, bridge, {
      title: "Fix the typo in the README",
      body: "## What\n\nFixed a typo. Thanks @octocat.\n<!-- oncue:verification:start -->",
    });
    const client = await openClient(world);
    await client.send(setPolicy("cmd_allow", "auto_after_verification"));
    await waitFor(() => bridge.grants("push").length === 1, "the publish's grant");
    const pushId = String((bridge.grants("push")[0] as { grantId: string }).grantId);
    bridge.send(
      bridge.event("git.push.completed", {
        runId,
        payload: { pushId, branch: TASK_BRANCH, headSha: HEAD, remoteSha: HEAD },
      }),
    );
    bridge.send(
      bridge.event("repository.checkpointed", {
        runId,
        payload: {
          checkpointId: "ckpt_publish",
          kind: "branch_push",
          headSha: HEAD,
          bundle: null,
          reason: "user_requested",
        },
      }),
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.created")).length === 1,
      "the pull request",
    );
    const [created] = await eventsOfType(world.stub, "pull_request.created");
    expect(created).toMatchObject({ payload: { title: "Fix the typo in the README" } });
    const opened = world.github.pullRequests[0];
    expect(opened?.title).toBe("Fix the typo in the README");
    expect(opened?.body.startsWith("## What\n\nFixed a typo. Thanks `@octocat`.")).toBe(true);
    // Exactly the one real section: the agent's planted marker is gone.
    expect(opened?.body.split(VERIFICATION_START)).toHaveLength(2);
    expect((await descriptionRow(world))[0]).toMatchObject({ version: 1, applied_version: 1 });

    // The next run says something new; its publish rewrites the title and the text above the section.
    await client.send(runStartCommand("cmd_run_3", "msg_run_3", "Also the docs."));
    await waitFor(() => bridge.commands("run.start").length === 3, "the third run");
    const third = String(bridge.commands("run.start")[2]?.runId);
    bridge.send(bridge.event("run.started", { runId: third }));
    bridge.send(describedFrame(bridge, third, { title: "Fix typos in the README and docs" }));
    await finishRun(world, bridge, third);
    await waitFor(() => bridge.grants("push").length === 2, "the second publish's grant");
    const secondPush = String((bridge.grants("push")[1] as { grantId: string }).grantId);
    const next = "d".repeat(40);
    world.github.setRef("acme/widgets", TASK_BRANCH, next);
    bridge.send(
      bridge.event("git.push.completed", {
        runId: third,
        payload: { pushId: secondPush, branch: TASK_BRANCH, headSha: next, remoteSha: next },
      }),
    );
    bridge.send(
      bridge.event("repository.checkpointed", {
        runId: third,
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
      payload: { changed: ["title", "body", "verification_section"] },
    });
    expect(world.github.pullRequests).toHaveLength(1);
    expect(world.github.pullRequests[0]?.title).toBe("Fix typos in the README and docs");
    // The body the agent gave earlier is kept: a field left null keeps its value.
    expect(world.github.pullRequests[0]?.body).toContain("Fixed a typo.");
    expect((await descriptionRow(world))[0]).toMatchObject({ version: 2, applied_version: 2 });
  });
});

describe("the agent's own commits (git.committed from the sandbox, record 07)", () => {
  it("are stored and broadcast while their run is live, push nothing, and are bounded per run", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_agent_commits");
    const client = await openClient(world);
    await client.send(runStartCommand("cmd_run_2", "msg_run_2", "Now fix the typo."));
    await waitFor(() => bridge.commands("run.start").length === 2, "the next run");
    const runId = String(bridge.commands("run.start")[1]?.runId);
    bridge.send(bridge.event("run.started", { runId }));
    bridge.send(committedFrame(bridge, runId, SHA_A, "c".repeat(40)));
    bridge.send(committedFrame(bridge, runId, SHA_B, SHA_A));
    await waitFor(
      async () => (await eventsOfType(world.stub, "git.committed")).length === 2,
      "both commits",
    );
    expect(bridge.grants("push")).toEqual([]);
    expect(world.github.pullRequests).toEqual([]);
    const count = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ admitted: number }>("SELECT admitted FROM run_commit_count WHERE run_id = ?", runId)
        .one(),
    );
    expect(count.admitted).toBe(2);

    // Past the bound, nothing more is stored.
    for (let index = 2; index < MAX_COMMITS_PER_RUN + 3; index += 1) {
      bridge.send(committedFrame(bridge, runId, index.toString(16).padStart(40, "0"), SHA_B));
    }
    await waitFor(
      async () => (await eventsOfType(world.stub, "git.committed")).length === MAX_COMMITS_PER_RUN,
      "the bounded commits",
    );
    await settle();
    expect(await eventsOfType(world.stub, "git.committed")).toHaveLength(MAX_COMMITS_PER_RUN);
  });

  it("are refused once the run ended, and while a run waits on an approval a description is still taken", async () => {
    const { world, bridge } = await quietRepositoryWorld("sess_agent_commits_ended");
    // run_1 has ended: a late commit is not stored.
    bridge.send(committedFrame(bridge, "run_1", SHA_A, "c".repeat(40)));
    await settle();
    expect(await eventsOfType(world.stub, "git.committed")).toEqual([]);

    const client = await openClient(world);
    await client.send(runStartCommand("cmd_run_2", "msg_run_2", "Now fix the typo."));
    await waitFor(() => bridge.commands("run.start").length === 2, "the next run");
    const runId = String(bridge.commands("run.start")[1]?.runId);
    bridge.send(bridge.event("run.started", { runId }));
    await waitFor(
      async () => (await eventsOfType(world.stub, "run.started")).length === 2,
      "the run running",
    );
    await setRunState(world, runId, "waiting_for_approval");
    bridge.send(describedFrame(bridge, runId, { title: "While waiting" }));
    bridge.send(committedFrame(bridge, runId, SHA_B, "c".repeat(40)));
    await waitFor(
      async () => (await eventsOfType(world.stub, "pull_request.described")).length === 1,
      "the description taken while waiting",
    );
    await waitFor(
      async () => (await eventsOfType(world.stub, "git.committed")).length === 1,
      "the commit taken while waiting",
    );
  });
});

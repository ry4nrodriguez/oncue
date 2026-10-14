// What a bridge frame costs in rows read. Durable Objects are billed by rows
// read and the Workers Free plan stops an account at 5 million a day, so a
// frame's reads must not grow with the event log (record 01). A long log sits
// behind a live generation here.

import { env, runInDurableObject } from "cloudflare:test";
import { makeEvent, testSessionPolicy } from "@oncue/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import {
  allowSubagentStart,
  completeVerification,
  eventCount,
  eventsOfType,
  finishRun,
  fireAlarm,
  openClient,
  quietRepositoryWorld,
  REPOSITORY,
  REPOSITORY_ID,
  readyBridge,
  recordCheck,
  registerSessionWorlds,
  runRowOf,
  runStartCommand,
  sessionOnRealDriver,
  settle,
  stubFor,
  WORLD_TIME,
  waitFor,
} from "../test/session-world";
import { PROVISION_CHECK_MS } from "./lifecycle";
import {
  LATE_STOP_MAX_ATTEMPTS,
  LATE_STOPS_PER_ALARM,
  MAX_PREPARE_POLLS,
  PROVISION_PACING,
} from "./object/constants";
import { REPLAY_READS } from "./resume-replay";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

const LOG_ROWS = 5_000;
/**
 * The costliest frame here (a backed `run.verified`) reads about 40 rows, so
 * 45 leaves headroom while still failing any read that grows with the log: a
 * scan costs 5,000 rows.
 */
const READ_BUDGET_PER_FRAME = 45;

/**
 * An alarm wake reads each of its owners' facts once, by key: about 50 rows
 * when the lifecycle has a check to make. 100 leaves room and still fails a
 * scan of the log.
 */
const READ_BUDGET_PER_WAKE = 100;

/** Commits `LOG_ROWS` durable rows to the generation, as a long run would have left them. */
async function seedLongLog(sessionId: string, generation: number): Promise<void> {
  await runInDurableObject(stubFor(sessionId), (_instance, state) => {
    const last = state.storage.sql
      .exec<{ m: number }>("SELECT COALESCE(MAX(session_sequence), 0) AS m FROM event")
      .one().m;
    const at = new Date().toISOString();
    for (let i = 1; i <= LOG_ROWS; i += 1) {
      state.storage.sql.exec(
        `INSERT INTO event (session_sequence, event_id, event_type, run_id, sandbox_generation, runtime_sequence, occurred_at, committed_at, envelope_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        last + i,
        `evt_seeded_${i}`,
        "tool.completed",
        null,
        generation,
        null,
        at,
        at,
        "{}",
      );
    }
  });
}

interface ReadCost {
  readonly total: number;
  /** The heaviest queries, so a failure names the one that scans. */
  readonly heaviest: ReadonlyArray<readonly [string, number]>;
  /** How many times each query ran, for a read that must happen once and not per frame. */
  readonly runs: ReadonlyMap<string, number>;
  /** Rows each query read in all. */
  readonly rows: ReadonlyMap<string, number>;
}

/**
 * Sums `rowsRead` over every query run while `act` does. The test's own reads
 * count too, so `act` waits only on the run row, one lookup by id.
 */
async function rowsReadWhile(sessionId: string, act: () => Promise<void>): Promise<ReadCost> {
  const cursors: Array<{ readonly query: string; readonly cursor: { readonly rowsRead: number } }> =
    [];
  let restore = (): void => undefined;
  await runInDurableObject(stubFor(sessionId), (_instance, state) => {
    const sql = state.storage.sql;
    const exec = sql.exec;
    sql.exec = ((...args: Parameters<typeof exec>) => {
      const cursor = exec.apply(sql, args);
      cursors.push({ query: args[0].replace(/\s+/g, " ").slice(0, 160), cursor });
      return cursor;
    }) as typeof exec;
    restore = () => {
      sql.exec = exec;
    };
  });
  try {
    await act();
  } finally {
    await runInDurableObject(stubFor(sessionId), () => restore());
  }
  const byQuery = new Map<string, number>();
  const runs = new Map<string, number>();
  for (const { query, cursor } of cursors) {
    byQuery.set(query, (byQuery.get(query) ?? 0) + cursor.rowsRead);
    runs.set(query, (runs.get(query) ?? 0) + 1);
  }
  return {
    runs,
    rows: byQuery,
    total: cursors.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
    heaviest: [...byQuery.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

describe("rows read per bridge frame", () => {
  it("does not grow with the event log", async () => {
    const world = await sessionOnRealDriver("ses_read_cost");
    const bridge = await readyBridge(world);
    await seedLongLog(world.sessionId, 1);
    const before = await eventCount(world.stub);

    const deltas = 20;
    const messages = 10;
    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      for (let i = 0; i < deltas; i += 1) {
        bridge.send(bridge.event("message.delta", { runId: "run_1" }));
      }
      for (let i = 0; i < messages; i += 1) {
        bridge.send(
          bridge.event("message.completed", {
            runId: "run_1",
            payload: {
              messageId: `msg_read_cost_${i}`,
              role: "assistant",
              parts: [{ type: "text", text: `Step ${i} done.` }],
            },
          }),
        );
      }
      // Frames arrive in order on one socket, so the run's terminal state
      // means every frame before it has been handled.
      bridge.send(bridge.event("run.completed_with_warnings", { runId: "run_1" }));
      await waitFor(
        async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
        "the run to end",
      );
      await settle();
    });

    expect(await eventCount(world.stub)).toBeGreaterThanOrEqual(before + messages + 2);
    const frames = 1 + deltas + messages + 1;
    const heaviest = JSON.stringify(cost.heaviest);
    expect(cost.total).toBeGreaterThan(0);
    expect(cost.total / frames, heaviest).toBeLessThan(READ_BUDGET_PER_FRAME);
  });

  /**
   * The completion gate (record 14) reads only the run's check rows, its
   * summary, and each evidence artifact by id, so log length does not matter.
   */
  it("judging a forged run.verified does not read the event log", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_forged");
    const bridge = await readyBridge(world);
    await seedLongLog(world.sessionId, 1);

    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      bridge.send(bridge.event("run.verified", { runId: "run_1" }));
      await waitFor(
        async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
        "the downgraded outcome",
      );
      await settle();
    });

    expect(await eventsOfType(world.stub, "run.verified")).toEqual([]);
    const frames = 2;
    const figures = `forged run.verified: ${cost.total} rows over ${frames} frames, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total / frames, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
  });

  it("judging a backed run.verified reads its records and not the event log", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_backed");
    const bridge = await readyBridge(world);
    await seedLongLog(world.sessionId, 1);

    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      await recordCheck(world, bridge, { checkId: "chk_test" });
      completeVerification(bridge);
      bridge.send(bridge.event("run.verified", { runId: "run_1" }));
      await waitFor(
        async () => (await runRowOf(world.stub, "run_1")).state === "verified",
        "the verified outcome",
      );
      await settle();
    });

    expect(await eventsOfType(world.stub, "run.verified")).toHaveLength(1);
    // run.started, verification.started, artifact.uploading, verification.result,
    // verification.completed, run.verified; the artifact's completion through
    // the object's upload path is counted with them.
    const frames = 6;
    const figures = `backed run.verified: ${cost.total} rows over ${frames} frames, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total / frames, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
  });

  /**
   * The proposal gate reads four rows by key per `policy.proposed`. A refused
   * frame writes nothing but still pays its reads, so all outcomes are measured.
   */
  it("judging policy.proposed frames does not read the event log", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_policy");
    const bridge = await readyBridge(world);
    await seedLongLog(world.sessionId, 1);
    const propose = (proposalId: string, push: "auto" | "never", triggeringMessageId: string) =>
      bridge.event("policy.proposed", {
        payload: {
          proposalId,
          triggeringMessageId,
          from: testSessionPolicy(),
          to: testSessionPolicy({ push }),
          direction: "narrowing",
          rationale: "The user asked.",
        },
      });

    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      bridge.send(propose("prop_cost_forged", "auto", "msg_forged"));
      bridge.send(propose("prop_cost_held", "auto", "msg_1"));
      bridge.send(propose("prop_cost_applied", "never", "msg_1"));
      await waitFor(
        async () => (await eventsOfType(world.stub, "policy.updated")).length === 1,
        "the narrowing to apply",
      );
      await settle();
    });

    expect(await eventsOfType(world.stub, "policy.proposed")).toHaveLength(2);
    const frames = 4;
    const figures = `policy.proposed: ${cost.total} rows over ${frames} frames, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total / frames, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
  });

  /**
   * A subagent's start reads the run row, its own row, and the approval that
   * allowed its call by key, and the run's subagents on its sandbox by index
   * (at most the run's bound); its end
   * and each of its tagged messages and calls read its row by key, and the run
   * row too when that row does not support the frame. Refused frames are
   * measured too.
   */
  it("judging subagent frames does not read the event log", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_agents");
    const bridge = await readyBridge(world);
    await seedLongLog(world.sessionId, 1);
    const agents = ["ses_cost_a", "ses_cost_b", "ses_cost_c", "ses_cost_d"];
    for (const agentId of agents) {
      await allowSubagentStart(world, "run_1", `call_${agentId}`);
    }

    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      for (const agentId of agents) {
        bridge.send(
          bridge.event("agent.started", {
            runId: "run_1",
            payload: { agentId, parentToolCallId: `call_${agentId}` },
          }),
        );
        bridge.send(
          bridge.event("tool.requested", {
            runId: "run_1",
            payload: { toolCallId: `call_in_${agentId}`, agentId },
          }),
        );
        bridge.send(
          bridge.event("message.completed", {
            runId: "run_1",
            payload: {
              messageId: `msg_${agentId}`,
              role: "assistant",
              parts: [{ type: "text", text: "Found it." }],
              agentId,
            },
          }),
        );
        bridge.send(bridge.event("agent.completed", { runId: "run_1", payload: { agentId } }));
      }
      // Refused: a second start of a known subagent, an end for one never
      // started, and a call under an agentId nothing announced.
      bridge.send(
        bridge.event("agent.started", {
          runId: "run_1",
          payload: { agentId: "ses_cost_a", parentToolCallId: "call_again" },
        }),
      );
      bridge.send(
        bridge.event("agent.completed", { runId: "run_1", payload: { agentId: "ses_cost_x" } }),
      );
      bridge.send(
        bridge.event("tool.requested", {
          runId: "run_1",
          payload: { toolCallId: "call_in_ses_cost_x", agentId: "ses_cost_x" },
        }),
      );
      bridge.send(bridge.event("run.completed_with_warnings", { runId: "run_1" }));
      await waitFor(
        async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
        "the run to end",
      );
      await settle();
    });

    expect(await eventsOfType(world.stub, "agent.completed")).toHaveLength(agents.length);
    expect(await eventsOfType(world.stub, "tool.requested")).toHaveLength(agents.length);
    const frames = 1 + agents.length * 4 + 3 + 1;
    const figures = `subagents: ${cost.total} rows over ${frames} frames, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total / frames, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
    for (const [query, rows] of cost.heaviest) {
      expect(rows, query).toBeLessThan(LOG_ROWS);
    }
  });

  /**
   * A publish's report (commit, push, checkpoint) is matched to the `publish`
   * row by key. A forged report a sandbox could send is measured too.
   */
  it("a publish's report does not read the event log", async () => {
    const { world, bridge } = await quietRepositoryWorld("ses_read_cost_publish");
    const client = await openClient(world);
    await client.send({
      type: "policy.set",
      commandId: "cmd_allow",
      runId: null,
      issuedAt: WORLD_TIME,
      expected: { scope: "session", state: "active" },
      payload: {
        action: "set",
        policyVersion: 1,
        commit: "auto",
        push: "auto",
        pullRequest: "manual",
      },
    });
    await waitFor(() => bridge.grants("push").length === 1, "the publish's grant");
    const pushId = String((bridge.grants("push")[0] as { grantId: string }).grantId);
    await seedLongLog(world.sessionId, 1);

    const head = "c".repeat(40);
    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("git.push.completed", { runId: "run_1" }));
      bridge.send(bridge.event("git.committed", { runId: "run_1" }));
      bridge.send(
        bridge.event("git.push.completed", {
          runId: "run_1",
          payload: { pushId, branch: "oncue/task", headSha: head, remoteSha: head },
        }),
      );
      bridge.send(
        bridge.event("repository.checkpointed", {
          runId: "run_1",
          payload: {
            checkpointId: "ckpt_cost",
            kind: "branch_push",
            headSha: head,
            bundle: null,
            reason: "user_requested",
          },
        }),
      );
      await waitFor(
        () => world.github.calls.filter((call) => call.tokenRevoked).length >= 2,
        "the push token's revocation",
      );
      await settle();
    });

    expect(await eventsOfType(world.stub, "git.push.completed")).toHaveLength(1);
    const frames = 4;
    const figures = `publish report: ${cost.total} rows over ${frames} frames, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total / frames, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
  });

  /**
   * `sandbox.checkpoint_failed` settles a publish and signals the stop, both
   * keyed. A sandbox can send it unprompted and repeatedly, so repeats are measured.
   */
  it("a failed checkpoint's report does not read the event log", async () => {
    const { world, bridge } = await quietRepositoryWorld("ses_read_cost_ckpt_failed");
    await seedLongLog(world.sessionId, 1);

    const failed = (checkpointId: string) =>
      bridge.event("sandbox.checkpoint_failed", {
        payload: { checkpointId, reason: "user", failure: "add_failed", durationMs: 120 },
      });
    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(failed("ckpt_cost_1"));
      bridge.send(failed("ckpt_cost_2"));
      bridge.send(failed("ckpt_cost_3"));
      bridge.send(failed("ckpt_cost_4"));
      await settle();
    });

    // Counted outside the measurement: the harness's own read of the log by
    // type is a full scan, and it is not the object's cost.
    expect(await eventsOfType(world.stub, "sandbox.checkpoint_failed")).toHaveLength(4);
    const frames = 4;
    const figures = `checkpoint failed: ${cost.total} rows over ${frames} frames, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total / frames, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
    console.log(figures);
  });

  /** A workspace with one saved name for the world's repository, and that name pinned as optional. */
  async function approvalWorld(sessionId: string) {
    const world = await sessionOnRealDriver(sessionId, { repository: REPOSITORY });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO github_installation (
           installation_row_id, workspace_id, github_installation_id, github_user_id,
           account_login, account_type, status, user_token_reference, refresh_token_reference,
           user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
         ) VALUES ('ins_cost', 'ws_1', 4001, 42, 'acme', 'Organization', 'active', 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(WORLD_TIME, WORLD_TIME, WORLD_TIME, WORLD_TIME, WORLD_TIME),
      env.DB.prepare(
        `INSERT INTO repository_connection (
           repository_connection_id, workspace_id, installation_row_id, github_repository_id,
           full_name, default_branch, status, created_at, updated_at
         ) VALUES ('rpc_cost', 'ws_1', 'ins_cost', ?, 'acme/widgets', 'main', 'verified', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(REPOSITORY_ID, WORLD_TIME, WORLD_TIME),
      env.DB.prepare(
        `INSERT INTO development_secret (
           secret_id, workspace_id, repository_connection_id, name, value_reference, status, created_at, updated_at
         ) VALUES ('dsc_cost', 'ws_1', 'rpc_cost', 'STRIPE_TEST_KEY', 'oncue1.1.n.v', 'active', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(WORLD_TIME, WORLD_TIME),
      // The placeholder envelope opens under no key, and D1 outlives the test,
      // so the row's state is stated here.
      env.DB.prepare(
        "UPDATE development_secret SET status = 'active' WHERE secret_id = 'dsc_cost'",
      ),
    ]);
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO session_secret (name, kind, selected, supplied_generation) VALUES ('STRIPE_TEST_KEY', 'optional', 0, NULL)",
      );
    });
    const bridge = await readyBridge(world);
    const request = (ref: string, resource: string) =>
      bridge.event("approval.requested", {
        runId: "run_1",
        payload: {
          approvalId: ref,
          title: "x",
          intendedAction: "x",
          category: "development_secret",
          risk: "low",
          resource,
          requestedScope: "x",
          expiresAt: "2099-01-01T00:00:00.000Z",
          toolCallId: null,
        },
      });
    return { world, bridge, request };
  }

  /**
   * `approval.requested` is judged by key and the partial open-approval index.
   * Measured: a refused frame, an admitted one, and an honest repeat.
   */
  it("judging approval.requested frames does not read the event log", async () => {
    const { world, bridge, request } = await approvalWorld("ses_read_cost_approval");
    await seedLongLog(world.sessionId, 1);

    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      bridge.send(request("ref_cost_refused", "DEPLOY_KEY"));
      bridge.send(request("ref_cost_admitted", "STRIPE_TEST_KEY"));
      bridge.send(request("ref_cost_repeat", "STRIPE_TEST_KEY"));
      await waitFor(() => bridge.frames("bridge.approval").length === 3, "three answers");
      await settle();
    });

    expect(await eventsOfType(world.stub, "approval.requested")).toHaveLength(1);
    const frames = 4;
    const figures = `approval.requested: ${cost.total} rows over ${frames} frames, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total / frames, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
  });

  /**
   * A harness permission ask comes once per tool call that asks, so its
   * judgement reads by key and the partial open-approval index. Measured: a
   * saved choice answering at once, a card opening, and an honest repeat while
   * it is open.
   */
  it("judging permission asks does not read the event log", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_permission", {
      body: { approvalMode: "session" },
    });
    const bridge = await readyBridge(world);
    await seedLongLog(world.sessionId, 1);
    const ask = (ref: string, category: string) =>
      bridge.event("approval.requested", {
        runId: "run_1",
        payload: {
          approvalId: ref,
          title: "x",
          intendedAction: "x",
          category: category as "outside_project",
          risk: "low",
          resource: "/etc/hosts",
          requestedScope: "x",
          expiresAt: "2099-01-01T00:00:00.000Z",
          toolCallId: null,
        },
      });

    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      bridge.send(ask("ref_auto", "outside_project"));
      await waitFor(() => bridge.frames("bridge.approval").length === 1, "the automatic answer");
      bridge.send(ask("ref_card", "secret_file"));
      bridge.send(ask("ref_repeat", "secret_file"));
      await waitFor(() => bridge.frames("bridge.approval").length === 3, "three answers");
      await settle();
    });

    expect(bridge.frames("bridge.approval").map((frame) => frame.outcome)).toEqual([
      "allowed",
      "pending",
      "refused",
    ]);
    const frames = 4;
    const figures = `permission asks: ${cost.total} rows over ${frames} frames, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total / frames, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
    console.log(figures);
  });

  /** The redactor is rebuilt from names once per wake after an eviction, never per frame. */
  it("rebuilding the redactor after a wake reads once, not per frame", async () => {
    const { world, bridge } = await approvalWorld("ses_read_cost_redactor");
    await seedLongLog(world.sessionId, 1);
    await runInDurableObject(world.stub, (instance, state) => {
      state.storage.sql.exec(
        "UPDATE session_secret SET supplied_generation = 1 WHERE name = 'STRIPE_TEST_KEY'",
      );
      // What an eviction does to the two things kept only in memory.
      const held = instance as unknown as {
        pendingRedactionSecrets: readonly string[];
        redactorGeneration: number | null;
      };
      held.pendingRedactionSecrets = [];
      held.redactorGeneration = null;
    });

    const frames = 30;
    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      for (let i = 0; i < frames - 2; i += 1) {
        bridge.send(bridge.event("message.delta", { runId: "run_1" }));
      }
      bridge.send(bridge.event("run.completed_with_warnings", { runId: "run_1" }));
      await waitFor(
        async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
        "the run to end",
      );
      await settle();
    });

    const rebuilds = [...cost.runs.entries()].filter(([query]) =>
      query.startsWith("SELECT secret_id FROM secret_sent WHERE generation"),
    );
    const figures = `redactor rebuild: ${JSON.stringify(rebuilds)}; ${cost.total} rows over ${frames} frames, ${JSON.stringify(cost.heaviest)}`;
    expect(
      rebuilds.map(([, count]) => count),
      figures,
    ).toEqual([1]);
    expect(cost.total / frames, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
  });

  /**
   * While a run waits for a person the alarm can fire many times; each sweep
   * uses the partial index and the stored deadline, never the log.
   */
  it("an alarm with an approval open, and the decision, do not read the event log", async () => {
    const { world, bridge, request } = await approvalWorld("ses_read_cost_waiting");
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    bridge.send(request("ref_cost_waiting", "STRIPE_TEST_KEY"));
    await waitFor(
      async () => (await eventsOfType(world.stub, "approval.requested")).length === 1,
      "the open approval",
    );
    await seedLongLog(world.sessionId, 1);
    const [stored] = await eventsOfType(world.stub, "approval.requested");
    const approvalId = (stored?.payload as { approvalId: string } | undefined)?.approvalId;
    const client = await openClient(world);

    const alarms = 5;
    const cost = await rowsReadWhile(world.sessionId, async () => {
      for (let index = 0; index < alarms; index += 1) {
        await fireAlarm(world.stub);
      }
      await client.send({
        type: "approval.resolve",
        commandId: "cmd_cost_resolve",
        runId: "run_1",
        issuedAt: WORLD_TIME,
        expected: { scope: "run", state: "waiting_for_approval" },
        payload: {
          approvalId,
          decision: "rejected",
        },
      });
      await settle();
    });

    expect(await eventsOfType(world.stub, "approval.resolved")).toHaveLength(1);
    expect(await eventsOfType(world.stub, "approval.expired")).toEqual([]);
    const steps = alarms + 1;
    const figures = `waiting: ${cost.total} rows over ${steps} steps (${alarms} alarms and one decision), ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total / steps, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
  });

  /**
   * `question.asked` is judged by key and the partial open-question index, and
   * a question that waits is read the same way on each alarm and commit.
   * Measured: a refused frame, an admitted one, an honest repeat, alarms while
   * it waits, and the answer.
   */
  it("judging question.asked frames, waiting, and the answer do not read the event log", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_question");
    const bridge = await readyBridge(world);
    await seedLongLog(world.sessionId, 1);
    const ask = (ref: string, runId = "run_1") =>
      bridge.event("question.asked", { runId, payload: { questionId: ref } });
    const client = await openClient(world);

    const alarms = 5;
    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      bridge.send(ask("ref_cost_refused", "run_other"));
      bridge.send(ask("ref_cost_admitted"));
      bridge.send(ask("ref_cost_repeat"));
      await waitFor(() => bridge.frames("bridge.question").length === 2, "two refusals");
      await settle();
      for (let index = 0; index < alarms; index += 1) {
        await fireAlarm(world.stub);
      }
      const [stored] = await eventsOfType(world.stub, "question.asked");
      await client.send({
        type: "question.resolve",
        commandId: "cmd_cost_question",
        runId: "run_1",
        issuedAt: WORLD_TIME,
        expected: { scope: "run", state: "running" },
        payload: {
          action: "answer",
          questionId: (stored?.payload as { questionId: string } | undefined)?.questionId,
          answers: [["Postgres"]],
        },
      });
      await settle();
    });

    expect(await eventsOfType(world.stub, "question.answered")).toHaveLength(1);
    const steps = 4 + alarms + 1;
    const figures = `question: ${cost.total} rows over ${steps} steps, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total / steps, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
  });

  const PAUSE_READ = "SELECT run_id, envelope_json FROM event WHERE event_type = 'run.paused'";
  const pauseFor = (
    bridge: Awaited<ReturnType<typeof readyBridge>>,
    category: "authentication_failed" | "usage_limit_reached",
  ) =>
    bridge.event("run.paused", {
      runId: "run_1",
      payload: {
        reason: "model_failure",
        detail: `Model request failed: ${category}`,
        modelFailure: { category, message: "The provider refused the request.", retries: 0 },
        checkpointId: null,
      },
    });

  /**
   * While a run is paused, every rearm and alarm asks why, so that a rejected
   * key stops its sandbox at once. The answer is the newest pause of the
   * generation, one row from the end of an index, however long the log grew
   * before the pause or after it. A run that is not paused never asks.
   */
  it("a paused run's rearms and alarms read its pause in one row, and a working run's read none", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_paused");
    const bridge = await readyBridge(world);

    const working = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      await waitFor(
        async () => (await runRowOf(world.stub, "run_1")).state === "running",
        "the run to start",
      );
      await fireAlarm(world.stub);
      await settle();
    });
    expect([...working.runs.keys()].filter((query) => query.startsWith(PAUSE_READ))).toEqual([]);

    // Paused on a failure that leaves the sandbox up, so the reads go on.
    bridge.send(pauseFor(bridge, "usage_limit_reached"));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "paused",
      "the pause",
    );
    // The long log lands after the pause, where a read that walked the
    // generation looking for it would have to cross every row.
    await seedLongLog(world.sessionId, 1);

    const messages = 10;
    const alarms = 5;
    const cost = await rowsReadWhile(world.sessionId, async () => {
      for (let i = 0; i < messages; i += 1) {
        bridge.send(
          bridge.event("message.completed", {
            runId: "run_1",
            payload: {
              messageId: `msg_paused_cost_${i}`,
              role: "assistant",
              parts: [{ type: "text", text: `Late line ${i}.` }],
            },
          }),
        );
      }
      await settle();
      for (let index = 0; index < alarms; index += 1) {
        await fireAlarm(world.stub);
      }
      await settle();
    });

    expect(await eventsOfType(world.stub, "sandbox.idle")).toEqual([]);
    const pauseReads = [...cost.runs.entries()].filter(([query]) => query.startsWith(PAUSE_READ));
    const steps = messages + alarms;
    const figures = `paused: ${cost.total} rows over ${steps} steps, pause reads ${JSON.stringify(pauseReads)}, ${JSON.stringify(cost.heaviest)}`;
    expect(pauseReads, figures).toHaveLength(1);
    const [query, runs] = pauseReads[0] as [string, number];
    expect(runs, figures).toBeGreaterThanOrEqual(steps);
    expect(cost.rows.get(query), figures).toBe(runs);
    expect(cost.total / steps, figures).toBeLessThan(READ_BUDGET_PER_FRAME);
  });

  /**
   * A rejected key's pause makes the stop due at once: the frame's rearm sets
   * the alarm, and the alarm begins the stop and issues the checkpoint with
   * its push grant. That is one frame and one wake with several commits, about
   * 300 rows, every read keyed; 500 leaves room and still fails a scan of the log.
   */
  it("a rejected key's pause and the stop it starts do not read the event log", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_rejected_key", {
      repository: REPOSITORY,
    });
    const bridge = await readyBridge(world);
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    await waitFor(
      async () => (await runRowOf(world.stub, "run_1")).state === "running",
      "the run to start",
    );
    await seedLongLog(world.sessionId, 1);

    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(pauseFor(bridge, "authentication_failed"));
      await waitFor(
        () => bridge.commands("checkpoint.create").length >= 1,
        "the checkpoint command",
      );
      await settle();
    });

    expect(await eventsOfType(world.stub, "sandbox.idle")).toHaveLength(1);
    const figures = `rejected key: ${cost.total} rows, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total, figures).toBeLessThan(500);
    for (const [query, rows] of cost.heaviest) {
      expect(rows, query).toBeLessThan(READ_BUDGET_PER_WAKE);
    }
  });

  /** The resume replay runs once per resume with a bound per event type, so a long log costs only the bounds. */
  it("composing the resume replay reads each event type's bound, not the log", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_replay");
    await readyBridge(world);
    await seedLongLog(world.sessionId, 1);

    const cost = await rowsReadWhile(world.sessionId, async () => {
      await runInDurableObject(world.stub, (instance) => {
        const object = instance as unknown as {
          readSession(): unknown;
          composeContext(session: unknown, reason: string, start: unknown): string;
        };
        const text = object.composeContext(
          object.readSession(),
          "resume",
          runStartCommand("cmd_replay_cost", "msg_replay_cost", "Carry on"),
        );
        expect(text).toContain("[OnCue session context]");
      });
    });

    // The log holds 5,000 tool.completed rows and little else; the replay
    // reads that type's bound of them, and one row for each other read.
    const toolBound = REPLAY_READS.find((read) => read.type === "tool.completed")?.limit ?? 0;
    const figures = `replay: ${cost.total} rows, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total, figures).toBeLessThan(toolBound + 50);
  });

  /**
   * A run's subagents can write many times the rows its primary agent does.
   * The replay reads the primary agent's rows through their own index, so a
   * subagent's rows neither push an earlier turn's past the bound nor cost a
   * read.
   */
  it("composing the resume replay does not read a subagent's rows", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_replay_agents");
    const bridge = await readyBridge(world);
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    bridge.send(
      bridge.event("tool.requested", {
        runId: "run_1",
        payload: { toolCallId: "call_primary", title: "Read src/retry.ts" },
      }),
    );
    bridge.send(
      bridge.event("tool.completed", { runId: "run_1", payload: { toolCallId: "call_primary" } }),
    );
    await finishRun(world, bridge);
    const messageBound = REPLAY_READS.find((read) => read.type === "message.completed")?.limit ?? 0;
    const toolBound = REPLAY_READS.find((read) => read.type === "tool.requested")?.limit ?? 0;
    const perType = Math.max(messageBound, toolBound) + 100;
    await runInDurableObject(world.stub, (_instance, state) => {
      const sql = state.storage.sql;
      let sequence = sql
        .exec<{ m: number }>("SELECT MAX(session_sequence) AS m FROM event")
        .one().m;
      const seed = (event: { readonly type: string; readonly eventId: string }) => {
        sequence += 1;
        sql.exec(
          `INSERT INTO event (session_sequence, event_id, event_type, run_id, sandbox_generation, runtime_sequence, occurred_at, committed_at, envelope_json)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          sequence,
          event.eventId,
          event.type,
          "run_1",
          1,
          null,
          WORLD_TIME,
          WORLD_TIME,
          JSON.stringify(event),
        );
      };
      for (let i = 0; i < perType; i += 1) {
        seed(
          makeEvent("tool.requested", {
            eventId: `evt_agent_call_${i}`,
            runId: "run_1",
            payload: { toolCallId: `call_agent_${i}`, title: "grep", agentId: "ses_many" },
          }),
        );
        seed(
          makeEvent("tool.completed", {
            eventId: `evt_agent_done_${i}`,
            runId: "run_1",
            payload: { toolCallId: `call_agent_${i}`, agentId: "ses_many" },
          }),
        );
        seed(
          makeEvent("message.completed", {
            eventId: `evt_agent_message_${i}`,
            runId: "run_1",
            payload: {
              messageId: `msg_agent_${i}`,
              role: "assistant",
              parts: [{ type: "text", text: "A subagent's own words." }],
              agentId: "ses_many",
            },
          }),
        );
      }
    });

    let text = "";
    const cost = await rowsReadWhile(world.sessionId, async () => {
      await runInDurableObject(world.stub, (instance) => {
        const object = instance as unknown as {
          readSession(): unknown;
          composeContext(session: unknown, reason: string, start: unknown): string;
        };
        text = object.composeContext(
          object.readSession(),
          "resume",
          runStartCommand("cmd_replay_agents", "msg_replay_agents", "Carry on"),
        );
      });
    });

    expect(text).toContain("I changed the assertion and the test passes.");
    expect(text).toContain("Read src/retry.ts");
    expect(text).not.toContain("A subagent's own words.");
    const figures = `replay beside subagents: ${cost.total} rows, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total, figures).toBeLessThan(100);
  });

  /**
   * The index over the primary agent's rows reads each stored envelope as
   * JSON, and SQLite refuses JSON nested past its depth limit. A tool input is
   * the sandbox's and bounded by size, not depth, so such a frame must still
   * be stored.
   */
  it("stores a frame nested deeper than SQLite reads JSON", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_deep_json");
    const bridge = await readyBridge(world);
    bridge.send(bridge.event("run.started", { runId: "run_1" }));
    let nested: unknown = "bottom";
    for (let depth = 0; depth < 1_500; depth += 1) {
      nested = [nested];
    }
    bridge.send(
      bridge.event("tool.requested", {
        runId: "run_1",
        payload: { toolCallId: "call_deep", input: { nested } },
      }),
    );
    await finishRun(world, bridge);
    const stored = await eventsOfType(world.stub, "tool.requested");
    expect(stored.map((event) => (event.payload as { toolCallId: string }).toolCallId)).toEqual([
      "call_deep",
    ]);
  });
});

describe("rows read while a provisioning waits for its image", () => {
  /**
   * A cold build is polled for minutes. Each poll asks only whether the
   * generation ended, one lookup by key, and `MAX_PREPARE_POLLS` bounds the
   * count however slow the build.
   */
  it("reads one row per poll, not the log", async () => {
    const sessionId = "ses_read_cost_prepare";
    await seedLongLog(sessionId, 1);
    const polls = 12;
    let asked = 0;
    const cost = await rowsReadWhile(sessionId, async () => {
      await sessionOnRealDriver(sessionId, {
        controller: (operation) => {
          if (operation !== "prepareImage") {
            return undefined;
          }
          asked += 1;
          return asked <= polls
            ? Response.json({ kind: "ok", value: { state: "building" } })
            : undefined;
        },
      });
      await settle();
    });

    const poll = [...cost.runs.entries()].find(([query]) =>
      query.includes("FROM sandbox_attachment WHERE generation = ? AND state IN"),
    );
    // One check before the provider is first asked (a stop or a delete during
    // the run's dispatch), one per `building` poll, then one after the `ready`
    // answer and after each later provider answer (create, start, getConnection).
    expect(poll?.[1]).toBe(polls + 5);
    expect(asked).toBe(polls + 1);
    // The world's own wait for the attachment lists every event type; it is
    // the test's read, not the object's.
    const objectReads = cost.heaviest.filter(
      ([query]) => !query.startsWith("SELECT event_type FROM event ORDER BY"),
    );
    for (const [query, rows] of objectReads) {
      expect(rows, query).toBeLessThan(LOG_ROWS);
    }
  });

  it("is bounded in polls whatever the clock allows", () => {
    expect(MAX_PREPARE_POLLS * PROVISION_PACING.minPreparePollMs).toBeLessThanOrEqual(
      PROVISION_PACING.prepareBudgetMs,
    );
  });
});

describe("rows read per rearm for owed late stops", () => {
  /**
   * Every rearm asks for the earliest owed late stop. It walks
   * `idx_late_stop_due` and stops at the first row, so it reads at most one
   * row however many generations owe one.
   */
  it("reads at most one row per rearm", async () => {
    const world = await sessionOnRealDriver("ses_read_cost_late_stop");
    const bridge = await readyBridge(world);
    await runInDurableObject(stubFor(world.sessionId), (_instance, state) => {
      for (let generation = 100; generation < 150; generation += 1) {
        state.storage.sql.exec(
          "INSERT INTO late_stop (generation, provider, due_at_ms, attempts) VALUES (?, 'modal', ?, 0)",
          generation,
          Date.now() + 3_600_000 + generation,
        );
      }
    });
    const cost = await rowsReadWhile(world.sessionId, async () => {
      bridge.send(bridge.event("run.started", { runId: "run_1" }));
      for (let i = 0; i < 5; i += 1) {
        bridge.send(bridge.event("message.delta", { runId: "run_1" }));
      }
      bridge.send(bridge.event("run.completed_with_warnings", { runId: "run_1" }));
      await waitFor(
        async () => (await runRowOf(world.stub, "run_1")).state === "completed_with_warnings",
        "the run to end",
      );
      await settle();
    });

    const query = [...cost.runs.keys()].find((key) => key.includes("FROM late_stop ORDER BY"));
    expect(query).toBeDefined();
    const runs = cost.runs.get(query as string) as number;
    expect(cost.rows.get(query as string) as number).toBeLessThanOrEqual(runs);
  });
});

describe("rows read when the alarm checks a provisioning nothing drives", () => {
  /**
   * A generation left `provisioning` by a restart, with a long log behind it,
   * a check interval old. While the provider cannot answer, the alarm comes
   * back every interval for up to twenty minutes, so one wake must cost a few
   * lookups by key and never the log.
   */
  async function lostProvisioning(
    sessionId: string,
    status: () => Response,
  ): Promise<{ readonly asked: () => number }> {
    let asked = 0;
    const world = await sessionOnRealDriver(sessionId, {
      awaitAttachment: false,
      controller: (operation) => {
        if (operation === "prepareImage") {
          return new Promise<Response>(() => undefined);
        }
        if (operation === "getStatus") {
          asked += 1;
          return status();
        }
        return undefined;
      },
    });
    await waitFor(() => world.controllerCalls.length >= 1, "the first poll");
    await seedLongLog(sessionId, 1);
    await runInDurableObject(world.stub, (instance, state) => {
      instance.provisioningInFlight = null;
      state.storage.sql.exec(
        "UPDATE sandbox_attachment SET started_at = ? WHERE generation = 1",
        new Date(Date.now() - 2 * PROVISION_CHECK_MS).toISOString(),
      );
    });
    return { asked: () => asked };
  }

  it("does not read the log on a wake that must ask again later", async () => {
    const sessionId = "ses_read_cost_recover_wait";
    const lost = await lostProvisioning(sessionId, () =>
      Response.json(
        { kind: "error", category: "unknown", message: "busy", retryable: true },
        { status: 500 },
      ),
    );
    const wakes = 5;

    const cost = await rowsReadWhile(sessionId, async () => {
      for (let wake = 0; wake < wakes; wake += 1) {
        await fireAlarm(stubFor(sessionId));
      }
    });

    expect(lost.asked()).toBe(wakes);
    const perWake = cost.total / wakes;
    const figures = `${perWake.toFixed(1)} rows per wake, ${JSON.stringify(cost.heaviest)}`;
    expect(perWake, figures).toBeLessThan(READ_BUDGET_PER_WAKE);
  });

  it("does not read the log on the wake that adopts the sandbox", async () => {
    const sessionId = "ses_read_cost_recover_adopt";
    await lostProvisioning(sessionId, () => Response.json({ kind: "ok", value: "active" }));

    const cost = await rowsReadWhile(sessionId, async () => {
      await fireAlarm(stubFor(sessionId));
      await settle();
    });

    expect(await eventsOfType(stubFor(sessionId), "sandbox.attached")).toHaveLength(1);
    // The wake also commits `sandbox.attached` and the controller's note,
    // and starts the output relay.
    const figures = `adoption: ${cost.total} rows, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total, figures).toBeLessThan(2 * READ_BUDGET_PER_WAKE);
  });
});

describe("rows read when the alarm runs owed late stops", () => {
  /**
   * Many generations can owe a late stop at once. One wake reads only the
   * `LATE_STOPS_PER_ALARM` it will run, through `idx_late_stop_due`, and each
   * stop's outcome (paid, owed again, or given up and named on the output)
   * costs no read of the log.
   */
  async function owing(sessionId: string, attempts: number, stop: () => Response | undefined) {
    const world = await sessionOnRealDriver(sessionId, {
      controller: (operation) => (operation === "stop" ? stop() : undefined),
    });
    await readyBridge(world);
    await seedLongLog(sessionId, 1);
    await runInDurableObject(world.stub, (_instance, state) => {
      for (let generation = 100; generation < 150; generation += 1) {
        state.storage.sql.exec(
          "INSERT INTO late_stop (generation, provider, due_at_ms, attempts) VALUES (?, 'modal', ?, ?)",
          generation,
          Date.now() - 1_000 + generation,
          attempts,
        );
      }
    });
    return world;
  }

  function dueQuery(cost: ReadCost): string {
    return [...cost.runs.keys()].find((key) => key.includes("FROM late_stop WHERE")) as string;
  }

  const refused = () =>
    Response.json(
      { kind: "error", category: "unknown", message: "busy", retryable: true },
      { status: 500 },
    );

  it("reads only the stops it runs when they succeed", async () => {
    const world = await owing("ses_read_cost_late_run", 0, () => undefined);

    const cost = await rowsReadWhile(world.sessionId, () => fireAlarm(world.stub));

    const stops = world.controllerCalls.filter((call) => call.operation === "stop");
    expect(stops).toHaveLength(LATE_STOPS_PER_ALARM);
    expect(cost.runs.get(dueQuery(cost))).toBe(1);
    expect(cost.rows.get(dueQuery(cost))).toBe(LATE_STOPS_PER_ALARM);
    const figures = `late stops: ${cost.total} rows, ${JSON.stringify(cost.heaviest)}`;
    expect(cost.total, figures).toBeLessThan(READ_BUDGET_PER_WAKE);
  });

  it("reads no more when they are refused, or given up and named on the output", async () => {
    const retried = await owing("ses_read_cost_late_retry", 0, refused);
    const again = await rowsReadWhile(retried.sessionId, () => fireAlarm(retried.stub));
    expect(again.rows.get(dueQuery(again))).toBe(LATE_STOPS_PER_ALARM);
    expect(again.total, JSON.stringify(again.heaviest)).toBeLessThan(READ_BUDGET_PER_WAKE);

    const last = await owing("ses_read_cost_late_given_up", LATE_STOP_MAX_ATTEMPTS - 1, refused);
    const givenUp = await rowsReadWhile(last.sessionId, () => fireAlarm(last.stub));
    expect(givenUp.rows.get(dueQuery(givenUp))).toBe(LATE_STOPS_PER_ALARM);
    // Each given-up stop commits one output event, which is a write.
    expect(givenUp.total, JSON.stringify(givenUp.heaviest)).toBeLessThan(4 * READ_BUDGET_PER_FRAME);
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAllowlistCache } from "../auth/allowlist";
import { deriveUserId, deriveWorkspaceId } from "../auth/register";
import { createClerkDouble } from "../test/clerk-double";
import { handleListSessions } from "./sessions-list";

const url = "https://worker/api/sessions";

function envWith(overrides: { CLERK_JWT_KEY?: string; ONCUE_USER_ALLOWLIST?: string }): Env {
  return { ...env, ...overrides } as unknown as Env;
}

async function insertSession(row: {
  sessionId: string;
  workspaceId: string;
  state: string;
  title: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  waitingForUser?: boolean;
  currentRunId?: string | null;
  currentRunState?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, title, last_activity_at, created_at, updated_at, waiting_for_user, current_run_id, current_run_state)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.sessionId,
      row.workspaceId,
      row.state,
      row.title,
      row.lastActivityAt,
      row.createdAt,
      row.createdAt,
      row.waitingForUser === true ? 1 : 0,
      row.currentRunId ?? null,
      row.currentRunState ?? null,
    )
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM session_index").run();
});

describe("handleListSessions", () => {
  it("denies an unauthenticated request", async () => {
    const response = await handleListSessions(new Request(url), env, createAllowlistCache());
    expect(response.status).toBe(401);
  });

  it("denies a verified subject that is not on the allowlist", async () => {
    const double = await createClerkDouble();
    const request = await double.requestAs("user_blocked", url);

    const response = await handleListSessions(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: "someone_else" }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(403);
  });

  it("lists only the caller's own active and archived sessions, newest activity first", async () => {
    const subject = "user_lists_sessions";
    const workspaceId = await deriveWorkspaceId(subject);
    const otherWorkspaceId = await deriveWorkspaceId("someone_else_entirely");

    await insertSession({
      sessionId: "sess_active_recent",
      workspaceId,
      state: "active",
      title: "Recent active",
      lastActivityAt: "2026-09-03T12:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    await insertSession({
      sessionId: "sess_archived_older",
      workspaceId,
      state: "archived",
      title: "Older archived",
      lastActivityAt: "2026-09-02T00:00:00.000Z",
      createdAt: "2026-08-30T00:00:00.000Z",
    });
    await insertSession({
      sessionId: "sess_no_activity_yet",
      workspaceId,
      state: "active",
      title: null,
      lastActivityAt: null,
      createdAt: "2026-09-02T12:00:00.000Z",
    });
    await insertSession({
      sessionId: "sess_creating",
      workspaceId,
      state: "creating",
      title: null,
      lastActivityAt: null,
      createdAt: "2026-09-03T13:00:00.000Z",
    });
    await insertSession({
      sessionId: "sess_deletion_pending",
      workspaceId,
      state: "deletion_pending",
      title: "Being deleted",
      lastActivityAt: "2026-09-03T14:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    await insertSession({
      sessionId: "sess_other_workspace",
      workspaceId: otherWorkspaceId,
      state: "active",
      title: "Not mine",
      lastActivityAt: "2026-09-03T15:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    const double = await createClerkDouble();
    const request = await double.requestAs(subject, url);

    const response = await handleListSessions(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: Array<{ sessionId: string; state: string; title: string | null }>;
    };
    expect(body.sessions.map((session) => session.sessionId)).toEqual([
      "sess_active_recent",
      "sess_no_activity_yet",
      "sess_archived_older",
    ]);
    expect(body.sessions[0]).toEqual({
      sessionId: "sess_active_recent",
      title: "Recent active",
      state: "active",
      lastActivityAt: "2026-09-03T12:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      repositoryFullName: null,
      taskBranch: null,
      baseBranch: null,
      branchMode: "new_branch",
      waitingForUser: false,
      // Migration 0016's default: earlier sessions ran OpenCode.
      runtime: "opencode",
      currentRunId: null,
      currentRunState: null,
    });
  });

  // A LEFT JOIN, because a session with no repository must still list; this
  // proves both arms in one read.
  it("names the repository a session works against, and null for one without", async () => {
    const subject = "user_sessions_repo";
    const double = await createClerkDouble();
    const userId = await deriveUserId(subject);
    const workspaceId = await deriveWorkspaceId(subject);
    const now = "2026-09-01T00:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) ON CONFLICT DO NOTHING",
      ).bind(userId, now, now),
      env.DB.prepare(
        "INSERT INTO workspace (id, owner_user_id, kind, created_at, updated_at) VALUES (?, ?, 'private', ?, ?) ON CONFLICT DO NOTHING",
      ).bind(workspaceId, userId, now, now),
    ]);
    await env.DB.prepare(
      `INSERT INTO github_installation (
         installation_row_id, workspace_id, github_installation_id, github_user_id,
         account_login, account_type, status, user_token_reference, refresh_token_reference,
         user_token_expires_at, refresh_token_expires_at, last_verified_at, created_at, updated_at
       ) VALUES ('ghi_list', ?, 4001, 42, 'acme', 'Organization', 'active',
                 'oncue1.1.n.c', 'oncue1.1.n.r', ?, ?, ?, ?, ?)`,
    )
      .bind(workspaceId, now, now, now, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO repository_connection (
         repository_connection_id, workspace_id, installation_row_id, github_repository_id,
         full_name, default_branch, status, created_at, updated_at
       ) VALUES ('rc_list', ?, 'ghi_list', 501, 'acme/widgets', 'main', 'verified', ?, ?)`,
    )
      .bind(workspaceId, now, now)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, state, title, repository_connection_id, task_branch, created_at, updated_at)
         VALUES ('sess_with_repo', ?, 'active', 'With a repo', 'rc_list', 'oncue/fix-it-7f3a', ?, ?)`,
      ).bind(workspaceId, now, now),
      env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, state, title, created_at, updated_at)
         VALUES ('sess_without_repo', ?, 'active', 'No repo', ?, ?)`,
      ).bind(workspaceId, now, now),
      env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, state, title, repository_connection_id, task_branch, base_branch, branch_mode, created_at, updated_at)
         VALUES ('sess_on_existing', ?, 'active', 'On a branch', 'rc_list', 'feature/login', 'feature/login', 'existing_branch', ?, ?)`,
      ).bind(workspaceId, now, now),
      env.DB.prepare(
        `INSERT INTO session_index (session_id, workspace_id, state, title, repository_connection_id, base_branch, branch_mode, created_at, updated_at)
         VALUES ('sess_from_release', ?, 'active', 'From a release', 'rc_list', 'release/1.4', 'new_branch', ?, ?)`,
      ).bind(workspaceId, now, now),
    ]);

    const response = await handleListSessions(
      await double.requestAs(subject, url),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );

    const body = (await response.json()) as {
      sessions: {
        sessionId: string;
        repositoryFullName: string | null;
        taskBranch: string | null;
        baseBranch: string | null;
        branchMode: string;
      }[];
    };
    const byId = new Map(
      body.sessions.map((session) => [
        session.sessionId,
        [session.repositoryFullName, session.taskBranch, session.baseBranch, session.branchMode],
      ]),
    );
    // A row from before migration 0018 reads as the default branch and a new task branch.
    expect(byId.get("sess_with_repo")).toEqual([
      "acme/widgets",
      "oncue/fix-it-7f3a",
      null,
      "new_branch",
    ]);
    expect(byId.get("sess_without_repo")).toEqual([null, null, null, "new_branch"]);
    expect(byId.get("sess_on_existing")).toEqual([
      "acme/widgets",
      "feature/login",
      "feature/login",
      "existing_branch",
    ]);
    expect(byId.get("sess_from_release")).toEqual([
      "acme/widgets",
      null,
      "release/1.4",
      "new_branch",
    ]);
  });

  it("says which sessions are waiting on the user, from the projected column alone", async () => {
    const subject = "user_needs_you";
    const workspaceId = await deriveWorkspaceId(subject);
    await insertSession({
      sessionId: "sess_waiting",
      workspaceId,
      state: "active",
      title: "Waiting",
      lastActivityAt: "2026-09-03T12:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      waitingForUser: true,
    });
    await insertSession({
      sessionId: "sess_busy",
      workspaceId,
      state: "active",
      title: "Busy",
      lastActivityAt: "2026-09-03T11:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const double = await createClerkDouble();
    const response = await handleListSessions(
      await double.requestAs(subject, url),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: { sessionId: string; waitingForUser: boolean }[];
    };
    expect(body.sessions.map((row) => [row.sessionId, row.waitingForUser])).toEqual([
      ["sess_waiting", true],
      ["sess_busy", false],
    ]);
  });

  it("says which run is current and its state, and drops a state it does not know (migration 0015)", async () => {
    const subject = "user_status_dots";
    const workspaceId = await deriveWorkspaceId(subject);
    await insertSession({
      sessionId: "sess_running",
      workspaceId,
      state: "active",
      title: "Running",
      lastActivityAt: "2026-09-03T12:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      currentRunId: "run_a",
      currentRunState: "running",
    });
    await insertSession({
      sessionId: "sess_done",
      workspaceId,
      state: "active",
      title: "Done",
      lastActivityAt: "2026-09-03T11:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      currentRunId: "run_b",
      currentRunState: "verified",
    });
    await insertSession({
      sessionId: "sess_future_state",
      workspaceId,
      state: "active",
      title: "From a newer object",
      lastActivityAt: "2026-09-03T10:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      currentRunId: "run_c",
      currentRunState: "some_state_added_later",
    });
    await insertSession({
      sessionId: "sess_not_projected",
      workspaceId,
      state: "active",
      title: "Not projected since the migration",
      lastActivityAt: "2026-09-03T09:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const double = await createClerkDouble();
    const response = await handleListSessions(
      await double.requestAs(subject, url),
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: {
        sessionId: string;
        currentRunId: string | null;
        currentRunState: string | null;
      }[];
    };
    expect(
      body.sessions.map((row) => [row.sessionId, row.currentRunId, row.currentRunState]),
    ).toEqual([
      ["sess_running", "run_a", "running"],
      ["sess_done", "run_b", "verified"],
      ["sess_future_state", "run_c", null],
      ["sess_not_projected", null, null],
    ]);
  });

  it("returns an empty list for a workspace with no sessions", async () => {
    const subject = "user_no_sessions";
    const double = await createClerkDouble();
    const request = await double.requestAs(subject, url);

    const response = await handleListSessions(
      request,
      envWith({ CLERK_JWT_KEY: double.jwtKey, ONCUE_USER_ALLOWLIST: subject }),
      createAllowlistCache(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });
});

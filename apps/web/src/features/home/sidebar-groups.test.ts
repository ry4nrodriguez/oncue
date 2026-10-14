import { describe, expect, it } from "vitest";
import type { SessionListRow } from "@/lib/api/sessions";
import { groupSessions } from "./sidebar-groups";

function row(overrides: Partial<SessionListRow>): SessionListRow {
  return {
    sessionId: "s1",
    title: "Fix the bug",
    state: "active",
    lastActivityAt: "2026-09-03T11:58:00.000Z",
    createdAt: "2026-09-03T10:00:00.000Z",
    repositoryFullName: null,
    taskBranch: null,
    waitingForUser: false,
    currentRunId: null,
    currentRunState: null,
    ...overrides,
  };
}

describe("groupSessions", () => {
  it("has three groups: archived sessions apart, every other unpinned one Active, waiting ones too", () => {
    const groups = groupSessions(
      [
        row({ sessionId: "waiting", waitingForUser: true }),
        row({ sessionId: "paused", currentRunId: "r1", currentRunState: "paused" }),
        row({ sessionId: "working", currentRunId: "r2", currentRunState: "running" }),
        row({ sessionId: "gone", state: "archived" }),
        // Archiving takes a session out of Pinned; restoring puts it back.
        row({ sessionId: "pinned-gone", state: "archived" }),
      ],
      { pins: new Set(["pinned-gone"]) },
    );
    expect(Object.keys(groups).sort()).toEqual(["active", "archived", "pinned"]);
    expect(groups.active.map((s) => [s.sessionId, s.activity.kind])).toEqual([
      ["waiting", "needs_you"],
      ["paused", "needs_you"],
      ["working", "working"],
    ]);
    expect(groups.pinned).toEqual([]);
    expect(
      groups.archived.map((s) => [s.sessionId, s.activity.kind, s.archived, s.pinned]),
    ).toEqual([
      ["gone", "idle", true, false],
      ["pinned-gone", "idle", true, true],
    ]);
  });

  it("says which rows have a run still open, which archiving would cancel", () => {
    const groups = groupSessions([
      row({ sessionId: "none" }),
      row({ sessionId: "queued", currentRunId: "r1", currentRunState: "queued" }),
      row({ sessionId: "paused", currentRunId: "r2", currentRunState: "paused" }),
      row({ sessionId: "ended", currentRunId: "r3", currentRunState: "verified" }),
    ]);
    expect(groups.active.map((s) => [s.sessionId, s.runOpen])).toEqual([
      ["none", false],
      ["queued", true],
      ["paused", true],
      ["ended", false],
    ]);
  });

  it("orders each group by latest activity, so a session that just finished or needs you rises to the top", () => {
    const groups = groupSessions(
      [
        row({ sessionId: "older", lastActivityAt: "2026-09-03T09:00:00.000Z" }),
        row({
          sessionId: "just-finished",
          lastActivityAt: "2026-09-03T11:59:00.000Z",
          currentRunId: "r1",
          currentRunState: "completed",
        }),
        row({
          sessionId: "never-active",
          lastActivityAt: null,
          createdAt: "2026-09-03T10:00:00.000Z",
        }),
        row({
          sessionId: "needs-you",
          lastActivityAt: "2026-09-03T11:30:00.000Z",
          waitingForUser: true,
        }),
        row({ sessionId: "pin-old", lastActivityAt: "2026-09-01T00:00:00.000Z" }),
        row({ sessionId: "pin-new", lastActivityAt: "2026-09-03T11:00:00.000Z" }),
      ],
      { pins: new Set(["pin-old", "pin-new"]) },
    );
    expect(groups.active.map((s) => s.sessionId)).toEqual([
      "just-finished",
      "needs-you",
      "never-active",
      "older",
    ]);
    expect(groups.pinned.map((s) => s.sessionId)).toEqual(["pin-new", "pin-old"]);
  });

  it("keeps the given order among sessions with the same activity time", () => {
    const groups = groupSessions([
      row({ sessionId: "a" }),
      row({ sessionId: "b" }),
      row({ sessionId: "c" }),
    ]);
    expect(groups.active.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
  });

  it("sorts a row with an unreadable time last rather than failing", () => {
    const groups = groupSessions([
      row({ sessionId: "broken", lastActivityAt: "not a time" }),
      row({ sessionId: "fine" }),
    ]);
    expect(groups.active.map((s) => s.sessionId)).toEqual(["fine", "broken"]);
  });

  it("marks an ended run finished until it is seen, and never on the session on screen", () => {
    const rows = [
      row({ sessionId: "unseen", currentRunId: "r1", currentRunState: "verified" }),
      row({ sessionId: "seen", currentRunId: "r2", currentRunState: "failed" }),
      row({ sessionId: "open", currentRunId: "r3", currentRunState: "completed" }),
    ];
    const groups = groupSessions(rows, {
      seen: new Map([["seen", "r2"]]),
      openSessionId: "open",
    });
    expect(groups.active.map((s) => [s.sessionId, s.activity])).toEqual([
      ["unseen", { kind: "finished", outcome: "verified" }],
      ["seen", { kind: "idle" }],
      ["open", { kind: "idle" }],
    ]);
  });

  it("falls back to a default title when the row's title is null", () => {
    const groups = groupSessions([row({ title: null })]);
    expect(groups.active[0]?.title).toBe("Untitled session");
  });

  it("orders a row with no activity yet by when it was created", () => {
    const groups = groupSessions([
      row({ sessionId: "older", lastActivityAt: "2026-09-03T11:30:00.000Z" }),
      row({ sessionId: "new", lastActivityAt: null, createdAt: "2026-09-03T11:45:00.000Z" }),
    ]);
    expect(groups.active.map((s) => s.sessionId)).toEqual(["new", "older"]);
  });

  it("returns empty groups for no rows", () => {
    expect(groupSessions([])).toEqual({ pinned: [], active: [], archived: [] });
  });

  it("puts a pinned session under pinned and nowhere else, keeping its status dot", () => {
    const groups = groupSessions(
      [
        row({ sessionId: "kept" }),
        row({ sessionId: "kept-waiting", waitingForUser: true }),
        row({ sessionId: "plain" }),
      ],
      { pins: new Set(["kept", "kept-waiting"]) },
    );
    expect(groups.pinned.map((s) => s.sessionId)).toEqual(["kept", "kept-waiting"]);
    expect(groups.pinned.map((s) => s.pinned)).toEqual([true, true]);
    expect(groups.pinned.map((s) => s.activity.kind)).toEqual(["idle", "needs_you"]);
    expect(groups.active.map((s) => s.sessionId)).toEqual(["plain"]);
    expect(groups.active[0]?.pinned).toBe(false);
  });
});

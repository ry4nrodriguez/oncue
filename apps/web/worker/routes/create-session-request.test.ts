import { testModelRecord } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import {
  deriveRunId,
  deriveSessionId,
  deriveSessionTitle,
  parseCreateSessionRequest,
} from "./create-session-request";

const MODEL = testModelRecord();
const UUID_V5_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const VALID_INSTRUCTION = { messageId: "msg_1", text: "Fix the bug", attachments: [] };

describe("parseCreateSessionRequest", () => {
  it("accepts a well-formed body and drops everything but commandId and instruction", () => {
    const result = parseCreateSessionRequest(
      { commandId: "cmd_1", instruction: VALID_INSTRUCTION, model: { extra: "ignored" } },
      MODEL,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        commandId: "cmd_1",
        instruction: VALID_INSTRUCTION,
        skipRequiredChecks: false,
        secrets: null,
        // No branch named: the default branch and a new task branch.
        branch: { name: null, mode: "new_branch" },
        approvalMode: "ask",
      },
    });
  });

  it("carries Home's approval mode for the new session, and only ask or session", () => {
    expect(
      parseCreateSessionRequest(
        { commandId: "cmd_1", instruction: VALID_INSTRUCTION, approvalMode: "session" },
        MODEL,
      ),
    ).toMatchObject({ ok: true, value: { approvalMode: "session" } });
    for (const approvalMode of ["always", "once", null, 1]) {
      expect(
        parseCreateSessionRequest(
          { commandId: "cmd_1", instruction: VALID_INSTRUCTION, approvalMode },
          MODEL,
        ),
      ).toEqual({ ok: false, reason: "approval_mode" });
    }
  });

  it("carries the user's request to skip the required checks, and only a boolean one", () => {
    expect(
      parseCreateSessionRequest(
        { commandId: "cmd_1", instruction: VALID_INSTRUCTION, skipRequiredChecks: true },
        MODEL,
      ),
    ).toEqual({
      ok: true,
      value: {
        commandId: "cmd_1",
        instruction: VALID_INSTRUCTION,
        skipRequiredChecks: true,
        secrets: null,
        branch: { name: null, mode: "new_branch" },
        approvalMode: "ask",
      },
    });
    expect(
      parseCreateSessionRequest(
        { commandId: "cmd_1", instruction: VALID_INSTRUCTION, skipRequiredChecks: "yes" },
        MODEL,
      ),
    ).toEqual({ ok: false, reason: "skip_required_checks" });
    expect(
      parseCreateSessionRequest(
        { commandId: "cmd_1", instruction: VALID_INSTRUCTION, skipRequiredChecks: null },
        MODEL,
      ),
    ).toEqual({ ok: false, reason: "skip_required_checks" });
  });

  it("rejects a non-object body", () => {
    expect(parseCreateSessionRequest("nope", MODEL)).toEqual({
      ok: false,
      reason: "not_an_object",
    });
    expect(parseCreateSessionRequest(null, MODEL)).toEqual({
      ok: false,
      reason: "not_an_object",
    });
    expect(parseCreateSessionRequest([1, 2], MODEL)).toEqual({
      ok: false,
      reason: "not_an_object",
    });
  });

  it("rejects a missing commandId", () => {
    expect(parseCreateSessionRequest({ instruction: VALID_INSTRUCTION }, MODEL)).toEqual({
      ok: false,
      reason: "command_id",
    });
  });

  it("rejects an empty-string commandId", () => {
    expect(
      parseCreateSessionRequest({ commandId: "", instruction: VALID_INSTRUCTION }, MODEL),
    ).toEqual({ ok: false, reason: "command_id" });
  });

  it("rejects a non-string commandId", () => {
    expect(
      parseCreateSessionRequest({ commandId: 42, instruction: VALID_INSTRUCTION }, MODEL),
    ).toEqual({ ok: false, reason: "command_id" });
  });

  it("rejects an instruction the protocol schema rejects, naming the field", () => {
    const result = parseCreateSessionRequest(
      { commandId: "cmd_1", instruction: { messageId: "msg_1", attachments: [] } },
      MODEL,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "instruction") {
      expect(result.detail.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected an instruction parse failure");
    }
  });

  it("rejects a missing instruction entirely", () => {
    const result = parseCreateSessionRequest({ commandId: "cmd_1" }, MODEL);
    expect(result).toMatchObject({ ok: false, reason: "instruction" });
  });
});

describe("parseCreateSessionRequest: the disclosure card's answer", () => {
  const SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
  const parse = (secrets: unknown) =>
    parseCreateSessionRequest(
      { commandId: "cmd_1", instruction: VALID_INSTRUCTION, secrets },
      MODEL,
    );

  it("carries the commit, the ticked names once each, and an explicit start-anyway", () => {
    expect(
      parse({ baseSha: SHA, optional: ["SENTRY_DSN", "SENTRY_DSN"], startWithoutMissing: true }),
    ).toMatchObject({
      ok: true,
      value: { secrets: { baseSha: SHA, optional: ["SENTRY_DSN"], startWithoutMissing: true } },
    });
    expect(parse({ baseSha: SHA, optional: [] })).toMatchObject({
      ok: true,
      value: { secrets: { baseSha: SHA, optional: [], startWithoutMissing: false } },
    });
    expect(parse(null)).toMatchObject({ ok: true, value: { secrets: null } });
  });

  it.each([
    ["not an object", "DATABASE_URL"],
    ["an array", []],
    ["no commit", { optional: [] }],
    ["a branch name for a commit", { baseSha: "main", optional: [] }],
    ["no list", { baseSha: SHA }],
    ["a list of non-strings", { baseSha: SHA, optional: [7] }],
    ["an overlong name", { baseSha: SHA, optional: ["A".repeat(65)] }],
    ["more names than a file may declare", { baseSha: SHA, optional: Array(21).fill("A") }],
    [
      "a start-anyway that is not a boolean",
      { baseSha: SHA, optional: [], startWithoutMissing: "yes" },
    ],
  ])("refuses %s", (_label, secrets) => {
    expect(parse(secrets)).toEqual({ ok: false, reason: "secrets" });
  });
});

describe("deriveSessionTitle", () => {
  it("takes the first non-empty line", () => {
    expect(deriveSessionTitle("Fix the bug\nmore detail below")).toBe("Fix the bug");
  });

  it("skips leading blank lines", () => {
    expect(deriveSessionTitle("\n\n  \nFix the bug")).toBe("Fix the bug");
  });

  it("trims surrounding whitespace", () => {
    expect(deriveSessionTitle("   Fix the bug   \nmore")).toBe("Fix the bug");
  });

  it("truncates to 80 characters", () => {
    const long = "x".repeat(120);
    const title = deriveSessionTitle(long);
    expect(title).toHaveLength(80);
    expect(title).toBe("x".repeat(80));
  });

  it("returns an empty string when there is no non-empty line", () => {
    expect(deriveSessionTitle("\n\n   \n")).toBe("");
    expect(deriveSessionTitle("")).toBe("");
  });
});

describe("deriveSessionId / deriveRunId", () => {
  it("produce UUIDv5-shaped ids", async () => {
    const sessionId = await deriveSessionId("wsp_1", "cmd_1");
    const runId = await deriveRunId("cmd_1");
    expect(sessionId).toMatch(UUID_V5_PATTERN);
    expect(runId).toMatch(UUID_V5_PATTERN);
  });

  it("is deterministic: the same inputs give the same id", async () => {
    const first = await deriveSessionId("wsp_1", "cmd_1");
    const second = await deriveSessionId("wsp_1", "cmd_1");
    expect(first).toBe(second);

    const firstRun = await deriveRunId("cmd_1");
    const secondRun = await deriveRunId("cmd_1");
    expect(firstRun).toBe(secondRun);
  });

  it("a different commandId gives a different session id and run id", async () => {
    const a = await deriveSessionId("wsp_1", "cmd_1");
    const b = await deriveSessionId("wsp_1", "cmd_2");
    expect(a).not.toBe(b);

    const runA = await deriveRunId("cmd_1");
    const runB = await deriveRunId("cmd_2");
    expect(runA).not.toBe(runB);
  });

  it("a different workspaceId gives a different session id for the same commandId", async () => {
    const a = await deriveSessionId("wsp_1", "cmd_1");
    const b = await deriveSessionId("wsp_2", "cmd_1");
    expect(a).not.toBe(b);
  });

  it("session id and run id never collide even for the same commandId, since they use distinct namespaces", async () => {
    const sessionId = await deriveSessionId("wsp_1", "cmd_1");
    const runId = await deriveRunId("cmd_1");
    expect(sessionId).not.toBe(runId);
  });
});

describe("the branch a request names", () => {
  const parse = (fields: Record<string, unknown>) =>
    parseCreateSessionRequest(
      { commandId: "cmd_1", instruction: VALID_INSTRUCTION, ...fields },
      MODEL,
    );

  it("starts from a named branch, or works directly on it", () => {
    expect(parse({ branch: "release/1.4" })).toMatchObject({
      ok: true,
      value: { branch: { name: "release/1.4", mode: "new_branch" } },
    });
    expect(parse({ branch: "feature/login", branchMode: "existing_branch" })).toMatchObject({
      ok: true,
      value: { branch: { name: "feature/login", mode: "existing_branch" } },
    });
    expect(parse({ branch: null, branchMode: "new_branch" })).toMatchObject({
      ok: true,
      value: { branch: { name: null, mode: "new_branch" } },
    });
  });

  it.each([
    ["a mode it does not know", { branch: "a", branchMode: "both" }],
    ["working on no branch", { branchMode: "existing_branch" }],
    ["working on a null branch", { branch: null, branchMode: "existing_branch" }],
    ["a branch that is not a string", { branch: ["main"] }],
    ["a name the bridge could not push", { branch: "fix#1" }],
  ])("refuses %s", (_label, fields) => {
    expect(parse(fields)).toEqual({ ok: false, reason: "branch" });
  });
});

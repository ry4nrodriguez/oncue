import { describe, expect, it } from "vitest";
import {
  admitCommand,
  COMMAND_CATALOG,
  COMMAND_TYPES,
  type CommandType,
  canIssueCommand,
  isCommandType,
  parseCommandPayload,
} from "./commands";
import { assertNever } from "./events";

describe('COMMAND_TYPES (record 04, "Commands sent to the runtime")', () => {
  it("has exactly the twelve names the record lists, in order", () => {
    expect(COMMAND_TYPES).toEqual([
      "run.start",
      "run.follow_up",
      "run.pause",
      "run.cancel",
      "approval.resolve",
      "approval.mode",
      "question.resolve",
      "context.add",
      "agent.stop",
      "checkpoint.create",
      "policy.set",
      "runtime.shutdown",
    ]);
  });

  it("is closed: every member is handled by an exhaustive switch", () => {
    for (const type of COMMAND_TYPES) {
      const label = ((): string => {
        switch (type) {
          case "run.start":
            return "start";
          case "run.follow_up":
            return "follow_up";
          case "run.pause":
            return "pause";
          case "run.cancel":
            return "cancel";
          case "approval.resolve":
            return "resolve";
          case "approval.mode":
            return "mode";
          case "question.resolve":
            return "answer";
          case "context.add":
            return "add";
          case "agent.stop":
            return "stop";
          case "checkpoint.create":
            return "create";
          case "policy.set":
            return "set";
          case "runtime.shutdown":
            return "shutdown";
          default:
            return assertNever(type);
        }
      })();
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("isCommandType rejects a name outside the catalog", () => {
    expect(isCommandType("run.start")).toBe(true);
    expect(isCommandType("run.retry")).toBe(false);
  });
});

describe("run.start", () => {
  it("accepts while the session is active", () => {
    expect(canIssueCommand("run.start", { scope: "session", state: "active" })).toBe(true);
  });
  it("rejects while the session is archived", () => {
    expect(canIssueCommand("run.start", { scope: "session", state: "archived" })).toBe(false);
  });
});

describe("run.follow_up", () => {
  it("accepts while the run is running", () => {
    expect(canIssueCommand("run.follow_up", { scope: "run", state: "running" })).toBe(true);
  });
  it("rejects while the run has not started", () => {
    expect(canIssueCommand("run.follow_up", { scope: "run", state: "ready" })).toBe(false);
  });
  it("accepts on a paused or interrupted run, which is how Continue resumes it", () => {
    expect(canIssueCommand("run.follow_up", { scope: "run", state: "paused" })).toBe(true);
    expect(canIssueCommand("run.follow_up", { scope: "run", state: "interrupted" })).toBe(true);
  });
  it("rejects once the run has ended", () => {
    expect(canIssueCommand("run.follow_up", { scope: "run", state: "cancelled" })).toBe(false);
  });
});

describe("run.pause", () => {
  it("accepts while waiting for approval", () => {
    expect(canIssueCommand("run.pause", { scope: "run", state: "waiting_for_approval" })).toBe(
      true,
    );
  });
  it("rejects a run that already finished", () => {
    expect(canIssueCommand("run.pause", { scope: "run", state: "verified" })).toBe(false);
  });
});

describe("run.cancel", () => {
  it("accepts every non-terminal run state", () => {
    for (const state of [
      "created",
      "queued",
      "provisioning",
      "ready",
      "running",
      "waiting_for_approval",
      "paused",
      "interrupted",
    ] as const) {
      expect(canIssueCommand("run.cancel", { scope: "run", state })).toBe(true);
    }
  });
  it("rejects an already-terminal run state", () => {
    for (const state of [
      "verified",
      "completed_with_warnings",
      "completed",
      "blocked",
      "failed",
      "cancelled",
    ] as const) {
      expect(canIssueCommand("run.cancel", { scope: "run", state })).toBe(false);
    }
  });
});

describe("approval.resolve", () => {
  it("accepts only while waiting for approval", () => {
    expect(
      canIssueCommand("approval.resolve", { scope: "run", state: "waiting_for_approval" }),
    ).toBe(true);
  });
  it("rejects while running with no open approval", () => {
    expect(canIssueCommand("approval.resolve", { scope: "run", state: "running" })).toBe(false);
  });
});

describe("question.resolve", () => {
  it("accepts while the run is live or stopped waiting, so an answer can resume it", () => {
    for (const state of ["running", "waiting_for_approval", "paused", "interrupted"] as const) {
      expect(canIssueCommand("question.resolve", { scope: "run", state })).toBe(true);
    }
  });
  it("rejects once the run has ended or before it started", () => {
    for (const state of ["queued", "ready", "verified", "cancelled", "failed"] as const) {
      expect(canIssueCommand("question.resolve", { scope: "run", state })).toBe(false);
    }
  });
  it("takes an answer per question or a bare dismissal, and nothing else", () => {
    expect(
      parseCommandPayload("question.resolve", {
        action: "answer",
        questionId: "qst_1",
        answers: [["Postgres"], [], ["Web", "my own words"]],
      }).ok,
    ).toBe(true);
    expect(
      parseCommandPayload("question.resolve", { action: "dismiss", questionId: "qst_1" }).ok,
    ).toBe(true);
    expect(
      parseCommandPayload("question.resolve", {
        action: "dismiss",
        questionId: "qst_1",
        decidedBy: "someone_else",
      }).ok,
    ).toBe(false);
    expect(
      parseCommandPayload("question.resolve", {
        action: "answer",
        questionId: "qst_1",
        answers: [[], [], [], [], []],
      }).ok,
    ).toBe(false);
    expect(
      parseCommandPayload("question.resolve", {
        action: "answer",
        questionId: "qst_1",
        answers: [["a", "b", "c", "d", "e", "f", "g", "h"]],
      }).ok,
    ).toBe(false);
  });
});

describe("context.add", () => {
  it("accepts while the run is running", () => {
    expect(canIssueCommand("context.add", { scope: "run", state: "running" })).toBe(true);
  });
  it("rejects a run that has not started", () => {
    expect(canIssueCommand("context.add", { scope: "run", state: "ready" })).toBe(false);
  });
});

describe("checkpoint.create", () => {
  it("accepts while the session is archived", () => {
    expect(canIssueCommand("checkpoint.create", { scope: "session", state: "archived" })).toBe(
      true,
    );
  });
  it("rejects a session pending deletion", () => {
    expect(
      canIssueCommand("checkpoint.create", { scope: "session", state: "deletion_pending" }),
    ).toBe(false);
  });
});

describe("runtime.shutdown", () => {
  it("accepts in every session state", () => {
    for (const state of ["active", "archived", "deletion_pending"] as const) {
      expect(canIssueCommand("runtime.shutdown", { scope: "session", state })).toBe(true);
    }
  });
  it("rejects when checked against the wrong scope", () => {
    expect(canIssueCommand("runtime.shutdown", { scope: "run", state: "running" })).toBe(false);
  });
});

const COMMAND_PAYLOAD_SAMPLE_START = {
  instruction: { messageId: "msg_1", text: "add a test", attachments: [] },
  model: {
    provider: "anthropic",
    modelId: "claude",
    modelConnectionId: "conn_1",
    authenticationType: "api_key",
    contextWindow: null,
    effort: null,
  },
  continuesRunId: null,
};

describe("payload validation", () => {
  it("accepts a well-formed run.start payload", () => {
    const result = parseCommandPayload("run.start", {
      instruction: { messageId: "msg_1", text: "add a test", attachments: [] },
      model: {
        provider: "anthropic",
        modelId: "claude",
        modelConnectionId: "conn_1",
        authenticationType: "api_key",
        contextWindow: null,
        effort: null,
      },
      continuesRunId: null,
    });
    expect(result.ok).toBe(true);
  });

  it("carries the structured skip on run.start and run.follow_up, as a boolean only", () => {
    const start = COMMAND_PAYLOAD_SAMPLE_START;
    const absent = parseCommandPayload("run.start", start);
    expect(absent.ok && Object.hasOwn(absent.value, "skipRequiredChecks")).toBe(false);
    expect(parseCommandPayload("run.start", { ...start, skipRequiredChecks: true })).toMatchObject({
      ok: true,
      value: { skipRequiredChecks: true },
    });
    expect(parseCommandPayload("run.start", { ...start, skipRequiredChecks: "yes" }).ok).toBe(
      false,
    );
    const followUp = {
      messageId: "msg_2",
      text: "skip the tests",
      attachments: [],
      delivery: "run_next",
    };
    expect(
      parseCommandPayload("run.follow_up", { ...followUp, skipRequiredChecks: false }),
    ).toMatchObject({ ok: true, value: { skipRequiredChecks: false } });
    expect(parseCommandPayload("run.follow_up", { ...followUp, skipRequiredChecks: null }).ok).toBe(
      false,
    );
  });

  it("rejects a run.start payload missing a required field", () => {
    const result = parseCommandPayload("run.start", {
      instruction: { messageId: "msg_1", text: "add a test", attachments: [] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a payload carrying an unknown field (strictObject)", () => {
    const result = parseCommandPayload("run.pause", {
      reason: "user_requested",
      secret: "sk-should-not-be-here",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts every command's own minimal valid payload", () => {
    const samples: { readonly [T in CommandType]: unknown } = {
      "run.start": {
        instruction: { messageId: "msg_1", text: "go", attachments: [] },
        model: {
          provider: "anthropic",
          modelId: "claude",
          modelConnectionId: "conn_1",
          authenticationType: "api_key",
          contextWindow: null,
          effort: null,
        },
        continuesRunId: null,
      },
      "run.follow_up": {
        messageId: "msg_2",
        text: "keep going",
        attachments: [],
        delivery: "steer_current_run",
      },
      "run.pause": { reason: "user_requested" },
      "run.cancel": { reason: null, checkpointFirst: true },
      "approval.resolve": {
        approvalId: "appr_1",
        decision: "approved",
      },
      "approval.mode": { mode: "ask" },
      "question.resolve": { action: "dismiss", questionId: "qst_1" },
      "context.add": { items: [{ kind: "note", text: "watch the flaky test" }] },
      "agent.stop": { agentId: "ses_child_1" },
      "checkpoint.create": { reason: "user_requested" },
      "policy.set": { action: "confirm", proposalId: "prop_1", policyVersion: 1 },
      "runtime.shutdown": { reason: "idle", graceMs: 5000 },
    };
    for (const type of COMMAND_TYPES) {
      const result = parseCommandPayload(type, samples[type]);
      expect(result.ok, `${type} should accept its minimal payload`).toBe(true);
    }
  });

  it("no payload schema declares a field named like a secret", () => {
    const forbidden = /secret|password|token|apikey|api_key|credential/i;
    for (const type of COMMAND_TYPES) {
      const entries = (COMMAND_CATALOG[type].payload as { entries?: Record<string, unknown> })
        .entries;
      if (!entries) continue;
      for (const key of Object.keys(entries)) {
        expect(forbidden.test(key), `${type}.${key} looks like a secret field`).toBe(false);
      }
    }
  });
});

describe("admitCommand", () => {
  const processed = new Set(["cmd_already"]);

  it("accepts a fresh command valid for the current state", () => {
    expect(
      admitCommand("run.pause", "cmd_new", {
        expected: { scope: "run", state: "running" },
        processedCommandIds: processed,
      }),
    ).toEqual({ kind: "accept" });
  });

  it("reports a retry as already processed rather than applying it twice", () => {
    expect(
      admitCommand("run.pause", "cmd_already", {
        expected: { scope: "run", state: "running" },
        processedCommandIds: processed,
      }),
    ).toEqual({ kind: "already_processed", commandId: "cmd_already" });
  });

  it("checks idempotency before state, so a retry after the state moved is still a repeat", () => {
    expect(
      admitCommand("run.pause", "cmd_already", {
        expected: { scope: "run", state: "verified" },
        processedCommandIds: processed,
      }),
    ).toEqual({ kind: "already_processed", commandId: "cmd_already" });
  });

  it("rejects a fresh command the current state does not allow", () => {
    expect(
      admitCommand("run.pause", "cmd_new", {
        expected: { scope: "run", state: "verified" },
        processedCommandIds: processed,
      }),
    ).toEqual({ kind: "wrong_state", type: "run.pause" });
  });
});

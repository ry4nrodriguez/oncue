import { APPROVAL_MODES, PERMISSION_CATEGORIES, type PermissionCategory } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import type { WorkspaceApprovals } from "../approvals/store";
import {
  alwaysAsks,
  applyModeChoice,
  CATEGORY_LABEL,
  decidedCategory,
  decideFromSession,
  decidePermission,
  isCountedPermissionRefusal,
  isPermissionCategory,
  judgePermissionAsk,
  judgePermissionClaim,
  MAX_PERMISSION_ASKS_PER_RUN,
  namesSecretFile,
  offeredScopes,
  pastTheCap,
  permissionCardFor,
  permissionTitle,
  type SessionApprovals,
} from "./permission-asks";

const NOTHING: WorkspaceApprovals = { defaultMode: "ask", rules: [] };

function workspace(
  defaultMode: "ask" | "always",
  rules: readonly PermissionCategory[] = [],
): WorkspaceApprovals {
  return { defaultMode, rules: rules.map((category) => ({ category, createdAt: "2026-10-04" })) };
}

function session(
  mode: "ask" | "session",
  rules: readonly PermissionCategory[] = [],
): SessionApprovals {
  return { mode, rules };
}

describe("judgePermissionClaim", () => {
  it.each(PERMISSION_CATEGORIES)("offers %s", (category) => {
    const resource = category === "start_subagent" ? "explore subagent: Read it" : "/etc/hosts";
    expect(judgePermissionClaim({ category, resource })).toBeNull();
  });

  it("refuses a subagent start that names no built-in subagent", () => {
    expect(
      judgePermissionClaim({ category: "start_subagent", resource: "general subagent" }),
    ).toBeNull();
    for (const resource of ["evil subagent: x", "/etc/hosts", "explore subagent:", "explore"]) {
      expect(judgePermissionClaim({ category: "start_subagent", resource }), resource).toBe(
        "malformed_resource",
      );
    }
  });

  it.each(["development_secret", "external_action", "network_expansion", "other"] as const)(
    "is not where %s is judged",
    (category) => {
      expect(judgePermissionClaim({ category, resource: "x" })).toBe("not_offered");
    },
  );

  it("refuses an empty resource", () => {
    expect(judgePermissionClaim({ category: "outside_project", resource: "   " })).toBe(
      "malformed_resource",
    );
  });
});

describe("judgePermissionAsk", () => {
  const fine = { openApprovalExists: false, runRunning: true };

  it("admits an ask on a running run", () => {
    expect(judgePermissionAsk(fine)).toBeNull();
  });

  it("checks an open card first, then the run", () => {
    expect(judgePermissionAsk({ openApprovalExists: true, runRunning: false })).toBe(
      "approval_open",
    );
    expect(judgePermissionAsk({ ...fine, runRunning: false })).toBe("run_not_running");
  });

  it("counts every refusal but an honest repeat and a run past its cap", () => {
    expect(isCountedPermissionRefusal("approval_open")).toBe(false);
    expect(isCountedPermissionRefusal("too_many_requests")).toBe(false);
    for (const reason of ["not_offered", "malformed_resource", "run_not_running"] as const) {
      expect(isCountedPermissionRefusal(reason)).toBe(true);
    }
  });
});

describe("pastTheCap", () => {
  const allow = { kind: "allow", scope: "session" } as const;
  const ask = { kind: "ask" } as const;

  it("records every ask under the cap", () => {
    expect(pastTheCap(allow, MAX_PERMISSION_ASKS_PER_RUN - 1)).toBe("record");
    expect(pastTheCap(ask, 0)).toBe("record");
  });

  it("past it, still answers a saved choice without a record and refuses one needing a card", () => {
    expect(pastTheCap(allow, MAX_PERMISSION_ASKS_PER_RUN)).toBe("answer_unrecorded");
    expect(pastTheCap(ask, MAX_PERMISSION_ASKS_PER_RUN + 50)).toBe("refuse");
  });
});

describe("a secret file, whatever the sandbox called it", () => {
  it.each([
    "/workspace/.env",
    ".ENV",
    "app/.Env.Local",
    "/a, /srv/.env (+2)",
    "bash: /tmp/prod.env",
  ])("%s names one", (resource) => {
    expect(namesSecretFile(resource)).toBe(true);
    expect(decidedCategory("outside_project", resource)).toBe("secret_file");
    expect(decidedCategory("repeated_action", resource)).toBe("secret_file");
  });

  it("leaves a subagent start a start when its task mentions a secret file's name", () => {
    expect(decidedCategory("start_subagent", "general subagent: Check .env.local")).toBe(
      "start_subagent",
    );
  });

  it.each(["/etc/hosts", ".env.example", "/srv/.ENV.EXAMPLE", ".envrc", "bash"])(
    "%s does not",
    (resource) => {
      expect(namesSecretFile(resource)).toBe(false);
      expect(decidedCategory("outside_project", resource)).toBe("outside_project");
    },
  );
});

describe("decidePermission: every mode, category, and saved rule", () => {
  // The composer's three modes as the object holds them: the session's own
  // row and the workspace's default.
  const MODES = {
    ask: { session: session("ask"), workspace: NOTHING },
    session: { session: session("session"), workspace: NOTHING },
    always: { session: session("ask"), workspace: workspace("always") },
  } as const;

  for (const mode of APPROVAL_MODES) {
    for (const category of PERMISSION_CATEGORIES) {
      it(`${mode} mode, ${category}`, () => {
        const { session: own, workspace: shared } = MODES[mode];
        const decision = decidePermission(category, own, shared);
        if (category === "secret_file" || mode === "ask") {
          expect(decision).toEqual({ kind: "ask" });
        } else {
          expect(decision).toEqual({
            kind: "allow",
            scope: mode === "session" ? "session" : "always",
          });
        }
      });
    }
  }

  it.each(PERMISSION_CATEGORIES)("a session rule for %s answers only that category", (category) => {
    for (const other of PERMISSION_CATEGORIES) {
      const decision = decidePermission(other, session("ask", [category]), NOTHING);
      expect(decision.kind, `${category} rule, ${other} ask`).toBe(
        other === category && other !== "secret_file" ? "allow" : "ask",
      );
    }
  });

  it.each(PERMISSION_CATEGORIES)(
    "a workspace rule for %s answers only that category",
    (category) => {
      for (const other of PERMISSION_CATEGORIES) {
        const decision = decidePermission(other, session("ask"), workspace("ask", [category]));
        expect(decision, `${category} rule, ${other} ask`).toEqual(
          other === category && other !== "secret_file"
            ? { kind: "allow", scope: "always" }
            : { kind: "ask" },
        );
      }
    },
  );

  it("prefers the session's own answer, so D1 need not be read", () => {
    expect(decideFromSession("outside_project", session("session"))).toEqual({
      kind: "allow",
      scope: "session",
    });
    expect(decideFromSession("secret_file", session("session", ["secret_file"]))).toEqual({
      kind: "ask",
    });
    expect(decideFromSession("outside_project", session("ask"))).toBeNull();
    expect(decidePermission("outside_project", session("session"), workspace("always"))).toEqual({
      kind: "allow",
      scope: "session",
    });
  });
});

describe("what a card offers and the menu saves", () => {
  it("offers only once or no for secret files, and all three otherwise", () => {
    expect(offeredScopes("secret_file")).toEqual(["once"]);
    for (const category of [
      "outside_project",
      "repeated_action",
      "start_subagent",
      "other_request",
    ] as const) {
      expect(offeredScopes(category)).toEqual(["once", "session", "always"]);
    }
    expect(PERMISSION_CATEGORIES.filter(alwaysAsks)).toEqual(["secret_file"]);
  });

  it("splits the menu's choice between the session and the workspace", () => {
    expect(applyModeChoice("ask")).toEqual({ session: "ask", clearsRules: true });
    expect(applyModeChoice("session")).toEqual({ session: "session", clearsRules: false });
    expect(applyModeChoice("always")).toEqual({ session: "ask", clearsRules: true });
  });

  it("knows its categories", () => {
    expect(isPermissionCategory("outside_project")).toBe(true);
    expect(isPermissionCategory("development_secret")).toBe(false);
  });
});

describe("the card's words", () => {
  it("names what the agent wants in one plain line", () => {
    expect(permissionTitle("outside_project", "/home/oncue-agent/.npmrc", "file_read")).toBe(
      "Read /home/oncue-agent/.npmrc, outside the project",
    );
    expect(permissionTitle("outside_project", "/etc", "shell")).toBe(
      "Run a command on /etc, outside the project",
    );
    expect(permissionTitle("outside_project", "/etc", null)).toBe("Use /etc, outside the project");
    expect(permissionTitle("secret_file", ".env", "file_read")).toBe("Read .env, a secret file");
    expect(permissionTitle("secret_file", ".env", "file_write")).toBe("Edit .env, a secret file");
    expect(permissionTitle("secret_file", ".env", null)).toBe("Read .env, a secret file");
    expect(permissionTitle("repeated_action", "bash: ls", "shell")).toBe(
      "Repeat bash: ls a third time in a row",
    );
    expect(permissionTitle("other_request", "webfetch: https://x", "web")).toBe(
      "Allow webfetch: https://x",
    );
    expect(permissionTitle("start_subagent", "explore subagent: Read the README", null)).toBe(
      "Start the explore subagent: Read the README",
    );
  });

  it("names the subagent whose call asked", () => {
    const card = permissionCardFor({
      category: "outside_project",
      resource: "/etc/hosts",
      toolKind: "file_read",
      now: "2026-10-04T12:00:00.000Z",
      ttlMs: 1,
      subagent: "explore",
    });
    expect(card.title).toBe("Explore subagent: Read /etc/hosts, outside the project");
    expect(card.requestedScope).toBe(CATEGORY_LABEL.outside_project);
    expect(CATEGORY_LABEL.start_subagent).toBe("Starting a subagent");
  });

  it("writes every field itself, with its own expiry and a risk by category", () => {
    const card = permissionCardFor({
      category: "secret_file",
      resource: ".env",
      toolKind: "file_read",
      now: "2026-10-04T12:00:00.000Z",
      ttlMs: 600_000,
    });
    expect(card).toEqual({
      title: "Read .env, a secret file",
      intendedAction: expect.stringContaining("always ask"),
      category: "secret_file",
      risk: "high",
      resource: ".env",
      requestedScope: CATEGORY_LABEL.secret_file,
      expiresAt: "2026-10-04T12:10:00.000Z",
    });
  });

  it("keeps a title within the protocol's short text", () => {
    const card = permissionCardFor({
      category: "outside_project",
      resource: "x".repeat(255),
      toolKind: "file_read",
      now: "2026-10-04T12:00:00.000Z",
      ttlMs: 1,
    });
    expect(card.title.length).toBeLessThanOrEqual(256);
    expect(card.title.endsWith("…")).toBe(true);
  });
});

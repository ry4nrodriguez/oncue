import { describe, expect, it } from "vitest";
import {
  type ClassifyContext,
  classifyClaudeAsk,
  classifyOpenCodeAsk,
  classifyOtherAsk,
  type HarnessAsk,
  isSecretFilePath,
} from "./ask-category";
import { CLAUDE_RUNTIME } from "./claude";
import { CODEX_RUNTIME } from "./codex";
import { OPENCODE_RUNTIME } from "./opencode";
import { PI_RUNTIME } from "./pi";

const OPENCODE: ClassifyContext = {
  cwd: "/workspace",
  toolCategory: OPENCODE_RUNTIME.toolCategory,
};
const CLAUDE: ClassifyContext = { cwd: "/workspace", toolCategory: CLAUDE_RUNTIME.toolCategory };

function ask(fields: Partial<HarnessAsk> & { permission: string }): HarnessAsk {
  return { patterns: [], metadata: {}, input: null, tool: null, ...fields };
}

describe("isSecretFilePath (OpenCode's own *.env and *.env.* rule)", () => {
  it.each([
    ".env",
    "app/.env",
    "prod.env",
    ".env.local",
    "config/.env.production",
    "/home/x/.env",
    ".ENV",
    "app/.Env.Local",
  ])("%s is a secret file", (path) => {
    expect(isSecretFilePath(path)).toBe(true);
  });

  it.each([
    ".env.example",
    "app/.env.example",
    ".ENV.EXAMPLE",
    "environment.ts",
    "README.md",
    ".envrc",
  ])("%s is not", (path) => {
    expect(isSecretFilePath(path)).toBe(false);
  });
});

describe("classifyOpenCodeAsk", () => {
  it("reads external_directory from the read tool as a file outside the project", () => {
    expect(
      classifyOpenCodeAsk(
        ask({
          permission: "external_directory",
          patterns: ["/etc/*"],
          metadata: { filepath: "/etc/hosts", parentDir: "/etc" },
          tool: "read",
        }),
        OPENCODE,
      ),
    ).toEqual({ category: "outside_project", resource: "/etc/hosts", toolCategory: "file_read" });
  });

  it("names the directory a shell command reaches, from its pattern", () => {
    expect(
      classifyOpenCodeAsk(
        ask({
          permission: "external_directory",
          patterns: ["/etc/*"],
          metadata: { command: "cat /etc/hosts", directories: ["/etc"] },
          tool: "bash",
        }),
        OPENCODE,
      ),
    ).toEqual({ category: "outside_project", resource: "/etc", toolCategory: "shell" });
  });

  it("names every directory a shell command reaches, since Allow once covers them all", () => {
    // The first is the secrets directory, which OnCue allows by path: the
    // card must still name the one that made OpenCode ask.
    const step = classifyOpenCodeAsk(
      ask({
        permission: "external_directory",
        patterns: ["/var/lib/oncue/secrets/*", "/home/oncue-agent/*"],
        metadata: {
          command: "cp /var/lib/oncue/secrets/TOKEN /home/oncue-agent/x",
          directories: ["/var/lib/oncue/secrets", "/home/oncue-agent"],
          patterns: ["/var/lib/oncue/secrets/*", "/home/oncue-agent/*"],
        },
        tool: "bash",
      }),
      OPENCODE,
    );
    expect(step).toEqual({
      category: "outside_project",
      resource: "/var/lib/oncue/secrets, /home/oncue-agent",
      toolCategory: "shell",
    });
    expect(step.resource).not.toContain("cp ");
  });

  it("counts the directories past the first three", () => {
    expect(
      classifyOpenCodeAsk(
        ask({
          permission: "external_directory",
          metadata: { directories: ["/a", "/b", "/c", "/d", "/e", 7] },
        }),
        OPENCODE,
      ).resource,
    ).toBe("/a, /b, /c (+2)");
    expect(
      classifyOpenCodeAsk(
        ask({
          permission: "external_directory",
          patterns: ["/a/*", "/b/*"],
          metadata: { directories: "x" },
        }),
        OPENCODE,
      ).resource,
    ).toBe("/a, /b");
  });

  it("names the root for a command that reaches it", () => {
    expect(
      classifyOpenCodeAsk(ask({ permission: "external_directory", patterns: ["/*"] }), OPENCODE)
        .resource,
    ).toBe("/");
  });

  it("still asks when it knows neither path nor tool", () => {
    expect(classifyOpenCodeAsk(ask({ permission: "external_directory" }), OPENCODE)).toEqual({
      category: "outside_project",
      resource: "a path outside the project",
      toolCategory: null,
    });
  });

  it("reads a read ask on an env file as a secret file", () => {
    expect(
      classifyOpenCodeAsk(ask({ permission: "read", patterns: [".env.local"] }), OPENCODE),
    ).toEqual({
      category: "secret_file",
      resource: ".env.local",
      toolCategory: "file_read",
    });
  });

  it("does not call an MCP resource read a secret file", () => {
    expect(
      classifyOpenCodeAsk(ask({ permission: "read", patterns: ["mcp:oncue:file://x"] }), OPENCODE),
    ).toEqual({
      category: "other_request",
      resource: "read",
      toolCategory: null,
    });
    expect(classifyOpenCodeAsk(ask({ permission: "read" }), OPENCODE).category).toBe(
      "other_request",
    );
  });

  it("reads task as starting a subagent, named with the description the agent wrote", () => {
    expect(
      classifyOpenCodeAsk(
        ask({
          permission: "task",
          patterns: ["explore"],
          metadata: { description: "Read the README", subagent_type: "explore" },
        }),
        OPENCODE,
      ),
    ).toEqual({
      category: "start_subagent",
      resource: "explore subagent: Read the README",
      toolCategory: null,
    });
    expect(
      classifyOpenCodeAsk(ask({ permission: "task", patterns: ["general"] }), OPENCODE),
    ).toEqual({
      category: "start_subagent",
      resource: "general subagent",
      toolCategory: null,
    });
    expect(classifyOpenCodeAsk(ask({ permission: "task" }), OPENCODE).resource).toBe("a subagent");
  });

  it("reads doom_loop as a repeated action, naming the tool and its path but never a command", () => {
    expect(
      classifyOpenCodeAsk(
        ask({
          permission: "doom_loop",
          patterns: ["bash"],
          metadata: {
            tool: "bash",
            input: {
              command: "curl -H 'Authorization: Bearer abc'\nsecond line",
              description: "x",
            },
          },
        }),
        OPENCODE,
      ),
    ).toEqual({ category: "repeated_action", resource: "bash", toolCategory: "shell" });
    expect(
      classifyOpenCodeAsk(
        ask({
          permission: "doom_loop",
          metadata: { tool: "read", input: { filePath: "src/a.ts" } },
        }),
        OPENCODE,
      ).resource,
    ).toBe("read: src/a.ts");
    expect(
      classifyOpenCodeAsk(
        ask({
          permission: "doom_loop",
          metadata: { tool: "webfetch", input: { url: "https://x.dev/a?token=abc#f" } },
        }),
        OPENCODE,
      ).resource,
    ).toBe("webfetch: https://x.dev/a");
    expect(
      classifyOpenCodeAsk(
        ask({
          permission: "doom_loop",
          metadata: { tool: "webfetch", input: { url: "not a url" } },
        }),
        OPENCODE,
      ).resource,
    ).toBe("webfetch");
    expect(
      classifyOpenCodeAsk(
        ask({ permission: "doom_loop", metadata: { tool: "grep", input: "raw" } }),
        OPENCODE,
      ).resource,
    ).toBe("grep");
    expect(
      classifyOpenCodeAsk(ask({ permission: "doom_loop", patterns: ["todowrite"] }), OPENCODE),
    ).toEqual({ category: "repeated_action", resource: "todowrite", toolCategory: "other" });
    expect(classifyOpenCodeAsk(ask({ permission: "doom_loop" }), OPENCODE).resource).toBe("a tool");
  });

  it("asks for anything it has no category for, and never allows it silently", () => {
    expect(
      classifyOpenCodeAsk(
        ask({ permission: "webfetch", patterns: ["https://x?key=1"], tool: "webfetch" }),
        OPENCODE,
      ),
    ).toEqual({ category: "other_request", resource: "webfetch", toolCategory: "web" });
  });

  it("names only path-shaped patterns for an ask it has no category for, never a command", () => {
    expect(
      classifyOpenCodeAsk(
        ask({ permission: "edit", patterns: ["./a.ts", "~/b", "../c", "/d", "/e"] }),
        OPENCODE,
      ).resource,
    ).toBe("edit: ./a.ts, ~/b, ../c (+2)");
    expect(
      classifyOpenCodeAsk(
        ask({ permission: "bash", patterns: ["/bin/rm -rf /", "git push"] }),
        OPENCODE,
      ).resource,
    ).toBe("bash");
  });
});

describe("classifyClaudeAsk (can_use_tool)", () => {
  it("reads a Read outside the work tree as a file outside the project", () => {
    expect(
      classifyClaudeAsk(
        ask({ permission: "Read", input: { file_path: "/home/oncue-agent/.npmrc" } }),
        CLAUDE,
      ),
    ).toEqual({
      category: "outside_project",
      resource: "/home/oncue-agent/.npmrc",
      toolCategory: "file_read",
    });
  });

  it("reads an Edit or a Write of an env file as a secret file too", () => {
    expect(
      classifyClaudeAsk(
        ask({ permission: "Edit", input: { file_path: "/workspace/.env" } }),
        CLAUDE,
      ),
    ).toEqual({ category: "secret_file", resource: "/workspace/.env", toolCategory: "file_write" });
    expect(
      classifyClaudeAsk(ask({ permission: "Write", input: { file_path: ".ENV.local" } }), CLAUDE),
    ).toMatchObject({ category: "secret_file", toolCategory: "file_write" });
  });

  it("does not take a home-relative or variable path for one inside the work tree", () => {
    for (const file_path of ["~/x", "~", "$HOME/.npmrc"]) {
      expect(
        classifyClaudeAsk(ask({ permission: "Read", input: { file_path } }), CLAUDE),
      ).toMatchObject({ category: "outside_project", resource: file_path });
    }
  });

  it("reads a Read of an env file as a secret file, inside or outside", () => {
    expect(
      classifyClaudeAsk(
        ask({ permission: "Read", input: { file_path: "/workspace/.env" } }),
        CLAUDE,
      ),
    ).toMatchObject({ category: "secret_file", resource: "/workspace/.env" });
    expect(
      classifyClaudeAsk(
        ask({ permission: "Read", input: { file_path: "/srv/.env.prod" } }),
        CLAUDE,
      ),
    ).toMatchObject({ category: "secret_file" });
  });

  it("reads an Edit, Write, or search outside the work tree as outside the project", () => {
    expect(
      classifyClaudeAsk(ask({ permission: "Write", input: { file_path: "/tmp/x" } }), CLAUDE),
    ).toMatchObject({
      category: "outside_project",
      toolCategory: "file_write",
    });
    expect(
      classifyClaudeAsk(ask({ permission: "Grep", input: { path: "/etc", pattern: "x" } }), CLAUDE),
    ).toMatchObject({ category: "outside_project", resource: "/etc", toolCategory: "search" });
    expect(
      classifyClaudeAsk(
        ask({ permission: "NotebookEdit", input: { notebook_path: "../up.ipynb" } }),
        CLAUDE,
      ),
    ).toMatchObject({ category: "outside_project" });
  });

  it("does not call a path inside the work tree outside, even through a sibling's prefix", () => {
    expect(
      classifyClaudeAsk(
        ask({ permission: "Edit", input: { file_path: "/workspace/a.ts" } }),
        CLAUDE,
      ),
    ).toMatchObject({ category: "other_request" });
    expect(
      classifyClaudeAsk(ask({ permission: "Edit", input: { file_path: "src/a.ts" } }), CLAUDE),
    ).toMatchObject({ category: "other_request" });
    expect(
      classifyClaudeAsk(ask({ permission: "Edit", input: { file_path: "/workspace" } }), CLAUDE),
    ).toMatchObject({ category: "other_request" });
    expect(
      classifyClaudeAsk(
        ask({ permission: "Edit", input: { file_path: "/workspace-other/a" } }),
        CLAUDE,
      ),
    ).toMatchObject({ category: "outside_project" });
    expect(
      classifyClaudeAsk(
        ask({ permission: "Edit", input: { file_path: "/workspace/../etc/x" } }),
        CLAUDE,
      ),
    ).toMatchObject({ category: "outside_project" });
    expect(
      classifyClaudeAsk(ask({ permission: "Read", input: { file_path: "/workspace/a" } }), {
        ...CLAUDE,
        cwd: "/workspace/",
      }),
    ).toMatchObject({ category: "other_request" });
  });

  it("asks for any other tool, naming its path but never its command", () => {
    expect(
      classifyClaudeAsk(ask({ permission: "Bash", input: { command: "rm -rf build" } }), CLAUDE),
    ).toEqual({
      category: "other_request",
      resource: "Bash",
      toolCategory: "shell",
    });
    expect(
      classifyClaudeAsk(
        ask({ permission: "WebFetch", input: { url: "https://a.b/c?k=1" } }),
        CLAUDE,
      ).resource,
    ).toBe("WebFetch: https://a.b/c");
    expect(classifyClaudeAsk(ask({ permission: "WebSearch" }), CLAUDE)).toEqual({
      category: "other_request",
      resource: "WebSearch",
      toolCategory: "web",
    });
    expect(classifyClaudeAsk(ask({ permission: "Read", input: {} }), CLAUDE).category).toBe(
      "other_request",
    );
  });
});

describe("each adapter's classifyAsk", () => {
  it("is the classifier for its harness's own asks", () => {
    expect(OPENCODE_RUNTIME.classifyAsk).toBe(classifyOpenCodeAsk);
    expect(CLAUDE_RUNTIME.classifyAsk).toBe(classifyClaudeAsk);
    // Codex runs with approvals off and Pi has no permission system: only
    // OnCue's own tools are ever held, so anything else asks the user.
    expect(CODEX_RUNTIME.classifyAsk).toBe(classifyOtherAsk);
    expect(PI_RUNTIME.classifyAsk).toBe(classifyOtherAsk);
    expect(
      classifyOtherAsk(ask({ permission: "oncue_something", input: { query: "x" } }), OPENCODE),
    ).toEqual({ category: "other_request", resource: "oncue_something", toolCategory: null });
    expect(
      classifyOtherAsk(ask({ permission: "oncue_something", input: { path: "/a" } }), OPENCODE)
        .resource,
    ).toBe("oncue_something: /a");
  });

  it("says which harness spreads one reject to every pending ask", () => {
    expect(OPENCODE_RUNTIME.rejectSettlesOtherAsks).toBe(true);
    expect(CLAUDE_RUNTIME.rejectSettlesOtherAsks).toBe(false);
    expect(CODEX_RUNTIME.rejectSettlesOtherAsks).toBe(false);
    expect(PI_RUNTIME.rejectSettlesOtherAsks).toBe(false);
  });
});

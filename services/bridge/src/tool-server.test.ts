import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMIT_MESSAGE_MAX_CHARS,
  COMMIT_SUBJECT_MAX_CHARS,
  COMMIT_TOOL_DEFINITION,
  DESCRIBE_TOOL_ANSWER,
  DESCRIBE_TOOL_DEFINITION,
  handleToolRequest,
  MAX_TOOL_REQUEST_BYTES,
  POLICY_TOOL_ANSWER,
  POLICY_TOOL_DEFINITION,
  parseCommitToolCall,
  parseDescribeToolCall,
  parsePolicyToolCall,
  SECRET_TOOL_DEFINITION,
  startToolServer,
  TOOL_SERVER_PATH,
  type ToolHandlers,
  type ToolServer,
} from "./tool-server";

/** The policy tests care about `onPropose` alone; the secret tool's answer is fixed. */
function handlersWith(onPropose: ToolHandlers["onPropose"]): ToolHandlers {
  return {
    onPropose,
    onDescribe: vi.fn(),
    onCommit: vi.fn(),
    secretAnswer: () => ({ text: "not supplied", isError: true }),
  };
}

const rpc = (method: string, params?: unknown, id: unknown = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe("parsePolicyToolCall", () => {
  it("keeps only the fields the call set, and trims and bounds the rationale", () => {
    expect(parsePolicyToolCall({ push: "auto", rationale: `  ${"x".repeat(900)} ` })).toEqual({
      commit: undefined,
      push: "auto",
      pullRequest: undefined,
      rationale: "x".repeat(500),
    });
  });

  it.each([
    ["not an object", "push"],
    ["an array", [{ push: "auto" }]],
    ["null", null],
    ["a commit value outside the list", { commit: "always", rationale: "r" }],
    ["a push value outside the list", { push: "force", rationale: "r" }],
    ["a pull request value outside the list", { pullRequest: "merge", rationale: "r" }],
    ["no rationale", { push: "auto" }],
    ["an empty rationale", { push: "auto", rationale: "  " }],
    ["no field to change", { rationale: "r" }],
  ])("refuses %s", (_name, args) => {
    expect(parsePolicyToolCall(args)).toBeNull();
  });
});

describe("handleToolRequest", () => {
  it("answers initialize with the client's protocol version, or its own", () => {
    expect(
      handleToolRequest(
        rpc("initialize", { protocolVersion: "2025-11-25" }),
        handlersWith(vi.fn()),
      ),
    ).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "oncue", version: "1" },
        },
      },
    });
    expect(handleToolRequest(rpc("initialize"), handlersWith(vi.fn()))).toMatchObject({
      body: { result: { protocolVersion: "2025-06-18" } },
    });
  });

  it("lists its tools, and answers ping", () => {
    expect(handleToolRequest(rpc("tools/list"), handlersWith(vi.fn()))).toMatchObject({
      body: {
        result: {
          tools: [
            POLICY_TOOL_DEFINITION,
            DESCRIBE_TOOL_DEFINITION,
            COMMIT_TOOL_DEFINITION,
            SECRET_TOOL_DEFINITION,
          ],
        },
      },
    });
    expect(handleToolRequest(rpc("ping"), handlersWith(vi.fn()))).toMatchObject({
      body: { result: {} },
    });
  });

  it("hands a well-formed call on, and never says it was accepted", () => {
    const onPropose = vi.fn();
    const answer = handleToolRequest(
      rpc("tools/call", {
        name: "policy_propose",
        arguments: { push: "auto", pullRequest: "auto_after_verification", rationale: "Asked." },
      }),
      handlersWith(onPropose),
    );
    expect(onPropose).toHaveBeenCalledExactlyOnceWith({
      commit: undefined,
      push: "auto",
      pullRequest: "auto_after_verification",
      rationale: "Asked.",
    });
    expect(answer).toMatchObject({
      body: { result: { content: [{ type: "text", text: POLICY_TOOL_ANSWER }], isError: false } },
    });
    expect(POLICY_TOOL_ANSWER).toContain("waiting for the user to confirm");
  });

  it("answers a malformed call as a tool error and hands nothing on", () => {
    const onPropose = vi.fn();
    expect(
      handleToolRequest(
        rpc("tools/call", { name: "policy_propose", arguments: {} }),
        handlersWith(onPropose),
      ),
    ).toMatchObject({ body: { result: { isError: true } } });
    expect(onPropose).not.toHaveBeenCalled();
  });

  it("refuses another tool, another method, and a call with no params", () => {
    expect(
      handleToolRequest(rpc("tools/call", { name: "bash" }), handlersWith(vi.fn())),
    ).toMatchObject({
      body: { error: { code: -32602 } },
    });
    expect(handleToolRequest(rpc("tools/call"), handlersWith(vi.fn()))).toMatchObject({
      body: { error: { code: -32602 } },
    });
    expect(handleToolRequest(rpc("resources/list"), handlersWith(vi.fn()))).toMatchObject({
      body: { error: { code: -32601 } },
    });
  });

  it("accepts a notification with nothing to say", () => {
    expect(
      handleToolRequest(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        handlersWith(vi.fn()),
      ),
    ).toEqual({ status: 202, body: null });
  });

  it.each([
    ["not JSON-RPC", { id: 1, method: "ping" }],
    ["no method", { jsonrpc: "2.0", id: 1 }],
    ["not an object", null],
  ])("answers 400 to %s", (_name, message) => {
    expect(handleToolRequest(message, handlersWith(vi.fn()))).toEqual({ status: 400, body: null });
  });
});

describe("startToolServer", () => {
  let server: ToolServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function started(onPropose = vi.fn()) {
    server = await startToolServer(handlersWith(onPropose));
    return { url: `http://127.0.0.1:${server.port}${TOOL_SERVER_PATH}`, onPropose };
  }

  const post = (url: string, body: string) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });

  it("serves a call over loopback HTTP", async () => {
    const { url, onPropose } = await started();
    const response = await post(
      url,
      JSON.stringify(
        rpc("tools/call", {
          name: "policy_propose",
          arguments: { push: "never", rationale: "Stop." },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { isError: false } });
    expect(onPropose).toHaveBeenCalledOnce();
  });

  it("answers a notification with 202 and no body", async () => {
    const { url } = await started();
    const response = await post(
      url,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("answers 404 off its path, 405 to a GET, and 400 to a body that is not JSON", async () => {
    const { url } = await started();
    expect((await post(url.replace("/mcp", "/other"), "{}")).status).toBe(404);
    expect((await fetch(url)).status).toBe(405);
    expect((await post(url, "not json")).status).toBe(400);
  });

  it("answers 400 to a body over the limit", async () => {
    const { url } = await started();
    const outcome = await post(url, "x".repeat(MAX_TOOL_REQUEST_BYTES + 1)).then(
      (response) => response.status,
      () => "reset",
    );
    expect([400, "reset"]).toContain(outcome);
  });
});

describe("the secret_request tool", () => {
  const answers = {
    onPropose: vi.fn(),
    onDescribe: vi.fn(),
    onCommit: vi.fn(),
    secretAnswer: (name: string) =>
      name === "DATABASE_URL"
        ? {
            text: "DATABASE_URL is available. Read it from the file /x/DATABASE_URL.",
            isError: false,
          }
        : { text: "That secret has not been supplied to this session.", isError: true },
  };

  it("is listed beside the policy tool, and says what it is for and what it never does", () => {
    const listed = handleToolRequest(rpc("tools/list"), answers) as unknown as {
      body: { result: { tools: { name: string; description: string }[] } };
    };
    expect(listed.body.result.tools.map((tool) => tool.name)).toEqual([
      "policy_propose",
      "pull_request_describe",
      "git_commit",
      "secret_request",
    ]);
    const tool = listed.body.result.tools[3];
    expect(tool?.description).toContain("the user");
    expect(tool?.description).toContain("never");
  });

  it("answers from what was written: where a supplied secret is, and never its value", () => {
    expect(
      handleToolRequest(
        rpc("tools/call", { name: "secret_request", arguments: { name: "DATABASE_URL" } }),
        answers,
      ),
    ).toMatchObject({
      body: {
        result: {
          content: [{ type: "text", text: expect.stringContaining("/x/DATABASE_URL") }],
          isError: false,
        },
      },
    });
  });

  it("tells a call that was let through some other way that nothing was supplied", () => {
    // The permission gate in front of this tool is cooperative: the agent can
    // answer it itself on loopback. This is all that gets it.
    expect(
      handleToolRequest(
        rpc("tools/call", { name: "secret_request", arguments: { name: "STRIPE_TEST_KEY" } }),
        answers,
      ),
    ).toMatchObject({ body: { result: { isError: true } } });
  });

  it.each([{}, { name: 7 }, null, "DATABASE_URL"])(
    "answers an error for arguments %j without asking anything",
    (args) => {
      const secretAnswer = vi.fn(() => ({ text: "x", isError: false }));
      expect(
        handleToolRequest(rpc("tools/call", { name: "secret_request", arguments: args }), {
          onPropose: vi.fn(),
          onDescribe: vi.fn(),
          onCommit: vi.fn(),
          secretAnswer,
        }),
      ).toMatchObject({ body: { result: { isError: true } } });
      expect(secretAnswer).not.toHaveBeenCalled();
    },
  );
});

describe("the pull_request_describe tool (record 07)", () => {
  it("trims each field and keeps a field left out as null", () => {
    expect(
      parseDescribeToolCall({ branchName: " oncue/fix-login ", title: "  Fix the login  " }),
    ).toEqual({
      ok: true,
      call: { branchName: "oncue/fix-login", title: "Fix the login", body: null },
    });
    expect(parseDescribeToolCall({ body: "## What\n\nA fix." })).toEqual({
      ok: true,
      call: { branchName: null, title: null, body: "## What\n\nA fix." },
    });
  });

  it.each([
    ["not an object", "oncue/x", "object"],
    ["no field", {}, "at least one"],
    ["a field that is not a string", { title: 7 }, "strings"],
    ["a branch outside oncue/", { branchName: "main" }, "oncue/"],
    ["a branch git refuses", { branchName: "oncue/a..b" }, "oncue/"],
    ["a title on two lines", { title: "one\ntwo" }, "one line"],
    ["a blank title", { title: "   " }, "one line"],
    ["a title too long", { title: "x".repeat(201) }, "one line"],
    ["a blank body", { body: " " }, "body"],
    ["a body too long", { body: "x".repeat(16 * 1024 + 1) }, "body"],
  ])("refuses %s, saying why", (_name, args, why) => {
    const parsed = parseDescribeToolCall(args);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.why).toContain(why);
  });

  it("hands a well-formed call on and answers that it was saved, not pushed", () => {
    const onDescribe = vi.fn();
    const answer = handleToolRequest(
      rpc("tools/call", {
        name: "pull_request_describe",
        arguments: { title: "Fix the login", body: "A fix." },
      }),
      {
        onPropose: vi.fn(),
        onDescribe,
        onCommit: vi.fn(),
        secretAnswer: () => ({ text: "", isError: true }),
      },
    );
    expect(onDescribe).toHaveBeenCalledExactlyOnceWith({
      branchName: null,
      title: "Fix the login",
      body: "A fix.",
    });
    expect(answer).toMatchObject({
      body: { result: { content: [{ text: DESCRIBE_TOOL_ANSWER }], isError: false } },
    });
    expect(DESCRIBE_TOOL_ANSWER).toContain("Do not push");
  });

  it("answers a malformed call as a tool error and hands nothing on", () => {
    const onDescribe = vi.fn();
    expect(
      handleToolRequest(
        rpc("tools/call", { name: "pull_request_describe", arguments: { branchName: "main" } }),
        {
          onPropose: vi.fn(),
          onDescribe,
          onCommit: vi.fn(),
          secretAnswer: () => ({ text: "", isError: true }),
        },
      ),
    ).toMatchObject({ body: { result: { isError: true } } });
    expect(onDescribe).not.toHaveBeenCalled();
  });
});

describe("the git_commit tool (record 07, Commits)", () => {
  const handlers = (onCommit: ToolHandlers["onCommit"]): ToolHandlers => ({
    onPropose: vi.fn(),
    onDescribe: vi.fn(),
    onCommit,
    secretAnswer: () => ({ text: "", isError: true }),
  });

  it("trims the message, normalises line endings, and keeps a body after the subject", () => {
    expect(parseCommitToolCall({ message: "  Fix the redirect\r\n\r\nIt looped.  " })).toEqual({
      ok: true,
      call: { message: "Fix the redirect\n\nIt looped." },
    });
  });

  // The message is the model's, so it is cleaned before it is measured, and
  // what is committed is what the object is told.
  it("strips control and direction characters and any trailer naming a person", () => {
    const override = String.fromCharCode(0x202e);
    expect(
      parseCommitToolCall({
        message: `Fix${override} it\n\nBody.\n\nCo-authored-by: Octo Cat <octocat@github.com>\nSigned-off-by: x`,
      }),
    ).toEqual({ ok: true, call: { message: "Fix it\n\nBody." } });
    const onlyATrailer = parseCommitToolCall({ message: "Co-authored-by: x <x@y>" });
    expect(onlyATrailer.ok ? "" : onlyATrailer.why).toContain("blank");
  });

  it.each([
    ["no message", {}, "a string"],
    ["a message that is not a string", { message: 7 }, "a string"],
    ["a blank message", { message: "  \n " }, "blank"],
    ["a subject too long", { message: "x".repeat(COMMIT_SUBJECT_MAX_CHARS + 1) }, "subject"],
    ["a message too long", { message: `ok\n${"x".repeat(COMMIT_MESSAGE_MAX_CHARS)}` }, "at most"],
  ])("refuses %s, saying why", (_name, args, why) => {
    const parsed = parseCommitToolCall(args);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.why).toContain(why);
  });

  it("waits for the bridge's answer and hands it to the model as the tool's result", async () => {
    const onCommit = vi.fn(async () => ({
      text: "Committed abcdef12 (1 file, +2 -0).",
      isError: false,
    }));
    const answer = await handleToolRequest(
      rpc("tools/call", { name: "git_commit", arguments: { message: "Fix the redirect" } }),
      handlers(onCommit),
    );
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({ message: "Fix the redirect" });
    expect(answer).toMatchObject({
      body: {
        result: { content: [{ text: "Committed abcdef12 (1 file, +2 -0)." }], isError: false },
      },
    });
    expect(COMMIT_TOOL_DEFINITION.description).toContain("pushes nothing");
  });

  it("answers a malformed call as a tool error without asking the bridge", async () => {
    const onCommit = vi.fn();
    expect(
      await handleToolRequest(
        rpc("tools/call", { name: "git_commit", arguments: { message: "" } }),
        handlers(onCommit),
      ),
    ).toMatchObject({ body: { result: { isError: true } } });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

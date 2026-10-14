import { describe, expect, it } from "vitest";
import { createProviderDouble } from "./provider-double";
import { behavioursIn, SUBAGENT_DESCRIPTION, subagentReply } from "./subagent-script";

function body(firstUser: string, options: { tools?: string[]; result?: boolean } = {}): string {
  const messages: Array<{ role: string; content: unknown }> = [
    { role: "user", content: [{ type: "text", text: firstUser }] },
  ];
  if (options.result === true) {
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "x" }] });
  }
  return JSON.stringify({
    tools: (options.tools ?? ["bash", "task"]).map((name) => ({ name })),
    messages,
  });
}

describe("the subagents script", () => {
  it("reads the behaviours a task names", () => {
    expect(behavioursIn("go [agents:ok,fail,slow]")).toEqual(["ok", "fail", "slow"]);
    expect(behavioursIn("go [agents:nope]")).toBeNull();
    expect(behavioursIn("no marker")).toBeNull();
  });

  it("starts one subagent per behaviour from the primary agent, then answers", () => {
    const first = subagentReply(body("Look around [agents:ok,slow]"));
    expect(first).toEqual({
      kind: "calls",
      calls: [
        {
          name: "task",
          input: {
            description: SUBAGENT_DESCRIPTION(1, "ok"),
            prompt: "[subagent:1:ok] Look at the work tree and report what you find.",
            subagent_type: "general",
          },
        },
        {
          name: "task",
          input: {
            description: SUBAGENT_DESCRIPTION(2, "slow"),
            prompt: "[subagent:2:slow] Look at the work tree and report what you find.",
            subagent_type: "explore",
          },
        },
      ],
    });
    expect(subagentReply(body("Look around [agents:ok]", { result: true }))).toEqual({
      kind: "text_with",
      text: "The subagents reported back.",
    });
    // No task tool offered, or no marker: the ordinary answer.
    expect(subagentReply(body("Look around [agents:ok]", { tools: ["bash"] }))).toEqual({
      kind: "text",
    });
    expect(subagentReply(body("Just answer"))).toEqual({ kind: "text" });
    expect(subagentReply("not json")).toEqual({ kind: "text" });
  });

  it("has each subagent do what its prompt says", () => {
    expect(subagentReply(body("[subagent:1:fail] x"))).toEqual({ kind: "fail" });
    expect(subagentReply(body("[subagent:2:slow] x"))).toMatchObject({
      kind: "calls",
      calls: [{ name: "bash", input: { command: "sleep 120" } }],
    });
    expect(subagentReply(body("[subagent:3:ok] x"))).toMatchObject({
      kind: "calls",
      calls: [{ name: "bash", input: { command: "ls" } }],
    });
    expect(subagentReply(body("[subagent:3:ok] x", { result: true }))).toEqual({
      kind: "text_with",
      text: "Subagent 3 looked and found the README.",
    });
    expect(subagentReply(body("[subagent:4:ok] x", { tools: ["read"] }))).toMatchObject({
      kind: "text_with",
    });
  });

  it("answers through the double in the provider's own shapes", async () => {
    const double = createProviderDouble("anthropic", "subagents", { gapMs: 0 });
    const url = "https://api.anthropic.com/v1/messages";
    const calls = await double.fetchImpl(url, { method: "POST", body: body("go [agents:ok,ok]") });
    const text = await calls.text();
    expect(text.match(/"type":"tool_use"/g)).toHaveLength(2);
    const failed = await double.fetchImpl(url, {
      method: "POST",
      body: body("[subagent:1:fail] x"),
    });
    expect(failed.status).toBe(400);
    const prose = await double.fetchImpl(url, {
      method: "POST",
      body: body("[subagent:1:ok] x", { result: true }),
    });
    expect(await prose.text()).toContain("README.");
    const plain = await double.fetchImpl(url, { method: "POST", body: body("hello") });
    expect(await plain.text()).toContain("chunk-0");
  });
});

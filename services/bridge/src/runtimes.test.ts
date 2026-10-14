import { runtimeDescriptor } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import { initialAgentState, runtimeOf } from "./agent";
import {
  OPENCODE_BINARY,
  OPENCODE_PORT,
  OPENCODE_RUNTIME,
  OPENCODE_VERSION,
  plannedRuntimeSpawn,
} from "./opencode";
import { promptableModels, switchableEntries } from "./runtime";
import { DEFAULT_RUNTIME_ID, isRuntimeId, RUNTIMES, runtimePlan } from "./runtimes";
import { secretPermissionKey } from "./secrets";
import { TOOL_SERVER_NAME } from "./tool-server";

describe("each adapter against the shared catalog", () => {
  it("agrees with @oncue/protocol on version, providers, images, and holding a call", () => {
    for (const plan of Object.values(RUNTIMES)) {
      const descriptor = runtimeDescriptor(plan.id);
      expect(plan.pinnedVersion).toBe(descriptor.pinnedVersion);
      expect(plan.providers).toEqual(descriptor.providers);
      expect(plan.profile.images).toBe(descriptor.images);
      expect(plan.profile.holdsToolCalls === "permission_gate").toBe(descriptor.holdsToolCalls);
      // The object changes model in a live sandbox only where the adapter does.
      expect(plan.profile.modelSwitch === "per_prompt").toBe(descriptor.liveModelSwitch);
    }
  });
});

describe("which models one harness process can be prompted with", () => {
  const model = { provider: "anthropic", modelId: "claude-sonnet-5" };
  const spec = {
    name: "Any",
    contextWindow: 1,
    maxOutput: 1,
    effortLevels: null,
    imageInput: false,
  };
  const catalog = [
    { ...model, spec },
    { provider: "anthropic", modelId: "claude-opus-5-5", spec },
    { provider: "openai", modelId: "gpt-6-sol", spec },
    { provider: "elsewhere", modelId: "other-1", spec },
  ];

  it("a per-prompt harness: its own model, then each listed model of a provider it drives", () => {
    expect(promptableModels(OPENCODE_RUNTIME, model, catalog)).toEqual([
      model,
      { provider: "anthropic", modelId: "claude-opus-5-5" },
      { provider: "openai", modelId: "gpt-6-sol" },
    ]);
    expect(
      switchableEntries(OPENCODE_RUNTIME, model, catalog).map((entry) => entry.modelId),
    ).toEqual(["claude-opus-5-5", "gpt-6-sol"]);
  });

  it("a per-prompt harness whose grant listed nothing: its own model alone", () => {
    expect(promptableModels(OPENCODE_RUNTIME, model, undefined)).toEqual([model]);
    expect(promptableModels(OPENCODE_RUNTIME, model, [])).toEqual([model]);
  });

  it("every other harness: its own model alone, whatever the grant listed", () => {
    for (const plan of Object.values(RUNTIMES)) {
      if (plan.profile.modelSwitch === "none") {
        expect(promptableModels(plan, model, catalog)).toEqual([model]);
      }
    }
  });
});

describe("the runtime registry", () => {
  it("names each adapter under its own id", () => {
    for (const [id, plan] of Object.entries(RUNTIMES)) {
      expect(plan.id).toBe(id);
      expect(runtimePlan(plan.id)).toBe(plan);
    }
  });

  it("knows its ids and nothing else", () => {
    expect(isRuntimeId("opencode")).toBe(true);
    expect(isRuntimeId("codex")).toBe(true);
    expect(isRuntimeId("pi")).toBe(true);
    expect(isRuntimeId("claude")).toBe(true);
    expect(isRuntimeId("cursor")).toBe(false);
    expect(isRuntimeId("toString")).toBe(false);
    expect(isRuntimeId(7)).toBe(false);
    expect(isRuntimeId(null)).toBe(false);
  });

  it("runs OpenCode for a session whose grant names no runtime", () => {
    expect(DEFAULT_RUNTIME_ID).toBe("opencode");
    expect(runtimeOf(initialAgentState("ses_1", 1)).id).toBe("opencode");
  });
});

describe("OpenCode's pure half", () => {
  it("is what the bridge ran before the boundary existed", () => {
    expect(OPENCODE_RUNTIME).toMatchObject({
      id: "opencode",
      pinnedVersion: OPENCODE_VERSION,
      providers: ["anthropic", "openai"],
      defaultPort: OPENCODE_PORT,
      profile: {
        control: "http",
        toolDelivery: "loopback-mcp",
        steerIsOnePrompt: true,
        holdsToolCalls: "permission_gate",
        images: true,
      },
    });
    expect(OPENCODE_RUNTIME.planSpawn).toBe(plannedRuntimeSpawn);
    const spawn = OPENCODE_RUNTIME.planSpawn({
      port: OPENCODE_PORT,
      relayPort: 5001,
      toolPort: 5002,
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
      modelSpec: null,
    });
    expect(spawn.argv[0]).toBe(OPENCODE_BINARY);
  });

  it("presents OnCue's tools as `<server>_<tool>`, which is also the permission key", () => {
    expect(OPENCODE_RUNTIME.presentToolName("secret_request")).toBe(
      secretPermissionKey(TOOL_SERVER_NAME),
    );
    expect(OPENCODE_RUNTIME.presentToolName("git_commit")).toBe("oncue_git_commit");
  });

  it("maps its own tool ids and leaves the rest as other", () => {
    expect(OPENCODE_RUNTIME.toolCategory("bash")).toBe("shell");
    expect(OPENCODE_RUNTIME.toolCategory("Bash")).toBe("other");
  });
});
